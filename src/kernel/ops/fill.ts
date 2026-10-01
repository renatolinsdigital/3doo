import { distanceSq } from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, Vert } from '../mesh/types';

/**
 * Chains boundary edges into ordered vertex rings.
 *
 * Both fill and bridge need "which loops does this selection form", so the walk
 * lives here once.
 */
function edgeLoopsFrom(mesh: BMesh, edges: readonly Edge[]): Vert[][] {
  const pool = new Set(edges.filter((edge) => mesh.edges.has(edge.id)));
  const loops: Vert[][] = [];

  const neighbours = new Map<number, Edge[]>();
  for (const edge of pool) {
    for (const vert of [edge.v0, edge.v1]) {
      const list = neighbours.get(vert.id);
      if (list) list.push(edge);
      else neighbours.set(vert.id, [edge]);
    }
  }

  while (pool.size > 0) {
    const seed: Edge = pool.values().next().value as Edge;
    pool.delete(seed);

    const ring: Vert[] = [seed.v0, seed.v1];
    let head = seed.v1;

    for (;;) {
      const next = (neighbours.get(head.id) ?? []).find((edge) => pool.has(edge));
      if (!next) break;
      pool.delete(next);
      head = mesh.edgeOther(next, head);
      if (head === ring[0]) break;
      ring.push(head);
    }

    if (ring.length >= 2) loops.push(ring);
  }

  return loops;
}

/** Fills a closed boundary loop with a single n-gon. */
export function fillHole(mesh: BMesh, edges: readonly Edge[]): Face[] {
  const created: Face[] = [];

  for (const ring of edgeLoopsFrom(mesh, edges)) {
    if (ring.length < 3) continue;
    if (mesh.findFace(ring)) continue;

    const face = mesh.addFace(orientAgainstNeighbours(mesh, ring));
    face.selected = true;
    created.push(face);
  }

  mesh.computeNormals();
  return created;
}

/**
 * Bridges two edge loops with a band of quads.
 *
 * The second loop is rotated so its start is nearest the first loop's start,
 * and reversed if that produces less twisting: without it, bridging two rings
 * built in opposite directions folds the band over itself.
 */
export function bridgeEdgeLoops(mesh: BMesh, edges: readonly Edge[]): Face[] {
  const loops = edgeLoopsFrom(mesh, edges);
  if (loops.length !== 2) return [];

  const [first, second] = loops;
  if (first.length !== second.length || first.length < 2) return [];

  const aligned = alignRing(first, second);
  const created: Face[] = [];

  for (let i = 0; i < first.length; i++) {
    const next = (i + 1) % first.length;
    const ring = [first[i], first[next], aligned[next], aligned[i]];
    if (new Set(ring.map((vert) => vert.id)).size < 3) continue;
    const face = mesh.addFace(ring);
    face.selected = true;
    created.push(face);
  }

  mesh.computeNormals();
  return created;
}

function alignRing(reference: readonly Vert[], candidate: readonly Vert[]): Vert[] {
  const rotations: Vert[][] = [];
  for (const source of [candidate, [...candidate].reverse()]) {
    for (let offset = 0; offset < source.length; offset++) {
      rotations.push([...source.slice(offset), ...source.slice(0, offset)]);
    }
  }

  let best = rotations[0];
  let bestCost = Infinity;
  for (const rotation of rotations) {
    let cost = 0;
    for (let i = 0; i < reference.length; i++) cost += distanceSq(reference[i].co, rotation[i].co);
    if (cost < bestCost) {
      bestCost = cost;
      best = rotation;
    }
  }
  return best;
}

/**
 * Winds a new face against the boundary it fills, so its normal agrees with the
 * surrounding surface rather than pointing into it.
 */
function orientAgainstNeighbours(mesh: BMesh, ring: readonly Vert[]): Vert[] {
  for (let i = 0; i < ring.length; i++) {
    const from = ring[i];
    const to = ring[(i + 1) % ring.length];
    const edge = mesh.findEdge(from, to);
    const loop = edge?.loops[0];
    if (!loop) continue;
    // A manifold neighbour traverses the shared edge the other way round.
    return loop.vert === from ? [...ring].reverse() : [...ring];
  }
  return [...ring];
}
