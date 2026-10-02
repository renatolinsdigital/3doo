import { EPSILON, addScaled, clamp, distanceSq, dot, lengthSq, sub } from '../math';
import type { Vec3 } from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, SelectMode, Vert } from '../mesh/types';

import { collectEdgeRing } from './loopcut';

/**
 * Edge loop selection.
 *
 * At a valence-4 vertex the loop continues along the one edge that shares no
 * face with the current edge. Any other valence ends the loop, which is what
 * makes Alt+click stop at poles.
 *
 * Two kinds of loop end a mesh rather than cross it, and their vertices are
 * valence 3, so they get walks of their own (the same two Blender's walker
 * special-cases). An open border runs from boundary edge to boundary edge. The
 * rim of an n-gon cap runs around the n-gon, its "hub".
 */
export function selectEdgeLoop(mesh: BMesh, start: Edge): Edge[] {
  const loop: Edge[] = [start];
  const seen = new Set<number>([start.id]);
  const boundary = mesh.isBoundaryEdge(start);
  const hub = boundary ? null : loopHub(mesh, start);

  for (const direction of [start.v0, start.v1]) {
    let edge = start;
    let vert = direction;

    for (;;) {
      const next = boundary
        ? nextBoundaryEdge(mesh, edge, vert)
        : hub
          ? nextHubEdge(mesh, hub, edge, vert)
          : nextQuadEdge(mesh, edge, vert);
      if (!next || seen.has(next.id)) break;

      seen.add(next.id);
      loop.push(next);
      vert = mesh.edgeOther(next, vert);
      edge = next;
    }
  }

  return loop;
}

function nextQuadEdge(mesh: BMesh, edge: Edge, vert: Vert): Edge | null {
  if (vert.edges.length !== 4) return null;
  const currentFaces = new Set(mesh.edgeFaces(edge).map((face) => face.id));
  const candidates = vert.edges.filter((candidate) => {
    if (candidate === edge) return false;
    return !mesh.edgeFaces(candidate).some((face) => currentFaces.has(face.id));
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function nextBoundaryEdge(mesh: BMesh, edge: Edge, vert: Vert): Edge | null {
  const candidates = vert.edges.filter(
    (candidate) => candidate !== edge && mesh.isBoundaryEdge(candidate),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * The n-gon a start edge rims, when one of its ends is valence 3. Quads are
 * left out: a valence-3 vertex beside a quad is a pole, where the ordinary
 * loop has to stop rather than turn the corner of the quad.
 */
function loopHub(mesh: BMesh, start: Edge): Face | null {
  if (start.v0.edges.length !== 3 && start.v1.edges.length !== 3) return null;
  let best: Face | null = null;
  let bestCount = 4;
  for (const face of mesh.edgeFaces(start)) {
    const count = mesh.faceLoopCount(face);
    if (count > bestCount) {
      best = face;
      bestCount = count;
    }
  }
  return best;
}

function nextHubEdge(mesh: BMesh, hub: Face, edge: Edge, vert: Vert): Edge | null {
  if (vert.edges.length !== 3) return null;
  const corner = mesh.loopOfVertInFace(hub, vert);
  if (!corner) return null;
  return corner.edge === edge ? corner.prev.edge : corner.edge;
}

/** Edge ring selection: the edges a loop cut would run across. */
export function selectEdgeRing(mesh: BMesh, start: Edge): Edge[] {
  const steps = collectEdgeRing(mesh, start);
  const ring = new Map<number, Edge>([[start.id, start]]);

  for (const step of steps) {
    ring.set(step.entry.edge.id, step.entry.edge);
    const exit = step.entry.next.next.edge;
    ring.set(exit.id, exit);
  }

  return [...ring.values()];
}

/**
 * Whether any two of these edges meet at a vertex.
 *
 * What the edge-loop button asks before it offers itself, the way
 * `hasAdjacentFaces` answers for the face-loop one. One click's worth of edge
 * already names a loop (the walk runs both ways out of it), so this is not
 * what the walk needs, but what says the user drew a stroke along a loop rather
 * than tapping a single edge they may only have wanted the one of.
 */
export function hasConnectedEdges(edges: readonly Edge[]): boolean {
  const ends = new Set<number>();

  for (const edge of edges) {
    if (ends.has(edge.v0.id) || ends.has(edge.v1.id)) return true;
    ends.add(edge.v0.id);
    ends.add(edge.v1.id);
  }

  return false;
}

/**
 * The edge loops a selection of edges names.
 *
 * Every selected edge brings the loop running through it, so a stroke of edges
 * picked along one loop all name that same loop and it comes back whole, while
 * edges lying on different loops each bring their own. The result does not
 * depend on the order they were picked in, which nothing about an edge records.
 */
export function selectEdgeLoops(mesh: BMesh, edges: readonly Edge[]): Edge[] {
  const loop = new Map<number, Edge>();

  for (const edge of edges) {
    // Already walked: an edge on a loop already collected walks back the same
    // one, since the walk reads only the mesh either side of where it starts.
    if (loop.has(edge.id)) continue;
    for (const member of selectEdgeLoop(mesh, edge)) loop.set(member.id, member);
  }

  return [...loop.values()];
}

/**
 * Whether any two of these faces share an edge.
 *
 * What `selectFaceLoop` needs before it can name a loop at all, and cheap
 * enough for the UI to ask on every selection change: no ring is walked, only
 * the four edges of each selected face.
 */
export function hasAdjacentFaces(mesh: BMesh, faces: readonly Face[]): boolean {
  const selected = new Set(faces.map((face) => face.id));

  for (const face of faces) {
    for (const edge of mesh.faceEdges(face)) {
      if (mesh.edgeFaces(edge).some((other) => other !== face && selected.has(other.id))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * The face loop running through a pair of adjacent selected faces.
 *
 * Two adjacent faces are what name a loop. The edge they share is the one a
 * loop cut would run across, so the ring of quads through it (the same walk
 * `loopCut` uses) is the loop the user pointed at. One face alone names
 * nothing: four loops run through it and there is no way to tell which.
 *
 * Every adjacent pair in the selection contributes its loop, so three faces in
 * a row give the one loop they share while an L of three gives both. That keeps
 * the result the same whatever order the faces were picked in, which matters
 * because faces carry no click-order stamp to break the tie with.
 */
export function selectFaceLoop(mesh: BMesh, faces: readonly Face[]): Face[] {
  const selected = new Set(faces.map((face) => face.id));
  const walked = new Set<number>();
  const loop = new Map<number, Face>();

  for (const face of faces) {
    for (const edge of mesh.faceEdges(face)) {
      if (walked.has(edge.id)) continue;
      const shared = mesh.edgeFaces(edge).some((other) => other !== face && selected.has(other.id));
      if (!shared) continue;

      walked.add(edge.id);
      // Empty at a triangle or an n-gon, which have no loop to run along.
      for (const step of collectEdgeRing(mesh, edge)) loop.set(step.face.id, step.face);
    }
  }

  return [...loop.values()];
}

/**
 * The face loop a single click names.
 *
 * A face on its own names nothing (two loops run through it), so the edge
 * nearest where the click landed picks one: the ring across that edge is the
 * strip the cursor was pointing along, which is how Alt+click reads in Blender.
 *
 * Nothing but the click decides it. Letting an already-selected neighbour name
 * the loop instead reads well on the first click and then rots: every loop laid
 * down leaves the next face with a selected neighbour of its own, so the rule
 * fires where it was not wanted, and once a face is hemmed in on two sides it
 * keeps re-naming a loop that is already selected: the click stops doing
 * anything at all. Reading only the cursor cannot drift that way.
 *
 * Empty at a triangle or an n-gon: no ring runs through those.
 */
export function faceLoopAtClick(mesh: BMesh, face: Face, point?: Vec3): Face[] {
  const seed = nearestEdge(mesh.faceEdges(face), point);
  if (!seed) return [];

  return collectEdgeRing(mesh, seed).map((step) => step.face);
}

/** The candidate closest to the click, or the first one when there is no point to measure from. */
function nearestEdge(candidates: readonly Edge[], point?: Vec3): Edge | undefined {
  if (!point || candidates.length < 2) return candidates[0];

  let best = candidates[0];
  let bestDistance = Infinity;
  for (const edge of candidates) {
    const distance = distanceToEdgeSq(edge, point);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = edge;
    }
  }
  return best;
}

function distanceToEdgeSq(edge: Edge, point: Vec3): number {
  const span = sub(edge.v1.co, edge.v0.co);
  const spanLengthSq = lengthSq(span);
  if (spanLengthSq < EPSILON) return distanceSq(point, edge.v0.co);

  const t = clamp(dot(sub(point, edge.v0.co), span) / spanLengthSq, 0, 1);
  return distanceSq(point, addScaled(edge.v0.co, span, t));
}

/** Flood-fills the selection across connected geometry. */
export function selectLinked(mesh: BMesh, seeds: readonly Vert[]): Vert[] {
  const visited = new Set<number>();
  const queue = [...seeds];
  const result: Vert[] = [];

  while (queue.length > 0) {
    const vert = queue.pop() as Vert;
    if (visited.has(vert.id)) continue;
    visited.add(vert.id);
    result.push(vert);

    for (const edge of vert.edges) {
      const other = mesh.edgeOther(edge, vert);
      if (!visited.has(other.id)) queue.push(other);
    }
  }

  return result;
}

/** Adds every vertex adjacent to the current selection. */
export function growSelection(mesh: BMesh): void {
  const additions: Vert[] = [];
  for (const vert of mesh.verts.values()) {
    if (!vert.selected) continue;
    for (const edge of vert.edges) additions.push(mesh.edgeOther(edge, vert));
  }
  for (const vert of additions) vert.selected = true;
  mesh.flushSelection('vertex');
}

/** Removes vertices on the selection border. */
export function shrinkSelection(mesh: BMesh): void {
  const removals: Vert[] = [];
  for (const vert of mesh.verts.values()) {
    if (!vert.selected) continue;
    const onBorder = vert.edges.some((edge) => !mesh.edgeOther(edge, vert).selected);
    if (onBorder) removals.push(vert);
  }
  for (const vert of removals) vert.selected = false;
  mesh.flushSelection('vertex');
}

export function invertSelection(mesh: BMesh, mode: SelectMode): void {
  if (mode === 'vertex') {
    for (const vert of mesh.verts.values()) vert.selected = !vert.selected;
  } else if (mode === 'edge') {
    for (const edge of mesh.edges.values()) edge.selected = !edge.selected;
  } else {
    for (const face of mesh.faces.values()) face.selected = !face.selected;
  }
  mesh.flushSelection(mode);
}
