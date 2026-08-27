import { degToRad, dot } from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, Vert } from '../mesh/types';

/**
 * Removes an edge shared by exactly two faces, merging them into one n-gon.
 * Returns the merged face, or null when the merge would produce a face that
 * visits a vertex twice.
 */
function dissolveEdge(mesh: BMesh, edge: Edge): Face | null {
  if (!mesh.edges.has(edge.id) || edge.loops.length !== 2) return null;

  const [loopA, loopB] = edge.loops;
  const faceA = loopA.face;
  const faceB = loopB.face;
  if (faceA === faceB) return null;

  const ringA = rotateToVert(mesh.faceVerts(faceA), loopA.next.vert);
  const ringB = rotateToVert(mesh.faceVerts(faceB), loopA.vert);
  const merged = [...ringA, ...ringB.slice(1, -1)];

  if (new Set(merged.map((vert) => vert.id)).size !== merged.length) return null;
  if (merged.length < 3) return null;

  const { materialIndex, smooth } = faceA;
  mesh.removeFace(faceA);
  mesh.removeFace(faceB);
  mesh.removeEdge(edge);

  const face = mesh.addFace(merged, { materialIndex, smooth });
  face.selected = true;
  return face;
}

/**
 * How far two faces may fold and still be worth merging.
 *
 * Dissolving is a topology edit, not a geometry one: the merged n-gon keeps
 * every vertex where it was, so merging two faces that meet at a sharp angle
 * produces a *folded* face. Nothing downstream can represent that — it gets one
 * averaged normal that matches neither half, ear-clipping projects it onto a
 * plane it does not lie near, and OBJ/FBX record it as a single flat polygon.
 * Gentle curvature (a cylinder's 15° side seams) is fine and useful to merge;
 * a cube's 90° corner is not.
 */
export const DISSOLVE_ANGLE_LIMIT_DEGREES = 40;

/** Whether the two faces across `edge` are close enough to coplanar to merge. */
export function isDissolvableEdge(
  mesh: BMesh,
  edge: Edge,
  limitDegrees = DISSOLVE_ANGLE_LIMIT_DEGREES,
): boolean {
  const faces = mesh.edgeFaces(edge);
  if (faces.length !== 2) return false;
  return dot(faces[0].normal, faces[1].normal) >= Math.cos(degToRad(limitDegrees));
}

/**
 * Whether the fan around `vert` is flat enough to become a single face.
 *
 * Dissolving a vertex merges every face touching it, so the same fold that
 * makes a sharp edge unmergeable applies here — and more easily, since a corner
 * gathers three or more faces at once. A cube corner's three mutually
 * perpendicular faces would collapse into one badly folded n-gon; the interior
 * vertex of a flat grid, the case this operation is actually for, stays fine.
 */
export function isDissolvableVert(
  mesh: BMesh,
  vert: Vert,
  limitDegrees = DISSOLVE_ANGLE_LIMIT_DEGREES,
): boolean {
  // A vertex with two edges or fewer sits along a path rather than at a corner:
  // removing it merges nothing, it just drops out of the rings of the faces
  // using it, which keep their own shape. That is true however sharply those
  // faces meet — the midpoint of a cube's edge is the everyday case — so there
  // is no fold to guard against.
  if (vert.edges.length <= 2) return true;

  const faces = mesh.vertFaces(vert);
  if (faces.length < 2) return true;

  const limit = Math.cos(degToRad(limitDegrees));
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      if (dot(faces[i].normal, faces[j].normal) < limit) return false;
    }
  }
  return true;
}

export function dissolveEdges(mesh: BMesh, edges: readonly Edge[]): Face[] {
  const merged: Face[] = [];
  for (const edge of edges) {
    const face = dissolveEdge(mesh, edge);
    if (face) merged.push(face);
  }
  mesh.computeNormals();
  return merged;
}

/**
 * Merges each connected face region into a single n-gon.
 *
 * This rebuilds the region's outline directly rather than dissolving interior
 * edges one at a time: the last interior edge of a fan always ends up with both
 * loops on the same face, which no pairwise merge can resolve.
 */
export function dissolveFaces(mesh: BMesh, faces: readonly Face[]): Face[] {
  const created: Face[] = [];

  for (const region of connectedRegions(mesh, faces)) {
    const regionIds = new Set(region.map((face) => face.id));

    // Boundary loops always belong to a region face, so chaining them by
    // winding order gives a correctly oriented ring for free.
    const boundary = new Map<number, ReturnType<BMesh['faceLoops']>[number]>();
    const interiorEdges = new Set<Edge>();
    for (const face of region) {
      for (const loop of mesh.faceLoops(face)) {
        const inside = mesh.edgeFaces(loop.edge).filter((f) => regionIds.has(f.id)).length;
        if (inside === 1) boundary.set(loop.vert.id, loop);
        else if (inside === 2) interiorEdges.add(loop.edge);
      }
    }
    if (boundary.size < 3) continue;

    const first = boundary.values().next().value;
    if (!first) continue;

    const ring: Vert[] = [];
    let current = first;
    for (let guard = 0; guard <= boundary.size; guard++) {
      ring.push(current.vert);
      const next = boundary.get(current.next.vert.id);
      if (!next || next === first) break;
      current = next;
    }
    if (ring.length !== boundary.size) continue;

    const { materialIndex, smooth } = region[0];
    for (const face of region) mesh.removeFace(face);

    // Only the edges *inside* the region go: its boundary edges are the new
    // face's ring. Pruning every now-loop-less edge would take those too
    // whenever no face outside the region shares them — on an open mesh that
    // deleted the ring's own vertices and left the rebuilt face dangling.
    for (const edge of interiorEdges) {
      if (mesh.edges.has(edge.id) && edge.loops.length === 0) mesh.removeEdge(edge);
    }

    const face = mesh.addFace(ring, { materialIndex, smooth });
    face.selected = true;
    created.push(face);

    // After the face exists, so the ring's vertices are never briefly orphaned.
    mesh.removeLooseVerts();
  }

  mesh.computeNormals();
  return created;
}

/** Groups faces into islands connected through shared edges. */
function connectedRegions(mesh: BMesh, faces: readonly Face[]): Face[][] {
  const pool = new Map(faces.filter((face) => mesh.faces.has(face.id)).map((f) => [f.id, f]));
  const regions: Face[][] = [];

  while (pool.size > 0) {
    const seed = pool.values().next().value as Face;
    pool.delete(seed.id);

    const region: Face[] = [];
    const queue: Face[] = [seed];

    while (queue.length > 0) {
      const current = queue.pop() as Face;
      region.push(current);
      for (const edge of mesh.faceEdges(current)) {
        for (const neighbour of mesh.edgeFaces(edge)) {
          if (!pool.has(neighbour.id)) continue;
          pool.delete(neighbour.id);
          queue.push(neighbour);
        }
      }
    }

    regions.push(region);
  }

  return regions;
}

/**
 * Removes vertices while keeping the surrounding surface. A valence-2 vertex
 * simply joins its two edges; higher valences merge the whole surrounding fan
 * into one face.
 */
export function dissolveVerts(mesh: BMesh, verts: readonly Vert[]): void {
  for (const vert of verts) {
    if (!mesh.verts.has(vert.id)) continue;

    const faces = mesh.vertFaces(vert);
    if (faces.length === 0) {
      mesh.removeVert(vert);
      continue;
    }

    // Two edges or fewer: the vertex lies along a path, so each face simply
    // drops it and keeps its own shape. Merging here would be wrong — for the
    // midpoint of a cube's edge it would fuse the two perpendicular faces.
    if (vert.edges.length <= 2) {
      for (const face of faces) {
        if (mesh.faces.has(face.id)) trimVertFromFace(mesh, face, vert);
      }
      if (mesh.verts.has(vert.id) && mesh.vertFaces(vert).length === 0) mesh.removeVert(vert);
      continue;
    }

    // At a corner, dropping the vertex would leave a hole, so the fan has to
    // become one face. Rebuilding its outline succeeds where dissolving the
    // vertex's edges one at a time stalls: the fan's last interior edge ends up
    // with both loops on the same face — the same reason dissolveFaces rebuilds
    // regions directly. An interior vertex is not on the outline, so this also
    // drops it from the ring for free.
    if (faces.length > 1) dissolveFaces(mesh, faces);

    // A vertex on an open boundary survives the merge, because its boundary
    // edges keep it on the outline. Trim it out of the one face left instead.
    if (mesh.verts.has(vert.id)) {
      const remaining = mesh.vertFaces(vert);
      if (remaining.length === 1) trimVertFromFace(mesh, remaining[0], vert);
    }

    if (mesh.verts.has(vert.id) && mesh.vertFaces(vert).length === 0) mesh.removeVert(vert);
  }

  mesh.removeWireEdges();
  mesh.removeLooseVerts();
  mesh.computeNormals();
}

/**
 * Rebuilds `face` without `vert`.
 *
 * Dropping the vertex can leave a spur edge's two sides adjacent in the ring,
 * so consecutive duplicates are collapsed as well.
 */
function trimVertFromFace(mesh: BMesh, face: Face, vert: Vert): void {
  const ring: Vert[] = [];
  for (const candidate of mesh.faceVerts(face)) {
    if (candidate === vert) continue;
    if (ring.length > 0 && ring[ring.length - 1] === candidate) continue;
    ring.push(candidate);
  }
  while (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
  if (ring.length < 3) return;

  const { materialIndex, smooth } = face;
  mesh.removeFace(face);
  mesh.addFace(ring, { materialIndex, smooth }).selected = true;
}

/**
 * Dissolves edges whose two faces are nearly coplanar, flattening dense
 * triangulation back into larger n-gons.
 */
export function limitedDissolve(mesh: BMesh, angleLimitDegrees = 5): Face[] {
  const limit = Math.cos(degToRad(angleLimitDegrees));
  const candidates: Edge[] = [];

  for (const edge of mesh.edges.values()) {
    const faces = mesh.edgeFaces(edge);
    if (faces.length !== 2) continue;
    if (dot(faces[0].normal, faces[1].normal) >= limit) candidates.push(edge);
  }

  return dissolveEdges(mesh, candidates);
}

function rotateToVert(ring: readonly Vert[], start: Vert): Vert[] {
  const index = ring.indexOf(start);
  if (index <= 0) return [...ring];
  return [...ring.slice(index), ...ring.slice(0, index)];
}
