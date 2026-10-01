import { cross, dot } from '../math';
import type { BMesh } from '../mesh';
import { triangulatePolygon } from '../mesh';
import type { Edge, Face, Vert } from '../mesh/types';

/**
 * Rewrites a face's winding in place by rebuilding it, preserving the flags a
 * caller cares about. Returns the replacement, since the old reference dies.
 */
function flipFace(mesh: BMesh, face: Face): Face {
  const ring = [...mesh.faceVerts(face)].reverse();
  const { materialIndex, smooth, selected } = face;
  mesh.removeFace(face);
  const flipped = mesh.addFace(ring, { materialIndex, smooth });
  flipped.selected = selected;
  return flipped;
}

export function flipNormals(mesh: BMesh, faces: readonly Face[]): Face[] {
  const flipped = faces
    .filter((face) => mesh.faces.has(face.id))
    .map((face) => flipFace(mesh, face));
  mesh.computeNormals();
  return flipped;
}

/**
 * Makes winding consistent across each connected shell, then flips any shell
 * whose signed volume says it is inside out.
 *
 * The two-stage approach matters: consistency alone still allows a shell that
 * is uniformly inverted, which is exactly the case that ruins an export.
 */
export function recalculateNormals(mesh: BMesh, outside = true): void {
  const visited = new Set<number>();

  for (const seed of [...mesh.faces.values()]) {
    if (visited.has(seed.id)) continue;

    const shell: Face[] = [];
    const queue: Face[] = [seed];
    visited.add(seed.id);

    while (queue.length > 0) {
      const current = queue.pop() as Face;
      if (!mesh.faces.has(current.id)) continue;
      shell.push(current);

      for (const loop of mesh.faceLoops(current)) {
        for (const neighbour of mesh.edgeFaces(loop.edge)) {
          if (neighbour === current || visited.has(neighbour.id)) continue;
          visited.add(neighbour.id);

          const neighbourLoop = loop.edge.loops.find((candidate) => candidate.face === neighbour);
          // Two consistently wound faces traverse a shared edge in opposite
          // directions; matching directions mean the neighbour is inverted.
          const inverted = neighbourLoop !== undefined && neighbourLoop.vert === loop.vert;
          const resolved = inverted ? flipFace(mesh, neighbour) : neighbour;
          visited.add(resolved.id);
          queue.push(resolved);
        }
      }
    }

    const volume = signedVolume(mesh, shell);
    const wrongWayRound = outside ? volume < 0 : volume > 0;
    if (wrongWayRound && Math.abs(volume) > 1e-12) {
      for (const face of shell) {
        if (mesh.faces.has(face.id)) flipFace(mesh, face);
      }
    }
  }

  mesh.computeNormals();
}

/** Six times the signed volume of the shell, via the divergence theorem. */
function signedVolume(mesh: BMesh, faces: readonly Face[]): number {
  let total = 0;

  for (const face of faces) {
    if (!mesh.faces.has(face.id)) continue;
    const points = mesh.facePoints(face);
    const indices = triangulatePolygon(points, face.normal);
    for (let i = 0; i < indices.length; i += 3) {
      const a = points[indices[i]];
      const b = points[indices[i + 1]];
      const c = points[indices[i + 2]];
      total += dot(a, cross(b, c));
    }
  }

  return total;
}

export function setShading(faces: readonly Face[], smooth: boolean): void {
  for (const face of faces) face.smooth = smooth;
}

/**
 * Marks edges sharp, or clears the mark, and says how many changed.
 *
 * A sharp edge splits the shading of the smooth faces either side of it (see
 * `BMesh.cornerNormals`). It moves nothing, and a flat face is faceted along
 * every edge already, so on a flat-shaded mesh the mark shows in the overlay
 * and nowhere else.
 */
export function markSharp(edges: readonly Edge[], sharp: boolean): number {
  let changed = 0;
  for (const edge of edges) {
    if (edge.sharp === sharp) continue;
    edge.sharp = sharp;
    changed++;
  }
  return changed;
}

/**
 * Hands a cut edge's sharp mark on to the pieces it was cut into.
 *
 * `chain` is every vertex the edge now runs through, end to end. The pieces are
 * new edges, and a new edge starts out smooth, so a crease run through a
 * subdivision or a loop cut would otherwise come out of it gone.
 */
export function carrySharp(mesh: BMesh, edge: Edge, chain: readonly Vert[]): void {
  if (!edge.sharp) return;
  for (let i = 0; i < chain.length - 1; i++) {
    const piece = mesh.findEdge(chain[i], chain[i + 1]);
    if (piece) piece.sharp = true;
  }
}
