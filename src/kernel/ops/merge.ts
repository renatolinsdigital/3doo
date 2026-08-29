import { type Vec3, centroid, clone, distanceSq } from '../math';
import type { BMesh } from '../mesh';
import type { Face, Vert } from '../mesh/types';

export type MergeMode = 'center' | 'cursor' | 'first' | 'last' | 'collapse';

export interface MergeByDistanceResult {
  /** How many vertices disappeared. */
  removed: number;
}

/**
 * Welds a vertex mapping into the mesh: every key vertex is replaced by its
 * target everywhere it appears, and faces that collapse below three distinct
 * corners are dropped.
 */
export function weldVerts(mesh: BMesh, mapping: ReadonlyMap<number, Vert>): number {
  if (mapping.size === 0) return 0;

  const resolve = (vert: Vert): Vert => mapping.get(vert.id) ?? vert;

  const rebuilt: { ring: Vert[]; materialIndex: number; smooth: boolean; selected: boolean }[] = [];
  const doomedFaces: Face[] = [];

  for (const face of mesh.faces.values()) {
    const ring = mesh.faceVerts(face);
    if (!ring.some((vert) => mapping.has(vert.id))) continue;

    const collapsed: Vert[] = [];
    for (const vert of ring.map(resolve)) {
      if (collapsed.length > 0 && collapsed[collapsed.length - 1] === vert) continue;
      collapsed.push(vert);
    }
    while (collapsed.length > 1 && collapsed[0] === collapsed[collapsed.length - 1])
      collapsed.pop();

    doomedFaces.push(face);
    if (new Set(collapsed.map((vert) => vert.id)).size < 3) continue;
    rebuilt.push({
      ring: collapsed,
      materialIndex: face.materialIndex,
      smooth: face.smooth,
      selected: face.selected,
    });
  }

  // Wire edges have no face to carry them, so re-create them explicitly.
  // Survivors and rewired copies alike are remembered in `keptWires`: the sweep
  // at the end exists to clear edges this weld stripped of faces, and would
  // otherwise delete standalone wire geometry the mesh legitimately holds.
  const keptWires = new Set<number>();
  const wirePairs: [Vert, Vert][] = [];
  for (const edge of mesh.edges.values()) {
    if (edge.loops.length > 0) continue;
    const a = resolve(edge.v0);
    const b = resolve(edge.v1);
    if (a === b) continue;
    if (a === edge.v0 && b === edge.v1) keptWires.add(edge.id);
    else wirePairs.push([a, b]);
  }

  // Same reasoning for isolated points: only the ones this weld orphans go.
  const keptLoose = new Set<number>();
  for (const vert of mesh.verts.values()) {
    if (vert.edges.length === 0 && !mapping.has(vert.id)) keptLoose.add(vert.id);
  }

  for (const face of doomedFaces) mesh.removeFace(face);
  for (const spec of rebuilt) {
    const face = mesh.addFace(spec.ring, {
      materialIndex: spec.materialIndex,
      smooth: spec.smooth,
    });
    face.selected = spec.selected;
  }
  for (const [a, b] of wirePairs) keptWires.add(mesh.addEdge(a, b).id);

  let removed = 0;
  for (const vertId of mapping.keys()) {
    const vert = mesh.verts.get(vertId);
    if (!vert || mapping.get(vertId) === vert) continue;
    mesh.removeVert(vert);
    removed++;
  }

  mesh.removeWireEdges(keptWires);
  mesh.removeLooseVerts(keptLoose);
  mesh.computeNormals();
  return removed;
}

/**
 * Builds the weld mapping for `mergeByDistance` without touching the mesh.
 *
 * Exposed separately so the UI can show a live "N vertices will be removed"
 * count before the user commits.
 */
function planMergeByDistance(verts: readonly Vert[], threshold: number): Map<number, Vert> {
  const mapping = new Map<number, Vert>();
  if (threshold <= 0 || verts.length < 2) return mapping;

  const cell = Math.max(threshold, 1e-6);
  const buckets = new Map<string, Vert[]>();
  const thresholdSq = threshold * threshold;

  const keyFor = (co: Vec3, offsetX: number, offsetY: number, offsetZ: number) =>
    `${Math.floor(co.x / cell) + offsetX}:${Math.floor(co.y / cell) + offsetY}:${
      Math.floor(co.z / cell) + offsetZ
    }`;

  for (const vert of verts) {
    if (mapping.has(vert.id)) continue;

    let target: Vert | null = null;
    for (let x = -1; x <= 1 && !target; x++) {
      for (let y = -1; y <= 1 && !target; y++) {
        for (let z = -1; z <= 1 && !target; z++) {
          for (const candidate of buckets.get(keyFor(vert.co, x, y, z)) ?? []) {
            if (distanceSq(candidate.co, vert.co) <= thresholdSq) {
              target = candidate;
              break;
            }
          }
        }
      }
    }

    if (target) {
      mapping.set(vert.id, target);
      continue;
    }

    const key = keyFor(vert.co, 0, 0, 0);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(vert);
    else buckets.set(key, [vert]);
  }

  return mapping;
}

/** The primary automatic topology cleanup: collapse vertices closer than `threshold`. */
export function mergeByDistance(
  mesh: BMesh,
  verts: readonly Vert[],
  threshold: number,
): MergeByDistanceResult {
  const mapping = planMergeByDistance(verts, threshold);
  return { removed: weldVerts(mesh, mapping) };
}

/**
 * Welds vertices a transform has just left sitting on top of others.
 *
 * Blender's auto merge, and the reason an edge slide run all the way onto the
 * loop next door collapses into it rather than leaving two loops in the same
 * place. Only the vertices that moved can be removed: a threshold wide enough
 * to catch what the user just did would otherwise weld pairs elsewhere in the
 * mesh that have sat that close since it was built.
 *
 * Where a moved vertex has landed on one that stayed put, the still one is
 * kept, so the surface stays where the rest of the mesh expects it.
 */
export function autoMergeVerts(
  mesh: BMesh,
  moved: readonly Vert[],
  threshold: number,
): MergeByDistanceResult {
  if (threshold <= 0 || moved.length === 0) return { removed: 0 };

  const cell = Math.max(threshold, 1e-6);
  const thresholdSq = threshold * threshold;
  const keyFor = (co: Vec3, offsetX: number, offsetY: number, offsetZ: number) =>
    `${Math.floor(co.x / cell) + offsetX}:${Math.floor(co.y / cell) + offsetY}:${
      Math.floor(co.z / cell) + offsetZ
    }`;

  // Every vertex of the mesh is a candidate to land on, not only the moved
  // ones: the whole point is welding a moved loop onto the still one it was
  // slid into.
  const buckets = new Map<string, Vert[]>();
  for (const vert of mesh.verts.values()) {
    const key = keyFor(vert.co, 0, 0, 0);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(vert);
    else buckets.set(key, [vert]);
  }

  const movedIds = new Set(moved.map((vert) => vert.id));
  const mapping = new Map<number, Vert>();
  // Targets are held back from being welded away themselves: `weldVerts`
  // resolves each vertex once and does not chase a chain of replacements.
  const kept = new Set<number>();

  for (const vert of moved) {
    if (!mesh.verts.has(vert.id) || kept.has(vert.id) || mapping.has(vert.id)) continue;

    let target: Vert | null = null;
    let best = Infinity;

    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          for (const candidate of buckets.get(keyFor(vert.co, x, y, z)) ?? []) {
            if (candidate === vert || mapping.has(candidate.id)) continue;

            const away = distanceSq(candidate.co, vert.co);
            if (away > thresholdSq) continue;

            // A vertex that held still wins over one that was moving too,
            // however much closer the moving one happens to be.
            const score = away + (movedIds.has(candidate.id) ? thresholdSq : 0);
            if (score >= best) continue;
            best = score;
            target = candidate;
          }
        }
      }
    }

    if (!target) continue;
    mapping.set(vert.id, target);
    kept.add(target.id);
  }

  return { removed: weldVerts(mesh, mapping) };
}
/** Counts what `mergeByDistance` would remove, for the preview readout. */
export function countMergeByDistance(verts: readonly Vert[], threshold: number): number {
  return planMergeByDistance(verts, threshold).size;
}

export function mergeVerts(
  mesh: BMesh,
  verts: readonly Vert[],
  mode: MergeMode,
  cursor?: Vec3,
): MergeByDistanceResult {
  if (verts.length < 2) return { removed: 0 };

  // 'first'/'last' follow selection order (selectSeq), but only when every
  // vertex here actually has one: verts picked up some other way (select-all,
  // grow, freshly created geometry) keep selectSeq 0, which isn't ordered
  // relative to the rest, so those cases fall back to array order.
  let target = verts[mode === 'last' ? verts.length - 1 : 0];
  if ((mode === 'first' || mode === 'last') && verts.every((vert) => vert.selectSeq > 0)) {
    target = verts[0];
    for (const vert of verts) {
      const picks =
        mode === 'last' ? vert.selectSeq > target.selectSeq : vert.selectSeq < target.selectSeq;
      if (picks) target = vert;
    }
  }
  if (mode === 'center' || mode === 'collapse') {
    target.co = centroid(verts.map((vert) => vert.co));
  } else if (mode === 'cursor' && cursor) {
    target.co = clone(cursor);
  }

  const mapping = new Map<number, Vert>();
  for (const vert of verts) {
    if (vert !== target) mapping.set(vert.id, target);
  }

  target.selected = true;
  return { removed: weldVerts(mesh, mapping) };
}
