import { clamp, lerp } from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, Loop, Vert } from '../mesh/types';

export interface LoopCutOptions {
  cuts?: number;
  /** -1..1 slide across the ring; 0 keeps the cuts evenly spaced. */
  slide?: number;
}

export interface LoopCutResult {
  edges: Edge[];
  verts: Vert[];
}

interface RingStep {
  face: Face;
  /** Loop of the edge the ring enters this quad through. */
  entry: Loop;
}

/**
 * Walks the ring of quads that `start` passes through.
 *
 * The walk stops at n-gons, triangles and mesh boundaries, which is exactly
 * where a loop cut has to stop too.
 */
export function collectEdgeRing(mesh: BMesh, start: Edge): RingStep[] {
  const isQuad = (face: Face) => mesh.faceLoops(face).length === 4;

  const forward: RingStep[] = [];
  const visited = new Set<number>();

  const walk = (from: Loop | undefined, steps: RingStep[]): boolean => {
    let current = from;
    while (current) {
      const face = current.face;
      if (!isQuad(face) || visited.has(face.id)) return false;
      visited.add(face.id);
      steps.push({ face, entry: current });

      const exit = current.next.next;
      if (exit.edge === start) return true;
      const next = exit.edge.loops.find((loop) => loop.face !== face);
      if (!next) return false;
      current = next;
    }
    return false;
  };

  const closed = walk(start.loops[0], forward);
  if (closed) return forward;

  const backward: RingStep[] = [];
  walk(start.loops[1], backward);
  return [...backward.reverse(), ...forward];
}

/**
 * Whether a loop cut across this edge has anywhere to run.
 *
 * The ring walk steps through quads only, so an edge with a triangle or an
 * n-gon on both sides cuts nothing at all, which is every edge of a cone,
 * whose sides are a fan of triangles and whose base is one n-gon. Reads the
 * same two radial loops `collectEdgeRing` starts from, so it answers exactly
 * what that walk would, without walking it.
 */
export function canLoopCut(mesh: BMesh, edge: Edge): boolean {
  return edge.loops.slice(0, 2).some((loop) => mesh.faceLoops(loop.face).length === 4);
}

/**
 * Inserts one or more edge loops across a ring of quads.
 *
 * Each ring edge is split at the same parameters, and every quad in the ring is
 * replaced by a strip of quads, so the result stays all-quad.
 */
export function loopCut(mesh: BMesh, start: Edge, options: LoopCutOptions = {}): LoopCutResult {
  const cuts = Math.max(1, Math.floor(options.cuts ?? 1));
  const slide = clamp(options.slide ?? 0, -0.95, 0.95);
  const steps = collectEdgeRing(mesh, start);
  if (steps.length === 0) return { edges: [], verts: [] };

  const parameters: number[] = [];
  for (let i = 1; i <= cuts; i++) {
    const even = i / (cuts + 1);
    parameters.push(clamp(even + slide * (slide > 0 ? 1 - even : even), 0.01, 0.99));
  }

  // One vertex list per ring edge, stored in the direction it was first cut.
  const cutVerts = new Map<number, { from: Vert; verts: Vert[] }>();
  const createdVerts: Vert[] = [];

  const pointsAlong = (edge: Edge, from: Vert): Vert[] => {
    const existing = cutVerts.get(edge.id);
    if (existing) return existing.from === from ? existing.verts : [...existing.verts].reverse();

    const other = mesh.edgeOther(edge, from);
    const verts = parameters.map((t) => mesh.addVert(lerp(from.co, other.co, t)));
    createdVerts.push(...verts);
    cutVerts.set(edge.id, { from, verts });
    return verts;
  };

  const rebuilt: { ring: Vert[]; materialIndex: number; smooth: boolean }[] = [];
  const crossPairs: [Vert, Vert][] = [];
  const consumedEdges = new Set<Edge>();

  for (const step of steps) {
    const entry = step.entry;
    const exit = entry.next.next;

    // Quad corners in winding order: a -> b -> c -> d.
    const a = entry.vert;
    const b = entry.next.vert;
    const c = exit.vert;
    const d = exit.next.vert;

    const side = [a, ...pointsAlong(entry.edge, a), b];
    const opposite = [d, ...pointsAlong(exit.edge, d), c];
    consumedEdges.add(entry.edge);
    consumedEdges.add(exit.edge);

    for (let i = 1; i < side.length - 1; i++) crossPairs.push([side[i], opposite[i]]);

    for (let i = 0; i < side.length - 1; i++) {
      rebuilt.push({
        ring: [side[i], side[i + 1], opposite[i + 1], opposite[i]],
        materialIndex: step.face.materialIndex,
        smooth: step.face.smooth,
      });
    }
  }

  for (const step of steps) mesh.removeFace(step.face);
  for (const spec of rebuilt) {
    mesh.addFace(spec.ring, { materialIndex: spec.materialIndex, smooth: spec.smooth });
  }

  // The original ring edges were replaced by their split segments.
  for (const edge of consumedEdges) {
    if (mesh.edges.has(edge.id) && edge.loops.length === 0) mesh.removeEdge(edge);
  }

  for (const vert of createdVerts) vert.selected = true;

  const newEdges: Edge[] = [];
  for (const [from, to] of crossPairs) {
    const edge = mesh.findEdge(from, to);
    if (!edge || newEdges.includes(edge)) continue;
    edge.selected = true;
    newEdges.push(edge);
  }

  mesh.computeNormals();
  return { edges: newEdges, verts: createdVerts };
}
