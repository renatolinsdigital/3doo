import { type Vec3, clamp, distance, lerp } from '../math';
import type { BMesh } from '../mesh';
import type { Vert } from '../mesh/types';

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

export interface Chain {
  /** The vertices being worked on, in the order they run along the chain. */
  verts: Vert[];
  /** The vertices pinning the ends; null when the chain closes on itself. */
  head: Vert | null;
  tail: Vert | null;
  /**
   * The border this chain runs along, as it was before anything moved, or null
   * for a chain running across the surface.
   *
   * A border is where the mesh stops, so there is no surface past it to drop a
   * smoothed vertex back onto and smoothing one eats into the outline for good:
   * relax a plane's border a few times and its corners are gone. A border chain
   * only spreads out along the border it already occupies.
   */
  border: Vec3[] | null;
}

/** A selected vertex with no chain through it, and the neighbours around it. */
export interface ChainPatch {
  vert: Vert;
  neighbours: Vert[];
}

export interface ChainSelection {
  /** The given vertices that are still in the mesh. */
  live: Vert[];
  chains: Chain[];
  patch: ChainPatch[];
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

function walkChains(
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

/**
 * Sorts a selection into the chains running through it and the vertices left
 * over.
 *
 * This is the reading of a selection every loop operator starts from: relax,
 * circle and space all need to know which vertices lie on a loop, in what order
 * they run along it, and where that loop stops.
 */
export function findChains(mesh: BMesh, verts: readonly Vert[]): ChainSelection {
  const live = verts.filter((vert) => mesh.verts.has(vert.id));
  const selected = new Set(live.map((vert) => vert.id));
  const links = new Map<number, { before: Vert; after: Vert; border: boolean }>();
  const patch: ChainPatch[] = [];

  for (const vert of live) {
    const hood = neighbourhood(mesh, vert, selected);
    if (hood.kind === 'chain') links.set(vert.id, hood);
    else if (hood.kind === 'patch' && hood.verts.length > 0) {
      patch.push({ vert, neighbours: hood.verts });
    }
  }

  return { live, chains: walkChains(live, links), patch };
}

/** A chain that closes on itself has no ends, so nothing pins it. */
export function isClosedChain(chain: Chain): boolean {
  return chain.head === null || chain.tail === null;
}

/**
 * The line the chain traces as it stands, with its pinned ends on either side.
 *
 * The pins belong to the path because the spacing runs between them: they are
 * where the chain joins the rest of the mesh, and a chain spaced without them
 * would pull away from it at both ends.
 */
export function chainPath(chain: Chain): Vec3[] {
  const points = chain.verts.map((vert) => vert.co);
  if (chain.head === null || chain.tail === null) return points;
  return [chain.head.co, ...points, chain.tail.co];
}

/** Distance along `path` at each of its points; the last entry is its length. */
export function arcLengths(path: readonly Vec3[], closed: boolean): number[] {
  const at = [0];
  for (let i = 1; i < path.length; i++) at.push(at[i - 1] + distance(path[i - 1], path[i]));
  if (closed) at.push(at[at.length - 1] + distance(path[path.length - 1], path[0]));
  return at;
}

/** The point `s` along `path`, measured from its start. */
export function pointAlong(path: readonly Vec3[], at: readonly number[], s: number): Vec3 {
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
export function spreadAlong(path: readonly Vec3[], closed: boolean, count: number): Vec3[] {
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
