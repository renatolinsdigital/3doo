import { type Vec3, addScaled, centroid, clamp, distanceSq, dot, lerp, sub } from '../math';
import type { BMesh } from '../mesh';
import type { Vert } from '../mesh/types';

import {
  type Chain,
  type ChainPatch,
  chainPath,
  findChains,
  isClosedChain,
  spreadAlong,
} from './chains';

export interface RelaxOptions {
  /** 0..1 blend from where a vertex sits toward where the relax wants it. */
  factor?: number;
  /** Passes to run; each one starts from the previous one's result. */
  iterations?: number;
  /**
   * Put every vertex back on the geometry it started on once it has moved.
   *
   * This is what separates relaxing from smoothing, and it is why a relaxed
   * loop keeps the shape it runs over. Taking the kinks out of a loop pulls it
   * toward the inside of every bend, and on anything but a flat surface that
   * leaves the surface: the loop sinks into the mesh a little on every pass.
   * Dropping each relaxed position back onto the faces it came from lets the
   * loop slide across the shape instead of eating into it. Switched off, the
   * same passes smooth the mesh itself: spikes flatten, and a sphere deflates.
   */
  keepShape?: boolean;
}

function chainTargets(chain: Chain): Vec3[] {
  const closed = isClosedChain(chain);
  if (chain.border) return spreadAlong(chain.border, closed, chain.verts.length);

  const path = chainPath(chain);
  const smoothed = path.map((point, i) => {
    if (!closed && (i === 0 || i === path.length - 1)) return point;
    return lerp(path[(i - 1 + path.length) % path.length], path[(i + 1) % path.length], 0.5);
  });

  return spreadAlong(smoothed, closed, chain.verts.length);
}

/** The point of triangle `abc` closest to `p`. */
function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;

  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return addScaled(a, ab, d1 / (d1 - d3));

  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return addScaled(a, ac, d2 / (d2 - d6));

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return addScaled(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  }

  const denominator = 1 / (va + vb + vc);
  return addScaled(addScaled(a, ab, vb * denominator), ac, vc * denominator);
}

/** The point of `path` closest to `p`. */
function closestOnPath(p: Vec3, path: readonly Vec3[], closed: boolean): Vec3 {
  let best = path[0];
  let found = Infinity;

  for (let i = 0; i < (closed ? path.length : path.length - 1); i++) {
    const a = path[i];
    const along = sub(path[(i + 1) % path.length], a);
    const span = dot(along, along);
    const t = span === 0 ? 0 : clamp(dot(sub(p, a), along) / span, 0, 1);

    const candidate = addScaled(a, along, t);
    const away = distanceSq(p, candidate);
    if (away < found) {
      found = away;
      best = candidate;
    }
  }

  return best;
}

/**
 * Builds the function that puts a relaxed vertex back where it may be.
 *
 * The geometry it lands on is read once, before the first pass: a surface a
 * previous pass had already moved would let the selection creep across the mesh
 * a little further every time, which is the drift the anchoring is there to
 * stop. Only the faces around the vertex and the ones it is spaced against are
 * offered, since a pass never moves it further than about one edge.
 */
function surfaceAnchor(
  mesh: BMesh,
  chains: readonly Chain[],
  patch: readonly ChainPatch[],
): (vert: Vert, point: Vec3) => Vec3 {
  const rings = new Map<number, Vec3[]>();
  const nearby = new Map<number, number[]>();
  const borders = new Map<number, { path: Vec3[]; closed: boolean }>();

  const remember = (vert: Vert, sources: readonly Vert[]) => {
    const faces = new Set<number>();
    for (const source of sources) {
      for (const face of mesh.vertFaces(source)) {
        faces.add(face.id);
        if (!rings.has(face.id)) rings.set(face.id, mesh.facePoints(face));
      }
    }
    nearby.set(vert.id, [...faces]);
  };

  for (const chain of chains) {
    if (chain.border) {
      const path = { path: chain.border, closed: isClosedChain(chain) };
      for (const vert of chain.verts) borders.set(vert.id, path);
      continue;
    }

    const last = chain.verts.length - 1;
    chain.verts.forEach((vert, i) => {
      // A loop travels along itself, so the faces either side of it are where a
      // relaxed vertex is most likely to come down.
      const before = i === 0 ? (chain.head ?? chain.verts[last]) : chain.verts[i - 1];
      const after = i === last ? (chain.tail ?? chain.verts[0]) : chain.verts[i + 1];
      remember(vert, [vert, before, after]);
    });
  }

  for (const { vert } of patch) remember(vert, [vert]);

  return (vert, point) => {
    const border = borders.get(vert.id);
    if (border) return closestOnPath(point, border.path, border.closed);

    let best = point;
    let found = Infinity;

    for (const id of nearby.get(vert.id) ?? []) {
      const ring = rings.get(id);
      if (!ring) continue;

      for (let i = 2; i < ring.length; i++) {
        const candidate = closestOnTriangle(point, ring[0], ring[i - 1], ring[i]);
        const away = distanceSq(point, candidate);
        if (away < found) {
          found = away;
          best = candidate;
        }
      }
    }

    return best;
  };
}

/**
 * Relaxes the given vertices: kinks out, spacing even, shape kept.
 *
 * The relax of Blender's LoopTools rather than plain vertex smoothing. A
 * selection that runs through a vertex as a chain (an edge loop, a ring left
 * ragged by a cut or a bevel) is pulled straight and spread out along itself,
 * and then dropped back onto the surface it came from, so it slides across the
 * shape rather than sinking into it. Where the selection runs out, the vertex
 * it ran out at holds still and the rest is spaced against it.
 *
 * A selection that is not a chain (a patch of surface, or a whole mesh) has
 * no loop to straighten and smooths against its neighbourhood instead, kept on
 * the surface the same way.
 *
 * Returns how many vertices were moved.
 */
export function relaxVerts(
  mesh: BMesh,
  verts: readonly Vert[],
  options: RelaxOptions = {},
): number {
  const factor = clamp(options.factor ?? 0.5, 0, 1);
  const iterations = Math.max(1, Math.floor(options.iterations ?? 1));
  const keepShape = options.keepShape ?? true;

  const { live, chains, patch } = findChains(mesh, verts);
  if (live.length === 0 || factor === 0) return 0;

  const anchor = keepShape ? surfaceAnchor(mesh, chains, patch) : null;
  const settle = (vert: Vert, point: Vec3) => (anchor ? anchor(vert, point) : point);

  for (let pass = 0; pass < iterations; pass++) {
    // Every position is worked out before any is applied. A pass that read
    // positions it had already written would relax in mesh order, and the same
    // selection would settle differently depending on the order its vertices
    // happened to be created in.
    const next = new Map<number, Vec3>();

    for (const chain of chains) {
      const targets = chainTargets(chain);
      chain.verts.forEach((vert, i) =>
        next.set(vert.id, settle(vert, lerp(vert.co, targets[i], factor))),
      );
    }

    for (const { vert, neighbours } of patch) {
      const target = centroid(neighbours.map((neighbour) => neighbour.co));
      next.set(vert.id, settle(vert, lerp(vert.co, target, factor)));
    }

    for (const vert of live) {
      const co = next.get(vert.id);
      if (co) vert.co = co;
    }
  }

  mesh.computeNormals();
  return chains.reduce((total, chain) => total + chain.verts.length, 0) + patch.length;
}
