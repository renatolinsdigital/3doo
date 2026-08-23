import { cross, degToRad, dot } from '../math';
import type { BMesh } from '../mesh';
import { triangulatePolygon } from '../mesh';
import type { Face } from '../mesh/types';

/**
 * Rewrites a face's winding in place by rebuilding it, preserving the flags a
 * caller cares about. Returns the replacement, since the old reference dies.
 */
export function flipFace(mesh: BMesh, face: Face): Face {
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
 * Marks faces smooth and tags edges above the angle threshold as sharp, so the
 * display bridge can split normals along creases.
 */
export function autoSmoothByAngle(mesh: BMesh, angleDegrees = 30): void {
  const limit = Math.cos(degToRad(angleDegrees));

  for (const face of mesh.faces.values()) face.smooth = true;

  for (const edge of mesh.edges.values()) {
    const faces = mesh.edgeFaces(edge);
    edge.sharp = faces.length === 2 ? dot(faces[0].normal, faces[1].normal) < limit : true;
  }
}

/** Reports faces whose normal disagrees with the shell around them. */
export function findFlippedFaces(mesh: BMesh): Face[] {
  const flipped: Face[] = [];

  for (const face of mesh.faces.values()) {
    for (const loop of mesh.faceLoops(face)) {
      const neighbourLoop = loop.edge.loops.find((candidate) => candidate.face !== face);
      if (neighbourLoop && neighbourLoop.vert === loop.vert) {
        flipped.push(face);
        break;
      }
    }
  }

  return flipped;
}
