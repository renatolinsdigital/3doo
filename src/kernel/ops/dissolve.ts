import { degToRad, dot, lengthSq, sub } from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, Loop, Vert } from '../mesh/types';

import { dedupeRing } from './region';

/**
 * Removes an edge shared by exactly two faces, merging them into one n-gon.
 *
 * Every other edge the two faces share goes with it. Dissolving a row merges
 * its faces one edge at a time, so a face can come to share a run of edges
 * with the next one (both sides of a junction, a fan's last two spokes), and
 * merging across one of them alone would visit a vertex twice.
 *
 * Returns the merged face and the edges removed, or null when the shared edges
 * are not one run, which would leave a hole the face cannot represent.
 */
function dissolveEdge(mesh: BMesh, edge: Edge): { face: Face; removed: Edge[] } | null {
  if (!mesh.edges.has(edge.id) || edge.loops.length !== 2) return null;

  const [faceA, faceB] = edge.loops.map((loop) => loop.face);
  if (faceA === faceB) return null;

  const shared: Edge[] = [];
  const outline = new Map<number, Loop>();
  for (const loop of [...mesh.faceLoops(faceA), ...mesh.faceLoops(faceB)]) {
    const faces = loop.edge.loops.map((other) => other.face);
    if (faces.length === 2 && faces.includes(faceA) && faces.includes(faceB)) {
      if (loop.face === faceA) shared.push(loop.edge);
    } else if (outline.has(loop.vert.id)) {
      return null;
    } else {
      outline.set(loop.vert.id, loop);
    }
  }

  const first = outline.values().next().value;
  if (!first) return null;
  const ring: Vert[] = [];
  let loop = first;
  do {
    ring.push(loop.vert);
    const next = outline.get(loop.next.vert.id);
    if (!next || ring.length > outline.size) return null;
    loop = next;
  } while (loop !== first);
  if (ring.length !== outline.size || ring.length < 3) return null;

  const { materialIndex, smooth } = faceA;
  mesh.removeFace(faceA);
  mesh.removeFace(faceB);
  for (const removed of shared) mesh.removeEdge(removed);
  mesh.removeLooseEnds(shared);

  const face = mesh.addFace(ring, { materialIndex, smooth });
  face.selected = true;
  return { face, removed: shared };
}

/**
 * How far two faces may fold and still be worth merging.
 *
 * Dissolving is a topology edit, not a geometry one: the merged n-gon keeps
 * every vertex where it was, so merging two faces that meet at a sharp angle
 * produces a *folded* face. Nothing downstream can represent that: it gets one
 * averaged normal that matches neither half, ear-clipping projects it onto a
 * plane it does not lie near, and OBJ/FBX record it as a single flat polygon.
 * Gentle curvature (a cylinder's 15° side seams) is fine and useful to merge;
 * a cube's 90° corner is not.
 *
 * The dissolve operator holds vertices to it. A selected edge names the two
 * faces to merge, so edges are held to it only when a script asks.
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
 * makes a sharp edge unmergeable applies here, and more easily, since a corner
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
  // faces meet (the midpoint of a cube's edge is the everyday case), so there
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

/**
 * Whether `dissolveFaces` has anything to merge: a connected region of two or
 * more faces with an outline left around it. A region that closes off a solid
 * (every face of a cube) has no boundary ring to rebuild as the merged face.
 */
export function hasDissolvableRegion(mesh: BMesh, faces: readonly Face[]): boolean {
  return connectedRegions(mesh, faces).some((region) => {
    if (region.length < 2) return false;
    const ids = new Set(region.map((face) => face.id));
    return region.some((face) =>
      mesh
        .faceEdges(face)
        .some((edge) => mesh.edgeFaces(edge).filter((other) => ids.has(other.id)).length === 1),
    );
  });
}

export function dissolveEdges(mesh: BMesh, edges: readonly Edge[]): Face[] {
  const merged: Face[] = [];
  const ends = new Set<Vert>();
  for (const edge of edges) {
    const result = dissolveEdge(mesh, edge);
    if (!result) continue;
    merged.push(result.face);
    for (const removed of result.removed) {
      ends.add(removed.v0);
      ends.add(removed.v1);
    }
  }

  // The ends outlive the edge as points part-way along the lines it crossed.
  // On a straight side they shape nothing, but extrude walls each side of them
  // separately, drawing the edge back in on the walls; on a curve they stay as
  // kinks splitting the merged faces' sides.
  for (const vert of ends) {
    for (const [old, rebuilt] of dropEnd(mesh, vert)) {
      const at = merged.indexOf(old);
      if (at >= 0) merged[at] = rebuilt;
    }
  }

  mesh.computeNormals();
  return merged.filter((face) => mesh.faces.has(face.id));
}

/**
 * How far from opposite a vertex's two edges may point and still read as one
 * straight edge, as `1 + cos` of the angle between them. The same limit the
 * boolean cleanup uses.
 */
const STRAIGHT_EPSILON = 5e-6;

/**
 * Removes a dissolved edge's end once only two edges are left at it, joining
 * them into one.
 *
 * Between two faces the end only marks where the edge crossed, so it goes even
 * where the line bends, as dissolving the vertex itself would. On an open
 * boundary it is a corner of the outline, so it goes only where the outline
 * runs straight through it.
 *
 * The faces using it are rebuilt without it but otherwise as they were, since
 * the one across the edge is not part of what the user selected. Returns each
 * rebuilt face keyed by the face it replaced.
 */
function dropEnd(mesh: BMesh, vert: Vert): Map<Face, Face> {
  const rebuilt = new Map<Face, Face>();
  if (!mesh.verts.has(vert.id) || vert.edges.length !== 2) return rebuilt;

  const [a, b] = vert.edges.map((edge) => mesh.edgeOther(edge, vert));

  // A triangle would be left with two corners, and an existing edge between
  // the neighbours would end up carrying a third face.
  const faces = mesh.vertFaces(vert);
  if (faces.length === 0 || mesh.findEdge(a, b)) return rebuilt;
  if (faces.some((face) => mesh.faceLoopCount(face) < 4)) return rebuilt;

  if (faces.length === 1) {
    const left = sub(a.co, vert.co);
    const right = sub(b.co, vert.co);
    const span = Math.sqrt(lengthSq(left) * lengthSq(right));
    if (span === 0 || dot(left, right) / span > -1 + STRAIGHT_EPSILON) return rebuilt;
  }

  const sharp = vert.edges.some((edge) => edge.sharp);

  for (const face of faces) {
    const loops = mesh.faceLoops(face).filter((loop) => loop.vert !== vert);
    const { materialIndex, smooth, selected } = face;
    mesh.removeFace(face);

    const replacement = mesh.addFace(
      loops.map((loop) => loop.vert),
      { materialIndex, smooth },
    );
    replacement.selected = selected;
    mesh.faceLoops(replacement).forEach((loop, i) => (loop.uv = { ...loops[i].uv }));
    rebuilt.set(face, replacement);
  }

  mesh.removeVert(vert);
  const joined = mesh.findEdge(a, b);
  if (joined && sharp) joined.sharp = true;
  return rebuilt;
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
    const boundary = new Map<number, Loop>();
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
    // whenever no face outside the region shares them: on an open mesh that
    // deleted the ring's own vertices and left the rebuilt face dangling.
    for (const edge of interiorEdges) {
      if (mesh.edges.has(edge.id) && edge.loops.length === 0) mesh.removeEdge(edge);
    }

    const face = mesh.addFace(ring, { materialIndex, smooth });
    face.selected = true;
    created.push(face);

    mesh.removeLooseEnds(interiorEdges);
  }

  mesh.computeNormals();
  return created;
}

/** Groups faces into islands connected through shared edges. */
export function connectedRegions(mesh: BMesh, faces: readonly Face[]): Face[][] {
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
  // A dissolve strands nothing but the far ends of the vertices' own edges.
  // Sweeping the whole mesh instead deleted every faceless edge and lone point
  // the user had left anywhere else.
  const removed = new Set<Edge>();

  for (const vert of verts) {
    if (!mesh.verts.has(vert.id)) continue;
    for (const edge of vert.edges) removed.add(edge);

    const faces = mesh.vertFaces(vert);
    if (faces.length === 0) {
      mesh.removeVert(vert);
      continue;
    }

    // Two edges or fewer: the vertex lies along a path, so each face simply
    // drops it and keeps its own shape. Merging here would be wrong: for the
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
    // with both loops on the same face, the same reason dissolveFaces rebuilds
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

  mesh.removeLooseEnds(removed);
  mesh.computeNormals();
}

/**
 * Rebuilds `face` without `vert`.
 *
 * Dropping the vertex can leave a spur edge's two sides adjacent in the ring,
 * so consecutive duplicates are collapsed as well.
 */
function trimVertFromFace(mesh: BMesh, face: Face, vert: Vert): void {
  const ring = dedupeRing(mesh.faceVerts(face).filter((candidate) => candidate !== vert));
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
