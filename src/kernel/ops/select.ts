import { dot } from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, SelectMode, Vert } from '../mesh/types';

import { collectEdgeRing } from './loopcut';

export type SimilarTrait = 'area' | 'normal' | 'material' | 'valence';

/**
 * Edge loop selection.
 *
 * At a valence-4 vertex the loop continues along the one edge that shares no
 * face with the current edge. Any other valence ends the loop, which is what
 * makes Alt+click stop at poles.
 */
export function selectEdgeLoop(mesh: BMesh, start: Edge): Edge[] {
  const loop: Edge[] = [start];
  const seen = new Set<number>([start.id]);

  for (const direction of [start.v0, start.v1]) {
    let edge = start;
    let vert = direction;

    for (;;) {
      const currentFaces = new Set(mesh.edgeFaces(edge).map((face) => face.id));
      const candidates = vert.edges.filter((candidate) => {
        if (candidate === edge) return false;
        return !mesh.edgeFaces(candidate).some((face) => currentFaces.has(face.id));
      });

      if (vert.edges.length !== 4 || candidates.length !== 1) break;
      const next = candidates[0];
      if (seen.has(next.id)) break;

      seen.add(next.id);
      loop.push(next);
      vert = mesh.edgeOther(next, vert);
      edge = next;
    }
  }

  return loop;
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
 * The face loop running through a pair of adjacent selected faces.
 *
 * Two adjacent faces are what name a loop. The edge they share is the one a
 * loop cut would run across, so the ring of quads through it — the same walk
 * `loopCut` uses — is the loop the user pointed at. One face alone names
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

/** Edges bordering exactly one face — the mesh's open boundary. */
export function findBoundaryEdges(mesh: BMesh): Edge[] {
  return [...mesh.edges.values()].filter((edge) => edge.loops.length === 1);
}

export function findNonManifoldEdges(mesh: BMesh): Edge[] {
  return [...mesh.edges.values()].filter(
    (edge) => edge.loops.length > 2 || edge.loops.length === 1,
  );
}

/** Vertices and edges that belong to no face. */
export function findLooseGeometry(mesh: BMesh): { verts: Vert[]; edges: Edge[] } {
  return {
    verts: [...mesh.verts.values()].filter((vert) => mesh.vertFaces(vert).length === 0),
    edges: [...mesh.edges.values()].filter((edge) => edge.loops.length === 0),
  };
}

/** Faces enclosed by the mesh, where every edge already has two other faces. */
export function findInteriorFaces(mesh: BMesh): Face[] {
  return [...mesh.faces.values()].filter((face) =>
    mesh.faceEdges(face).every((edge) => edge.loops.length > 2),
  );
}

export function selectSimilarFaces(
  mesh: BMesh,
  reference: Face,
  trait: SimilarTrait,
  tolerance = 0.05,
): Face[] {
  const matches: Face[] = [];

  for (const face of mesh.faces.values()) {
    let similar = false;
    switch (trait) {
      case 'area':
        similar = Math.abs(mesh.faceArea(face) - mesh.faceArea(reference)) <= tolerance;
        break;
      case 'normal':
        similar = dot(face.normal, reference.normal) >= 1 - tolerance;
        break;
      case 'material':
        similar = face.materialIndex === reference.materialIndex;
        break;
      case 'valence':
        similar = mesh.faceLoops(face).length === mesh.faceLoops(reference).length;
        break;
    }
    if (similar) matches.push(face);
  }

  return matches;
}
