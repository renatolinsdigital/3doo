import {
  type Vec3,
  addScaled,
  centroid,
  clamp,
  distance,
  distanceSq,
  dot,
  lerp,
  sub,
} from '../math';
import type { BMesh } from '../mesh';
import type { Vert } from '../mesh/types';

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

/**
 * What the selection looks like around one vertex.
 *
 * A chain runs through it, a patch surrounds it, and a pin is the end of a
 * chain that ran out: the vertex the rest of that chain is spaced against, so
 * it holds still. Which one a vertex is in is a question about the selection as
 * much as the mesh: two neighbours selected either side of it means the user
 * picked a loop, and only one means they picked where that loop stops.
 */
type Neighbourhood =
  | { kind: 'chain'; before: Vert; after: Vert; border: boolean }
  | { kind: 'patch'; verts: Vert[] }
  | { kind: 'pin' };

interface Chain {
  /** The vertices being relaxed, in the order they run along the chain. */
  verts: Vert[];
  /** The vertices pinning the ends; null when the chain closes on itself. */
  head: Vert | null;
  tail: Vert | null;
  /**
   * The border this chain runs along, as it was before the first pass, or null
   * for a chain running across the surface.
   *
   * A border is where the mesh stops, so there is no surface past it to drop a
   * smoothed vertex back onto and smoothing one eats into the outline for good:
   * relax a plane's border a few times and its corners are gone. A border chain
   * only spreads out along the border it already occupies.
   */
  border: Vec3[] | null;
}

function neighbourhood(mesh: BMesh, vert: Vert, selected: ReadonlySet<number>): Neighbourhood {
  const neighbours = vert.edges.map((edge) => mesh.edgeOther(edge, vert));
  const inSelection = neighbours.filter((neighbour) => selected.has(neighbour.id));

  const border = vert.edges.filter((edge) => mesh.isBoundaryEdge(edge));
  if (border.length === 2) {
    const ends = border.map((edge) => mesh.edgeOther(edge, vert));
    // Only when the selection runs along the border, rather than merely
    // reaching it: a loop that crosses the mesh and stops at the edge of it is
    // pinned there, not slid along it.
    if (ends.some((end) => selected.has(end.id))) {
      return { kind: 'chain', before: ends[0], after: ends[1], border: true };
    }
  }

  if (inSelection.length === 2) {
    return { kind: 'chain', before: inSelection[0], after: inSelection[1], border: false };
  }

  return inSelection.length === 1 ? { kind: 'pin' } : { kind: 'patch', verts: neighbours };
}

/** Distance along `path` at each of its points; the last entry is its length. */
function arcLengths(path: readonly Vec3[], closed: boolean): number[] {
  const at = [0];
  for (let i = 1; i < path.length; i++) at.push(at[i - 1] + distance(path[i - 1], path[i]));
  if (closed) at.push(at[at.length - 1] + distance(path[path.length - 1], path[0]));
  return at;
}

/** The point `s` along `path`, measured from its start. */
function pointAlong(path: readonly Vec3[], at: readonly number[], s: number): Vec3 {
  const total = at[at.length - 1];
  if (total === 0) return path[0];

  const target = clamp(s, 0, total);
  let i = 1;
  while (i < at.length - 1 && at[i] < target) i++;

  const span = at[i] - at[i - 1];
  // On a closed path the last segment runs back to where it started.
  return lerp(path[i - 1], path[i] ?? path[0], span === 0 ? 0 : (target - at[i - 1]) / span);
}

/** Spreads `count` points evenly along `path`, and reports where they land. */
function spreadAlong(path: readonly Vec3[], closed: boolean, count: number): Vec3[] {
  const at = arcLengths(path, closed);
  const total = at[at.length - 1];

  if (!closed) {
    // The ends of the path are the pinned vertices, so the spacing runs between
    // them and the moving vertices take the gaps in the middle.
    const step = total / (count + 1);
    return Array.from({ length: count }, (_, i) => pointAlong(path, at, (i + 1) * step));
  }

  // Spread from where the loop already lies rather than from whichever vertex
  // the walk happened to start at: the offset that moves the loop least is the
  // average of what each vertex would otherwise have to travel. Without it an
  // already even loop would still rotate by a fraction of a segment.
  const step = total / count;
  let offset = 0;
  for (let i = 0; i < count; i++) offset += at[i] - i * step;
  offset /= count;

  return Array.from({ length: count }, (_, i) =>
    pointAlong(path, at, (((i * step + offset) % total) + total) % total),
  );
}

/**
 * Where a chain wants its vertices, read off where they are now.
 *
 * Two things at once, which is what relaxing a loop means: every point is
 * pulled onto the midpoint of its neighbours, which is what takes a kink out,
 * and the vertices are then spread evenly along the path that leaves, which is
 * what evens out the spacing. A border keeps the path it has and only takes the
 * second.
 */
function chainTargets(chain: Chain): Vec3[] {
  const { head, tail } = chain;
  const closed = head === null || tail === null;
  const points = chain.verts.map((vert) => vert.co);

  if (chain.border) return spreadAlong(chain.border, closed, chain.verts.length);

  const path = closed ? points : [head.co, ...points, tail.co];
  const smoothed = path.map((point, i) => {
    if (!closed && (i === 0 || i === path.length - 1)) return point;
    return lerp(path[(i - 1 + path.length) % path.length], path[(i + 1) % path.length], 0.5);
  });

  return spreadAlong(smoothed, closed, chain.verts.length);
}

function collectChains(
  live: readonly Vert[],
  links: ReadonlyMap<number, { before: Vert; after: Vert; border: boolean }>,
): Chain[] {
  const visited = new Set<number>();
  const chains: Chain[] = [];

  /** Follows the chain out of `from` through `into`, and reports where it ended. */
  const walk = (from: Vert, into: Vert, ordered: Vert[], append: boolean): Vert => {
    let previous = from;
    let current = into;
    let link = links.get(current.id);

    while (link && !visited.has(current.id)) {
      visited.add(current.id);
      if (append) ordered.push(current);
      else ordered.unshift(current);

      const onward = link.before === previous ? link.after : link.before;
      previous = current;
      current = onward;
      link = links.get(current.id);
    }

    return current;
  };

  for (const vert of live) {
    const link = links.get(vert.id);
    if (!link || visited.has(vert.id)) continue;

    visited.add(vert.id);
    const ordered = [vert];
    const tail = walk(vert, link.after, ordered, true);
    const head = walk(vert, link.before, ordered, false);

    // The walk came back to where it started, so the chain closes on itself and
    // has no ends to pin.
    const closed = tail === vert || head === vert;
    const path = ordered.map((member) => member.co);
    chains.push({
      verts: ordered,
      head: closed ? null : head,
      tail: closed ? null : tail,
      border: !link.border ? null : closed ? path : [head.co, ...path, tail.co],
    });
  }

  return chains;
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
  patch: readonly { vert: Vert; neighbours: Vert[] }[],
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
      const path = { path: chain.border, closed: chain.head === null };
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

  const live = verts.filter((vert) => mesh.verts.has(vert.id));
  if (live.length === 0 || factor === 0) return 0;

  const selected = new Set(live.map((vert) => vert.id));
  const links = new Map<number, { before: Vert; after: Vert; border: boolean }>();
  const patch: { vert: Vert; neighbours: Vert[] }[] = [];

  for (const vert of live) {
    const hood = neighbourhood(mesh, vert, selected);
    if (hood.kind === 'chain') links.set(vert.id, hood);
    else if (hood.kind === 'patch' && hood.verts.length > 0)
      patch.push({ vert, neighbours: hood.verts });
  }

  const chains = collectChains(live, links);
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
