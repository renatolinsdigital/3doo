import {
  type Vec3,
  add,
  basisFromNormal,
  centroid,
  clamp,
  cross,
  degToRad,
  dot,
  length,
  lerp,
  mul,
  polygonArea,
  polygonNormal,
  sub,
} from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, Loop, Vert } from '../mesh/types';

import { MESH_BUDGET } from './budget';
import { carrySharp } from './normals';
import { convexPieces } from './subdivide';

type Uv = Loop['uv'];

/** One corner of a ring about to become a face, with the UV it carries there. */
interface Corner {
  vert: Vert;
  uv: Uv;
}

interface Point {
  x: number;
  y: number;
}

/**
 * How far two faces may lean apart and still be one flat region. Kept tight:
 * the merged face is flattened onto a single plane to be cut up again, and the
 * fan of triangles round the pole of a finely divided sphere leans less than a
 * degree from one triangle to the next.
 */
const FLAT_DEGREES = 0.1;

/**
 * How square a pair of triangles has to come out to be joined before anything
 * else happens: every corner between 30 and 150 degrees. That recovers a mesh
 * that was quads before something triangulated it, and leaves the slivers a
 * boolean scatters over a flat face for the region merge to take back.
 */
const WELL_SHAPED = 0.5;

/**
 * How square a pair of triangles has to come out to be joined at all, once
 * the flat regions are merged: every corner between 10 and 170 degrees, which
 * still takes the fan round a pole or the tip of a cone as kites.
 */
const JOINABLE = Math.sin(degToRad(10));

/**
 * The flattest a corner of a new quad may be. A corner closer to straight than
 * this is a triangle with a vertex on one side, which is no quad worth having:
 * a loop run through the face does better.
 */
const SLIVER = Math.sin(degToRad(5));

/**
 * What a point added in the middle of a face costs, against splitting it
 * between the corners it already has: a quad has to come out about twice as
 * square for the extra pole to be worth it.
 */
const STAR_PENALTY = Math.log(0.5);

/** The largest ring cut by the exact search. Past it, rings are halved first. */
const EXACT_LIMIT = 40;

/**
 * The largest ring whose star has its middle searched for, rather than only
 * tried at a few likely points. Small rings are where a bent outline leaves the
 * likely points no room, and where searching costs nothing.
 */
const STAR_SEARCH_LIMIT = 12;

/** What a path between two odd faces pays to enter a face. */
const STEP_COST = 1;
/** Turning inside a quad leaves a pole where the two loops meet, so it costs more than running straight. */
const TURN_COST = 2;
/** Leaving a quad by the side it was entered by leaves two straight corners in a row. */
const SAME_SIDE_COST = 4;
/** Crossing anything but a plain quad. */
const NGON_COST = 1;
/**
 * Crossing a face already given rungs to make it cut. Another path across it
 * changes its ring again, and the cut the rungs gave it may not survive that.
 */
const CROSSED_COST = 6;
/** Ending a path on an open border, rather than at another odd face. */
const BORDER_COST = 1.5;

/**
 * Rebuilds every face that is not a quad as quads, keeping the shape exactly.
 *
 * In four passes:
 *
 * 1. Triangles that pair into a well shaped quad are joined.
 * 2. The faces left that are not quads are merged wherever they lie flat
 *    against each other, so a flat region a boolean shattered into slivers
 *    comes back as the one face it really is.
 * 3. A face with an odd number of corners cannot be cut into quads at all, so
 *    edges are split until none is left odd. Every odd face is paired with the
 *    nearest one by a path between them, splitting each edge it crosses. A
 *    path runs straight through a quad wherever it can: that is a loop cut,
 *    and it leaves both halves quads.
 * 4. Every face with more than four corners, split ones included, is cut into
 *    quads between the corners it has, or around a point in its middle where
 *    that comes out squarer.
 *
 * Some faces have no such cut. One that has none is offered rungs first: its
 * sides are split where its inward corners look straight across at them, and
 * the paths take care of the faces across them (see `findRungs`). That is what
 * straightens out the bent band a boolean leaves where one box sits turned on
 * another.
 *
 * What no rung helps is cut the way a subdivision cuts it: into convex pieces,
 * every side split, one quad per corner round each piece's middle. Triangles
 * go that way from the start, since one with a single side split is only a quad
 * with a straight corner, and so does a face a boolean bit a curve out of,
 * whose inward corners no point inside it can see past.
 *
 * Quads are never touched unless a path runs through them, so a mesh that is
 * already all quads comes back as it was. No vertex moves; the new ones sit on
 * the edges and faces they split.
 *
 * `angleLimit` is the sharpest fold, in degrees, two triangles may meet at and
 * still be joined. Triangles past it are cut into quads each on their own.
 */
export function quadReloop(mesh: BMesh, angleLimit = 40): void {
  const fold = Math.cos(degToRad(clamp(angleLimit, 0, 180)));
  joinTriangles(mesh, fold, WELL_SHAPED);
  mergeFlatRegions(mesh);
  joinTriangles(mesh, fold, JOINABLE);

  const plan = planReloop(mesh);
  // The joins and merges only ever removed faces. The cuts are what add them,
  // and a result past what a tab can hold is not worth the window.
  if (plannedFaces(mesh, plan) <= MESH_BUDGET.faces) cutIntoQuads(mesh, plan);
  mesh.computeNormals();
}

function cornerOf(loop: Loop): Corner {
  return { vert: loop.vert, uv: loop.uv };
}

/**
 * Swaps faces for new rings in the same material and shading, and drops the
 * edges only the old faces were using.
 */
function replaceFaces(mesh: BMesh, old: readonly Face[], rings: readonly Corner[][]): Face[] {
  const { materialIndex, smooth } = old[0];
  const stale = new Set<Edge>();
  for (const face of old) {
    for (const edge of mesh.faceEdges(face)) stale.add(edge);
    mesh.removeFace(face);
  }

  const made = rings.map((ring) => {
    const face = mesh.addFace(
      ring.map((corner) => corner.vert),
      { materialIndex, smooth },
    );
    const loops = mesh.faceLoops(face);
    // addFace hands back a face that already spans the ring rather than a new
    // one, and that face's corners need not start where the ring does.
    if (loops[0].vert === ring[0].vert) {
      loops.forEach((loop, i) => (loop.uv = { ...ring[i].uv }));
    }
    return face;
  });

  for (const edge of stale) {
    if (mesh.edges.has(edge.id) && edge.loops.length === 0) mesh.removeEdge(edge);
  }
  return made;
}

/** The two loops along an edge between exactly two faces wound the same way. */
function pairAcross(edge: Edge): [Loop, Loop] | null {
  if (edge.sharp || edge.loops.length !== 2) return null;
  const [near, far] = edge.loops;
  if (near.face === far.face) return null;
  // Two faces wound the same way run along the edge in opposite directions.
  if (far.vert !== near.next.vert) return null;
  return [near, far];
}

interface TrianglePair {
  faces: [Face, Face];
  ring: Corner[];
  quality: number;
}

function trianglePair(mesh: BMesh, edge: Edge, fold: number): TrianglePair | null {
  const loops = pairAcross(edge);
  if (!loops) return null;
  const [near, far] = loops;
  if (mesh.faceLoopCount(near.face) !== 3 || mesh.faceLoopCount(far.face) !== 3) return null;
  if (near.face.materialIndex !== far.face.materialIndex) return null;
  if (dot(near.face.normal, far.face.normal) < fold) return null;
  // Two triangles over the same three corners: a doubled face, not a pair.
  if (far.prev.vert === near.prev.vert) return null;

  const ring = [cornerOf(near), cornerOf(far.prev), cornerOf(near.next), cornerOf(near.prev)];
  const points = ring.map((corner) => corner.vert.co);
  const outline = flatten(points);
  if (!outline) return null;
  const [a, b, c, d] = outline.flat;
  if (quadQuality(a, b, c, d) <= 0) return null;

  // Measured on the quad itself, not on the plane it was flattened onto: a
  // pair folded across the side of a cone lays its corners out flatter than
  // they are.
  let quality = 1;
  for (let i = 0; i < 4; i++) {
    const at = points[i];
    const before = sub(points[(i + 3) % 4], at);
    const after = sub(points[(i + 1) % 4], at);
    quality = Math.min(quality, length(cross(before, after)) / (length(before) * length(after)));
  }
  return { faces: [near.face, far.face], ring, quality };
}

/**
 * Joins pairs of triangles into quads, the squarest first, then pairs up as
 * many of the triangles left over as it can.
 *
 * Squarest first is what puts a triangulated grid back as the grid it was: the
 * pair across a cell's diagonal makes a square, the pair across one of its
 * sides only a rhombus, so every diagonal goes before any side is considered.
 */
function joinTriangles(mesh: BMesh, fold: number, floor: number): void {
  const pairs: TrianglePair[] = [];
  const options = new Map<Face, TrianglePair[]>();
  for (const edge of mesh.edges.values()) {
    const pair = trianglePair(mesh, edge, fold);
    if (!pair || pair.quality < floor) continue;
    pairs.push(pair);
    for (const face of pair.faces) options.set(face, [...(options.get(face) ?? []), pair]);
  }
  pairs.sort((a, b) => b.quality - a.quality);

  const mates = new Map<Face, TrianglePair>();
  for (const pair of pairs) {
    if (pair.faces.some((face) => mates.has(face))) continue;
    for (const face of pair.faces) mates.set(face, pair);
  }
  for (const face of options.keys()) {
    if (!mates.has(face)) rematch(face, options, mates);
  }

  for (const pair of new Set(mates.values())) replaceFaces(mesh, pair.faces, [pair.ring]);
}

/** How far the search for a partner reaches, in triangles, before it gives up. */
const REMATCH_REACH = 64;

function otherOf(pair: TrianglePair, face: Face): Face {
  return pair.faces[0] === face ? pair.faces[1] : pair.faces[0];
}

/**
 * Finds a partner for a triangle the squarest-first pass left alone by
 * shuffling the pairs between it and another lone triangle along the way.
 *
 * Squarest first goes wrong wherever the pairs are equally square, round the
 * fan at a pole or the tip of a cone: rounding decides the order, and one pair
 * taken a step out of turn strands a triangle on either side of it. Each
 * stranded triangle would come back as three quads and a loop besides.
 */
function rematch(
  start: Face,
  options: ReadonlyMap<Face, TrianglePair[]>,
  mates: Map<Face, TrianglePair>,
): void {
  const reached = new Map<Face, TrianglePair>();
  const seen = new Set<Face>([start]);
  const queue = [start];

  while (queue.length > 0 && seen.size < REMATCH_REACH) {
    const at = queue.shift() as Face;
    for (const pair of options.get(at) ?? []) {
      const other = otherOf(pair, at);
      if (seen.has(other)) continue;
      seen.add(other);
      reached.set(other, pair);

      const mate = mates.get(other);
      if (!mate) {
        // Walk back to the start, pairing each triangle with the one before
        // it and leaving the one it was paired with for the step after.
        let face = other;
        for (;;) {
          const link = reached.get(face) as TrianglePair;
          const from = otherOf(link, face);
          const freed = mates.get(from);
          mates.set(face, link);
          mates.set(from, link);
          if (from === start || !freed) return;
          face = otherOf(freed, from);
        }
      }

      const next = otherOf(mate, other);
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
}

/**
 * Merges the faces that are not quads into one face per flat region.
 *
 * Quads stay out of it, so the loops a mesh already has are left alone, and a
 * face merged here stays in it however many corners it ends up with: two
 * triangles make four, and the third one beside them still belongs.
 */
function mergeFlatRegions(mesh: BMesh): void {
  const flat = Math.cos(degToRad(FLAT_DEGREES));
  const loose = new Set<Face>();
  for (const face of mesh.faces.values()) {
    if (mesh.faceLoopCount(face) !== 4) loose.add(face);
  }

  let merged = true;
  while (merged) {
    merged = false;
    for (const edge of [...mesh.edges.values()]) {
      if (!mesh.edges.has(edge.id)) continue;
      const loops = pairAcross(edge);
      if (!loops) continue;
      const [near, far] = loops;
      if (!loose.has(near.face) || !loose.has(far.face)) continue;
      if (dot(near.face.normal, far.face.normal) < flat) continue;
      if (near.face.materialIndex !== far.face.materialIndex) continue;
      if (near.face.smooth !== far.face.smooth) continue;

      // The near face from the far end of the edge round to its near end,
      // then the far face's corners in between, without the two it shares.
      const ring: Corner[] = [];
      for (let loop = near.next; loop !== near; loop = loop.next) ring.push(cornerOf(loop));
      ring.push(cornerOf(near));
      for (let loop = far.next.next; loop !== far; loop = loop.next) ring.push(cornerOf(loop));
      // A ring through one corner twice would wrap round a hole.
      if (new Set(ring.map((corner) => corner.vert)).size !== ring.length) continue;

      const [face] = replaceFaces(mesh, [near.face, far.face], [ring]);
      loose.add(face);
      merged = true;
    }
  }
}

/** Corners a face ends up with once the planned edges are split. */
function cornersAfter(mesh: BMesh, face: Face, splits: ReadonlyMap<Edge, number>): number {
  let corners = 0;
  for (const loop of mesh.faceLoops(face)) corners += splits.has(loop.edge) ? 2 : 1;
  return corners;
}

/**
 * Chooses the edges to split so that no face is left with an odd number of
 * corners.
 *
 * Every side of a hard face is split, and then the odd faces are paired off
 * along paths. A path never crosses an edge already being split, so no edge
 * is split twice. That never strands a face: the corners of every face in a
 * closed region add up to twice its edges, so each region the split edges wall
 * off holds an even number of odd faces, and a region with an open border can
 * end a path on it.
 */
function planSplits(
  mesh: BMesh,
  hard: ReadonlySet<Face>,
  forced: ReadonlyMap<Edge, number>,
  crossed: ReadonlySet<Face>,
): Splits {
  const splits = fixedSplits(mesh, hard, forced);

  const odd = new Set<Face>();
  for (const face of mesh.faces.values()) {
    if (cornersAfter(mesh, face, splits) % 2 === 1) odd.add(face);
  }

  const known = new Map<Face, number[]>();
  const search: PathSearch = {
    mesh,
    odd,
    splits,
    crossed,
    sides: (face) => {
      let sides = known.get(face);
      if (!sides) {
        sides = sidesOf(mesh.faceLoops(face));
        known.set(face, sides);
      }
      return sides;
    },
  };

  for (const face of [...odd]) {
    if (!odd.delete(face)) continue;
    const path = pathToPartner(search, face);
    if (!path) continue;
    for (const edge of path.edges) splits.set(edge, 0.5);
    if (path.end) odd.delete(path.end);
  }
  return splits;
}

/**
 * Where along each edge to be split its new point goes, as a fraction of the
 * way from its `v0` to its `v1`. A path splits an edge in the middle; a rung
 * splits it where a corner of the face looks straight across at it.
 */
type Splits = Map<Edge, number>;

/** The splits no path can move: every side of a hard face, and every rung. */
function fixedSplits(
  mesh: BMesh,
  hard: ReadonlySet<Face>,
  forced: ReadonlyMap<Edge, number>,
): Splits {
  const splits: Splits = new Map(forced);
  for (const face of hard) {
    for (const edge of mesh.faceEdges(face)) if (!splits.has(edge)) splits.set(edge, 0.5);
  }
  return splits;
}

/** A face's corners, with the point each split puts along its sides. */
function ringPoints(loops: readonly Loop[], splits: ReadonlyMap<Edge, number>): Vec3[] {
  const points: Vec3[] = [];
  for (const loop of loops) {
    points.push(loop.vert.co);
    const at = splits.get(loop.edge);
    if (at !== undefined) points.push(lerp(loop.edge.v0.co, loop.edge.v1.co, at));
  }
  return points;
}

/** How far off straight, as a sine, a face's outline has to turn for a corner to count. */
const STRAIGHT_ON = 1e-3;

/**
 * Which side of its outline each corner's edge runs along, counting sides
 * between the corners the outline really turns at.
 *
 * A face with a point in the middle of one side is a pentagon by its count and
 * still a square by its shape, and a path has to read it as the square: one
 * that leaves by the side opposite the point cuts it as a loop cut would, one
 * that leaves by the same side leaves two straight corners in a row, which
 * nothing can cut.
 */
function sidesOf(loops: readonly Loop[]): number[] {
  const count = loops.length;
  const turns = loops.map((loop, i) => {
    const into = sub(loop.vert.co, loops[(i - 1 + count) % count].vert.co);
    const away = sub(loops[(i + 1) % count].vert.co, loop.vert.co);
    const reach = length(into) * length(away);
    return reach === 0 || length(cross(into, away)) / reach > STRAIGHT_ON || dot(into, away) < 0;
  });

  const first = Math.max(0, turns.indexOf(true));
  const sides = new Array<number>(count);
  let side = -1;
  for (let k = 0; k < count; k++) {
    const i = (first + k) % count;
    if (turns[i] || side < 0) side++;
    sides[i] = side;
  }
  return sides;
}

interface PathSearch {
  mesh: BMesh;
  odd: ReadonlySet<Face>;
  splits: ReadonlyMap<Edge, number>;
  crossed: ReadonlySet<Face>;
  sides: (face: Face) => number[];
}

/**
 * What it costs to go between two of a face's edges, by the sides of its
 * outline they lie on: nothing straight across a four-sided face, more to turn
 * a corner, more again to come back out the side it went in by.
 */
function across(sides: readonly number[], from: number, to: number): number {
  const count = Math.max(...sides) + 1;
  if (count !== 4) return NGON_COST;
  const apart = (sides[to] - sides[from] + 4) % 4;
  return apart === 2 ? 0 : apart === 0 ? SAME_SIDE_COST : TURN_COST;
}

/**
 * What it costs to split one edge of an odd face, at either end of a path.
 *
 * An odd face shaped like a quad carries its extra point on one of its sides,
 * or a planned split does. Splitting the side opposite that one is what cuts
 * it into two quads, so a path should leave or arrive there.
 */
function lean(search: PathSearch, face: Face, loop: Loop): number {
  const loops = search.mesh.faceLoops(face);
  const sides = search.sides(face);
  if (Math.max(...sides) !== 3) return 0;

  const crowded = new Set<number>();
  const seen = new Set<number>();
  loops.forEach((other, i) => {
    if (seen.has(sides[i]) || search.splits.has(other.edge)) crowded.add(sides[i]);
    seen.add(sides[i]);
  });
  if (crowded.size !== 1) return 0;

  const [side] = crowded;
  return across(sides, loops.indexOf(loop), sides.indexOf(side));
}

interface Step {
  cost: number;
  /** The face the path has just stepped into, or null once it has left across a border. */
  face: Face | null;
  via: Edge;
  /** The loop of `face` the path came in by. */
  entry: Loop | null;
  /** Whether the path ends here, at an odd face or off a border. */
  end: boolean;
  back: Step | null;
}

/**
 * The cheapest path from an odd face to another one, or off an open border.
 *
 * Searched over the edge a path enters each face by, not over faces alone,
 * because what crossing a face costs depends on which way it leaves.
 */
function pathToPartner(
  search: PathSearch,
  start: Face,
): { edges: Edge[]; end: Face | null } | null {
  const { mesh, odd, splits, crossed } = search;
  const queue: Step[] = [];
  const settled = new Set<number>();

  const leave = (from: Face, loop: Loop, cost: number, back: Step | null) => {
    const edge = loop.edge;
    if (splits.has(edge)) return;
    if (edge.loops.length === 1) {
      pushStep(queue, {
        cost: cost + BORDER_COST,
        face: null,
        via: edge,
        entry: null,
        end: true,
        back,
      });
      return;
    }
    if (edge.loops.length !== 2) return;
    const entry = edge.loops[0] === loop ? edge.loops[1] : edge.loops[0];
    const next = entry.face;
    if (next === from || next === start) return;
    const end = odd.has(next);
    const arrive = end ? lean(search, next, entry) : 0;
    pushStep(queue, { cost: cost + STEP_COST + arrive, face: next, via: edge, entry, end, back });
  };

  for (const loop of mesh.faceLoops(start)) leave(start, loop, lean(search, start, loop), null);

  for (let step = popStep(queue); step; step = popStep(queue)) {
    if (step.end) return { edges: trace(step), end: step.face };
    const { face, entry } = step;
    if (!face || !entry || settled.has(entry.id)) continue;
    settled.add(entry.id);

    const loops = mesh.faceLoops(face);
    const sides = search.sides(face);
    const from = loops.indexOf(entry);
    const toll = crossed.has(face) ? CROSSED_COST : 0;
    loops.forEach((loop, i) => {
      if (loop !== entry) leave(face, loop, step.cost + across(sides, from, i) + toll, step);
    });
  }
  return null;
}

function trace(step: Step): Edge[] {
  const edges: Edge[] = [];
  for (let at: Step | null = step; at; at = at.back) edges.push(at.via);
  return edges;
}

function pushStep(heap: Step[], step: Step): void {
  let i = heap.length;
  heap.push(step);
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent].cost <= step.cost) break;
    heap[i] = heap[parent];
    i = parent;
  }
  heap[i] = step;
}

function popStep(heap: Step[]): Step | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (!last || heap.length === 0) return top;
  let i = 0;
  for (;;) {
    const left = 2 * i + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && heap[right].cost < heap[left].cost ? right : left;
    if (heap[child].cost >= last.cost) break;
    heap[i] = heap[child];
    i = child;
  }
  heap[i] = last;
  return top;
}

/**
 * Planning rounds in which a face with no cut may still be given rungs. Past
 * them it is made hard, which always cuts, so the plan settles.
 */
const RUNG_ROUNDS = 4;

interface Plan {
  splits: Splits;
  /** Faces cut into convex pieces with every side split. */
  hard: Set<Face>;
  /** How every other face that changes is cut, by face. */
  cuts: Map<Face, Cut>;
}

/**
 * Settles which faces are hard, which edges are split and how every face that
 * changes is cut, without touching the mesh.
 *
 * A face that cannot be cut once the paths have split its sides is first
 * offered rungs (see `findRungs`), and only made hard when none help. Either
 * way the paths are planned again around it. Cuts are kept by the face and
 * where its sides are split, so a face the new paths leave alone is not cut
 * again.
 */
function planReloop(mesh: BMesh): Plan {
  const hard = new Set<Face>();
  for (const face of mesh.faces.values()) {
    if (mesh.faceLoopCount(face) === 3) hard.add(face);
  }
  const forced: Splits = new Map();
  const crossed = new Set<Face>();

  const known = new Map<string, Cut | null>();
  const cutOf: CutOf = (face, loops, splits) => {
    const key = `${face.id}:${loops.map((loop) => splits.get(loop.edge)?.toFixed(6) ?? '').join()}`;
    let cut = known.get(key);
    if (cut === undefined) {
      cut = planCut(ringPoints(loops, splits));
      known.set(key, cut);
    }
    return cut;
  };

  for (let round = 1; ; round++) {
    const splits = planSplits(mesh, hard, forced, crossed);
    const cuts = new Map<Face, Cut>();
    const failed: Face[] = [];

    for (const face of mesh.faces.values()) {
      if (hard.has(face)) continue;
      const loops = mesh.faceLoops(face);
      if (loops.length === 4 && !loops.some((loop) => splits.has(loop.edge))) continue;
      // A face through one corner twice wraps a hole and is left as it is.
      if (new Set(loops.map((loop) => loop.vert)).size !== loops.length) continue;

      const cut = cutOf(face, loops, splits);
      if (cut) cuts.set(face, cut);
      else failed.push(face);
    }

    if (failed.length === 0) return { splits, hard, cuts };

    const fixed = fixedSplits(mesh, hard, forced);
    for (const face of failed) {
      const rungs =
        round <= RUNG_ROUNDS ? findRungs(face, mesh.faceLoops(face), fixed, cutOf) : null;
      if (!rungs) {
        hard.add(face);
        continue;
      }
      for (const [edge, at] of rungs) {
        forced.set(edge, at);
        fixed.set(edge, at);
      }
      crossed.add(face);
    }
  }
}

type CutOf = (face: Face, loops: readonly Loop[], splits: ReadonlyMap<Edge, number>) => Cut | null;

/** The largest face offered rungs before being made hard. */
const RUNG_LIMIT = 12;

/** How many rungs each inward corner tries, the shortest first. */
const RUNGS_PER_CORNER = 3;

/** How many sets of rungs a face tries before it is made hard. */
const RUNG_ATTEMPTS = 400;

/**
 * Splits that give a face with no cut one, or null if none tried does.
 *
 * An inward corner can only be cut by a line from it into the face, and a line
 * across to a side needs a point on that side to end at. A rung is that line:
 * from an inward corner straight across to a side, ending where the corner's
 * perpendicular lands. Each inward corner tries its shortest few, with one
 * midpoint added wherever the count has to be made even, and the set that
 * cuts the face squarest is kept. That is what turns the bent band a boolean
 * leaves round a box sitting turned on another into a ladder of quads, where
 * splitting its sides in the middle never could.
 *
 * Splits already fixed on the face's sides stay where they are; the rest of
 * its sides are free. A face with no inward corner tries midpoints alone: two
 * of them run a loop through it.
 */
function findRungs(
  face: Face,
  loops: readonly Loop[],
  fixed: ReadonlyMap<Edge, number>,
  cutOf: CutOf,
): Splits | null {
  const count = loops.length;
  if (count > RUNG_LIMIT) return null;
  const outline = flatten(loops.map((loop) => loop.vert.co));
  if (!outline) return null;
  const { flat, tolerance } = outline;
  const at = (i: number) => flat[(i + count) % count];
  const free = loops.map((loop) => !fixed.has(loop.edge) && loop.edge.loops.length <= 2);
  const base = count + loops.filter((loop) => fixed.has(loop.edge)).length;

  interface Rung {
    side: number;
    /** How far along the side, from its first corner to its second. */
    along: number;
    reach: number;
  }

  const rungsFrom = (corner: number): Rung[] => {
    const from = at(corner);
    const rungs: Rung[] = [];
    for (let side = 0; side < count; side++) {
      if (!free[side] || side === corner || (side + 1) % count === corner) continue;
      const a = at(side);
      const b = at(side + 1);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const along = ((from.x - a.x) * dx + (from.y - a.y) * dy) / (dx * dx + dy * dy);
      if (along < 0.02 || along > 0.98) continue;
      const foot = { x: a.x + dx * along, y: a.y + dy * along };
      if (!inCone(at(corner - 1), from, at(corner + 1), foot, tolerance)) continue;
      let clear = true;
      for (let k = 0; k < count && clear; k++) {
        if (k === side || k === corner || (k + 1) % count === corner) continue;
        clear = !touches(from, foot, at(k), at(k + 1), tolerance);
      }
      if (clear) rungs.push({ side, along, reach: Math.hypot(foot.x - from.x, foot.y - from.y) });
    }
    return rungs.sort((one, two) => one.reach - two.reach).slice(0, RUNGS_PER_CORNER);
  };

  // Every inward corner picks one of its rungs, or none.
  let sets: Rung[][] = [[]];
  for (let corner = 0; corner < count; corner++) {
    if (turn(at(corner - 1), at(corner), at(corner + 1)) >= 0) continue;
    const options = rungsFrom(corner);
    sets = sets.flatMap((set) => [
      ...options
        .filter((rung) => !set.some((other) => other.side === rung.side))
        .map((rung) => [...set, rung]),
      set,
    ]);
  }
  // The sets that cut into more corners, and reach less doing it, go first.
  const reach = (set: readonly Rung[]) => set.reduce((total, rung) => total + rung.reach, 0);
  sets.sort((one, two) => two.length - one.length || reach(one) - reach(two));

  const attempts: Rung[][] = [];
  const midpoint = (side: number): Rung => ({ side, along: 0.5, reach: 0 });
  for (const set of sets) {
    const open = loops
      .map((_, side) => side)
      .filter((side) => free[side] && !set.some((rung) => rung.side === side));
    if ((base + set.length) % 2 === 1) {
      for (const side of open) attempts.push([...set, midpoint(side)]);
    } else if (set.length > 0) {
      attempts.push(set);
    } else {
      for (let i = 0; i < open.length; i++) {
        for (let j = i + 1; j < open.length; j++) {
          attempts.push([midpoint(open[i]), midpoint(open[j])]);
        }
      }
    }
  }

  let best: Splits | null = null;
  let top = -Infinity;
  for (const set of attempts.slice(0, RUNG_ATTEMPTS)) {
    const splits: Splits = new Map();
    for (const loop of loops) {
      const placed = fixed.get(loop.edge);
      if (placed !== undefined) splits.set(loop.edge, placed);
    }
    for (const { side, along } of set) {
      const loop = loops[side];
      splits.set(loop.edge, loop.vert === loop.edge.v0 ? along : 1 - along);
    }
    const cut = cutOf(face, loops, splits);
    const score = cut ? cutScore(cut) : -Infinity;
    if (score <= top) continue;
    top = score;
    best = new Map(
      set.map(({ side }) => [loops[side].edge, splits.get(loops[side].edge) as number]),
    );
  }
  return best;
}

/** Faces the mesh would hold after the cuts, counting a hard face at its most. */
function plannedFaces(mesh: BMesh, { hard, cuts }: Plan): number {
  let total = mesh.faces.size;
  for (const face of hard) total += 3 * mesh.faceLoopCount(face) - 1;
  for (const cut of cuts.values()) total += cutSize(cut) - 1;
  return total;
}

function between(a: Uv, b: Uv, t: number): Uv {
  return { u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t };
}

function halfway(a: Uv, b: Uv): Uv {
  return between(a, b, 0.5);
}

/** Splits the planned edges at their midpoints and cuts every face that changes into quads. */
function cutIntoQuads(mesh: BMesh, { splits, hard, cuts }: Plan): void {
  const middles = new Map<Edge, Vert>();
  for (const [edge, at] of splits) {
    middles.set(edge, mesh.addVert(lerp(edge.v0.co, edge.v1.co, at)));
  }

  const plans: { face: Face; rings: Corner[][] }[] = [];
  for (const face of mesh.faces.values()) {
    const loops = mesh.faceLoops(face);
    const ring: Corner[] = [];
    for (const loop of loops) {
      ring.push(cornerOf(loop));
      const middle = middles.get(loop.edge);
      if (!middle) continue;
      const at = splits.get(loop.edge) as number;
      const along = loop.vert === loop.edge.v0 ? at : 1 - at;
      ring.push({ vert: middle, uv: between(loop.uv, loop.next.uv, along) });
    }

    const cut = cuts.get(face);
    const quads = hard.has(face)
      ? splitHard(mesh, ring, loops.length)
      : cut
        ? buildCut(mesh, ring, cut)
        : null;
    // A face left uncut still takes the new points along its sides, or the
    // quads beside it would meet it with a gap.
    if (quads) plans.push({ face, rings: quads });
    else if (ring.length !== loops.length) plans.push({ face, rings: [ring] });
  }

  for (const { face, rings } of plans) replaceFaces(mesh, [face], rings);
  for (const [edge, middle] of middles) carrySharp(mesh, edge, [edge.v0, middle, edge.v1]);
}

/**
 * Cuts a hard face into quads the way a subdivision does: into convex pieces,
 * then one quad per corner of each piece, reaching from the middle of the two
 * sides beside it to the middle of the piece. Every side of the face was split
 * by the plan; the lines between pieces are split here, inside the face.
 */
function splitHard(mesh: BMesh, ring: readonly Corner[], count: number): Corner[][] | null {
  // Every side is split, so the ring runs corner, split, corner, split.
  if (ring.length !== 2 * count) return null;
  const corners = ring.filter((_, i) => i % 2 === 0);
  const points = corners.map((corner) => corner.vert.co);
  const pieces = convexPieces(points, polygonNormal(points));
  const covered = pieces.reduce(
    (sum, piece) => sum + polygonArea(piece.map((index) => points[index])),
    0,
  );
  // The pieces have to tile the face exactly, or the quads would leave a gap.
  if (pieces.length === 0 || Math.abs(covered - polygonArea(points)) > covered * 1e-6) return null;

  const inside = new Map<number, Corner>();
  const middleOf = (a: number, b: number): Corner => {
    if ((a + 1) % count === b) return ring[2 * a + 1];
    if ((b + 1) % count === a) return ring[2 * b + 1];
    const uv = halfway(corners[a].uv, corners[b].uv);
    const key = Math.min(a, b) * count + Math.max(a, b);
    let middle = inside.get(key);
    if (!middle) {
      middle = { vert: mesh.addVert(lerp(points[a], points[b], 0.5)), uv };
      inside.set(key, middle);
    }
    return middle;
  };

  const quads: Corner[][] = [];
  for (const piece of pieces) {
    const centre = {
      vert: mesh.addVert(centroid(piece.map((index) => points[index]))),
      uv: averageUv(piece.map((index) => corners[index].uv)),
    };
    for (let k = 0; k < piece.length; k++) {
      quads.push([
        middleOf(piece[(k - 1 + piece.length) % piece.length], piece[k]),
        corners[piece[k]],
        middleOf(piece[k], piece[(k + 1) % piece.length]),
        centre,
      ]);
    }
  }
  return quads;
}

function averageUv(uvs: readonly Uv[]): Uv {
  const total = { u: 0, v: 0 };
  for (const uv of uvs) {
    total.u += uv.u / uvs.length;
    total.v += uv.v / uvs.length;
  }
  return total;
}

/** A ring laid flat on its own plane, and the way back off it. */
interface Outline {
  flat: Point[];
  /** Closer to a line than this is on it. */
  tolerance: number;
  lift: (point: Point) => Vec3;
}

function flatten(points: readonly Vec3[]): Outline | null {
  const normal = polygonNormal(points);
  if (length(normal) === 0) return null;
  const { u, v } = basisFromNormal(normal);
  const flat = points.map((point) => ({ x: dot(point, u), y: dot(point, v) }));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of flat) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const scale = Math.max(maxX - minX, maxY - minY);
  if (scale === 0) return null;

  // Back off the plane through the middle of the ring rather than through the
  // origin, so a ring that is not quite flat gets its new points near it.
  const middle = centroid(points);
  const origin = { x: dot(middle, u), y: dot(middle, v) };
  const lift = (point: Point) =>
    add(middle, add(mul(u, point.x - origin.x), mul(v, point.y - origin.y)));

  return { flat, tolerance: scale * 1e-7, lift };
}

/**
 * How square a quad is: the sine of its least square corner, 1 for a
 * rectangle, 0 for a corner that runs straight on or folds back, and negative
 * for a corner that turns the wrong way.
 */
function quadQuality(a: Point, b: Point, c: Point, d: Point): number {
  return Math.min(turn(d, a, b), turn(a, b, c), turn(b, c, d), turn(c, d, a));
}

/**
 * The flattest a corner may be where a quad keeps it between the two sides
 * the ring already has there. Nothing short of cutting into a corner like that
 * can square it, and a finely divided circle turns less than three degrees at
 * each of its corners. A point a split put along a side is straight to the
 * last digit and stays out.
 */
const OWN_CORNER = Math.sin(degToRad(0.5));

function besideOnRing(outline: Outline, i: number, j: number): boolean {
  const gap = Math.abs(i - j);
  return gap === 1 || gap === outline.flat.length - 1;
}

/** The flattest a quad may be at ring corner `at`, between ring corners `before` and `after`. */
function floorAt(outline: Outline, before: number, at: number, after: number): number {
  return besideOnRing(outline, before, at) && besideOnRing(outline, at, after)
    ? OWN_CORNER
    : SLIVER;
}

/** How square a quad of ring corners is, or -Infinity if a corner is flatter than it may be. */
function ringQuadQuality(outline: Outline, quad: readonly number[]): number {
  let worst = 1;
  for (let k = 0; k < 4; k++) {
    const before = quad[(k + 3) % 4];
    const at = quad[k];
    const after = quad[(k + 1) % 4];
    const value = turn(outline.flat[before], outline.flat[at], outline.flat[after]);
    if (value < floorAt(outline, before, at, after)) return -Infinity;
    worst = Math.min(worst, value);
  }
  return worst;
}

function turn(from: Point, at: Point, to: Point): number {
  const ax = at.x - from.x;
  const ay = at.y - from.y;
  const bx = to.x - at.x;
  const by = to.y - at.y;
  // Not Math.hypot: this runs in the innermost loop of the cut search, and
  // hypot is several times slower than the plain root.
  const lengths = Math.sqrt((ax * ax + ay * ay) * (bx * bx + by * by));
  return lengths > 0 ? (ax * by - ay * bx) / lengths : -1;
}

/** How far `point` lies to the left of the line from `a` through `b`. */
function side(a: Point, b: Point, point: Point): number {
  const span = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
  if (span === 0) return 0;
  return ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) / span;
}

function within(a: Point, b: Point, point: Point, tolerance: number): boolean {
  return (
    point.x >= Math.min(a.x, b.x) - tolerance &&
    point.x <= Math.max(a.x, b.x) + tolerance &&
    point.y >= Math.min(a.y, b.y) - tolerance &&
    point.y <= Math.max(a.y, b.y) + tolerance
  );
}

/** Whether two segments cross or touch. */
function touches(a: Point, b: Point, c: Point, d: Point, tolerance: number): boolean {
  const abc = side(a, b, c);
  const abd = side(a, b, d);
  const cda = side(c, d, a);
  const cdb = side(c, d, b);
  const apart = (one: number, two: number) =>
    (one > tolerance && two < -tolerance) || (one < -tolerance && two > tolerance);
  if (apart(abc, abd) && apart(cda, cdb)) return true;
  return (
    (Math.abs(abc) <= tolerance && within(a, b, c, tolerance)) ||
    (Math.abs(abd) <= tolerance && within(a, b, d, tolerance)) ||
    (Math.abs(cda) <= tolerance && within(c, d, a, tolerance)) ||
    (Math.abs(cdb) <= tolerance && within(c, d, b, tolerance))
  );
}

/** Whether a line from the corner `at` toward `toward` starts off inside the ring. */
function inCone(
  previous: Point,
  at: Point,
  next: Point,
  toward: Point,
  tolerance: number,
): boolean {
  if (side(previous, at, next) >= -tolerance) {
    return side(at, toward, previous) > tolerance && side(toward, at, next) > tolerance;
  }
  return !(side(at, toward, next) >= -tolerance && side(toward, at, previous) >= -tolerance);
}

/** Whether positions `s` and `t` of a ring can be joined by a line inside it. */
function isDiagonal(outline: Outline, ring: readonly number[], s: number, t: number): boolean {
  const count = ring.length;
  const at = (k: number) => outline.flat[ring[(k + count) % count]];
  const { tolerance } = outline;
  const a = at(s);
  const b = at(t);
  if (!inCone(at(s - 1), a, at(s + 1), b, tolerance)) return false;
  if (!inCone(at(t - 1), b, at(t + 1), a, tolerance)) return false;

  for (let k = 0; k < count; k++) {
    const next = (k + 1) % count;
    if (k === s || k === t || next === s || next === t) continue;
    if (touches(a, b, at(k), at(next), tolerance)) return false;
  }
  return true;
}

/** Quads round a point in the middle of a ring: one per pair of its sides. */
interface Star {
  score: number;
  centre: Point;
  /** Whether the spokes run to the even corners of the ring or the odd ones. */
  offset: number;
}

function areaCentroid(points: readonly Point[]): Point | null {
  let area = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  return area > 0 ? { x: x / (3 * area), y: y / (3 * area) } : null;
}

function averageOf(points: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/**
 * How square each quad of a star comes out, round `centre` with spokes from
 * `offset`, at the three corners that move with the middle: either side of
 * its spokes, and the middle itself. The fourth is the ring's own.
 */
function spokeQualities(points: readonly Point[], centre: Point, offset: number): number[] {
  const count = points.length;
  const qualities: number[] = [];
  for (let k = offset; k < count + offset; k += 2) {
    const from = points[k % count];
    const middle = points[(k + 1) % count];
    const to = points[(k + 2) % count];
    qualities.push(
      Math.min(turn(centre, from, middle), turn(middle, to, centre), turn(to, centre, from)),
    );
  }
  return qualities;
}

const COMPASS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Walks a star's middle toward wherever its least square quad is squarest,
 * in steps that halve whenever no direction helps.
 */
function searchCentre(
  points: readonly Point[],
  from: Point,
  offset: number,
  size: number,
  ceiling: number,
): Point {
  let at = from;
  let worst = Math.min(...spokeQualities(points, at, offset));
  let step = size / 4;
  for (let guard = 0; guard < 60 && step > size * 5e-3 && worst < ceiling; guard++) {
    let moved = false;
    for (const [dx, dy] of COMPASS) {
      const next = { x: at.x + dx * step, y: at.y + dy * step };
      const value = Math.min(...spokeQualities(points, next, offset));
      if (value <= worst) continue;
      at = next;
      worst = value;
      moved = true;
    }
    if (!moved) step /= 2;
  }
  return at;
}

/**
 * The squarest way to fan a ring into quads round one new point, or null if
 * no point tried sees the whole ring.
 *
 * The spokes run to every other corner. Run to the points a split put along a
 * side, they leave the real corners as the tips of the quads, which is how a
 * triangle with all three sides split comes back as three quads.
 */
function bestStar(outline: Outline, ring: readonly number[]): Star | null {
  const count = ring.length;
  const points = ring.map((index) => outline.flat[index]);
  let centres: Point[] | null = null;

  let best: Star | null = null;
  for (const offset of [0, 1]) {
    // The corners between the spokes keep the angle the ring gives them
    // wherever the middle goes: one too flat rules the star out, and the
    // flattest is as square as the star can get.
    const kept: number[] = [];
    for (let k = offset; k < count + offset; k += 2) {
      const [before, at, after] = [k, k + 1, k + 2].map((i) => ring[i % count]);
      const value = turn(outline.flat[before], outline.flat[at], outline.flat[after]);
      kept.push(value < floorAt(outline, before, at, after) ? -Infinity : value);
    }
    const ceiling = Math.min(...kept);
    if (ceiling === -Infinity) continue;

    centres ??= [
      averageOf(points),
      areaCentroid(points),
      averageOf(points.filter((_, i) => i % 2 === 0)),
      averageOf(points.filter((_, i) => i % 2 === 1)),
    ].filter((centre): centre is Point => centre !== null);
    let top = centres[0];
    let worst = -Infinity;
    for (const centre of centres) {
      const value = Math.min(...spokeQualities(points, centre, offset));
      if (value > worst) {
        top = centre;
        worst = value;
      }
    }
    if (count <= STAR_SEARCH_LIMIT && worst < ceiling) {
      let size = 0;
      for (const point of points) {
        size = Math.max(size, Math.sqrt((point.x - top.x) ** 2 + (point.y - top.y) ** 2));
      }
      top = searchCentre(points, top, offset, size, ceiling);
    }

    const moving = spokeQualities(points, top, offset);
    if (Math.min(...moving) < SLIVER) continue;
    const score = moving.reduce(
      (total, quality, k) => total + Math.log(Math.min(quality, kept[k])),
      0,
    );
    if (score > (best?.score ?? -Infinity)) best = { score, centre: top, offset };
  }
  return best;
}

/** One piece a ring is cut into: a quad of its own corners, or a star round a new point. */
interface Piece {
  corners: number[];
  star?: Star;
}

const NONE = -1;
const STAR = -2;

/**
 * The best way to cut a ring into quads, as pieces, or null if there is none.
 *
 * Every quad of a cut ring has one side on the line that closed it off from the
 * rest, so the cut is built up from smaller stretches of the ring: the best cut
 * of the stretch from corner `s` to corner `t` is the best quad on the line
 * between them plus the best cuts of the three stretches that quad leaves, or
 * a star over the whole stretch. Scored by the sum of the logs of each quad's
 * squareness, so one bad quad costs more than several good ones gain.
 */
function cutExactly(outline: Outline, ring: readonly number[]): Piece[] | null {
  const count = ring.length;
  const known = new Int8Array(count * count);
  const open = (s: number, t: number) => {
    if (t - s === 1 || (s === 0 && t === count - 1)) return true;
    const key = s * count + t;
    if (known[key] === 0) known[key] = isDiagonal(outline, ring, s, t) ? 1 : 2;
    return known[key] === 1;
  };

  const best = new Float64Array(count * count).fill(-Infinity);
  const choice = new Int32Array(count * count).fill(NONE);
  const stars = new Map<number, Star>();
  for (let s = 0; s + 1 < count; s++) best[s * count + s + 1] = 0;

  for (let gap = 3; gap < count; gap += 2) {
    for (let s = 0; s + gap < count; s++) {
      const t = s + gap;
      if (!open(s, t)) continue;
      let top = -Infinity;
      let pick = NONE;

      for (let a = s + 1; a < t; a += 2) {
        const before = best[s * count + a];
        if (before === -Infinity) continue;
        for (let b = a + 1; b < t; b += 2) {
          const inside = best[a * count + b];
          const after = best[b * count + t];
          if (inside === -Infinity || after === -Infinity) continue;
          const quality = ringQuadQuality(outline, [ring[s], ring[a], ring[b], ring[t]]);
          if (quality === -Infinity) continue;
          const score = Math.log(quality) + before + inside + after;
          if (score > top) {
            top = score;
            pick = a * count + b;
          }
        }
      }

      if (gap >= 5) {
        const star = bestStar(outline, ring.slice(s, t + 1));
        if (star && star.score + STAR_PENALTY > top) {
          top = star.score + STAR_PENALTY;
          pick = STAR;
          stars.set(s * count + t, star);
        }
      }

      best[s * count + t] = top;
      choice[s * count + t] = pick;
    }
  }

  if (best[count - 1] === -Infinity) return null;

  const pieces: Piece[] = [];
  const collect = (s: number, t: number) => {
    if (t - s === 1) return;
    const pick = choice[s * count + t];
    if (pick === STAR) {
      pieces.push({ corners: ring.slice(s, t + 1), star: stars.get(s * count + t) });
      return;
    }
    const a = Math.floor(pick / count);
    const b = pick % count;
    pieces.push({ corners: [ring[s], ring[a], ring[b], ring[t]] });
    collect(s, a);
    collect(a, b);
    collect(b, t);
  };
  collect(0, count - 1);
  return pieces;
}

/**
 * Cuts a ring too long for the exact search across its middle, along the line
 * that leaves the squarest corners at both ends, as two rings of even length.
 */
function halve(outline: Outline, ring: readonly number[]): [number[], number[]] | null {
  const count = ring.length;
  const at = (k: number) => outline.flat[ring[(k + count) % count]];
  const half = count / 2;

  let top = -Infinity;
  let cut: [number, number] | null = null;
  for (let s = 0; s < count; s++) {
    for (let gap = half - 7; gap <= half + 7; gap++) {
      if (gap % 2 === 0 || gap < 3 || gap > count - 3) continue;
      const t = (s + gap) % count;
      const corners = Math.min(
        turn(at(s - 1), at(s), at(t)),
        turn(at(t), at(s), at(s + 1)),
        turn(at(s), at(t), at(t + 1)),
        turn(at(t - 1), at(t), at(s)),
      );
      const score = corners - Math.abs(gap - half) / count;
      if (score <= top || corners < SLIVER) continue;
      if (!isDiagonal(outline, ring, Math.min(s, t), Math.max(s, t))) continue;
      top = score;
      cut = [s, t];
    }
  }
  if (!cut) return null;

  const [s, t] = cut;
  const one: number[] = [];
  const two: number[] = [];
  for (let k = s; k !== t; k = (k + 1) % count) one.push(ring[k]);
  one.push(ring[t]);
  for (let k = t; k !== s; k = (k + 1) % count) two.push(ring[k]);
  two.push(ring[s]);
  return [one, two];
}

function cutRing(outline: Outline, ring: readonly number[]): Piece[] | null {
  if (ring.length <= EXACT_LIMIT) return cutExactly(outline, ring);
  const halves = halve(outline, ring);
  if (!halves) return null;
  const one = cutRing(outline, halves[0]);
  const two = one && cutRing(outline, halves[1]);
  return one && two ? [...one, ...two] : null;
}

/** How a ring of corners, split ones included, is cut into quads. */
interface Cut {
  outline: Outline;
  pieces: Piece[];
}

/** How to cut a ring into quads, or null if it has no cut. */
function planCut(points: readonly Vec3[]): Cut | null {
  if (points.length % 2 === 1 || points.length < 4) return null;
  const outline = flatten(points);
  if (!outline) return null;
  const pieces = cutRing(
    outline,
    points.map((_, i) => i),
  );
  return pieces ? { outline, pieces } : null;
}

/** A planned cut scored the way the search that found it scores one. */
function cutScore({ outline, pieces }: Cut): number {
  let score = 0;
  for (const { corners, star } of pieces) {
    if (star) {
      score += star.score + STAR_PENALTY;
      continue;
    }
    score += Math.log(ringQuadQuality(outline, corners));
  }
  return score;
}

function cutSize({ pieces }: Cut): number {
  return pieces.reduce((total, { corners, star }) => total + (star ? corners.length / 2 : 1), 0);
}

/** Builds a planned cut out of the ring it was planned on, adding the stars' middles. */
function buildCut(mesh: BMesh, ring: readonly Corner[], { outline, pieces }: Cut): Corner[][] {
  const quads: Corner[][] = [];
  for (const { corners, star } of pieces) {
    if (!star) {
      quads.push(corners.map((index) => ring[index]));
      continue;
    }
    const centre: Corner = {
      vert: mesh.addVert(outline.lift(star.centre)),
      uv: averageUv(corners.map((index) => ring[index].uv)),
    };
    for (let k = star.offset; k < corners.length + star.offset; k += 2) {
      quads.push([
        ring[corners[k % corners.length]],
        ring[corners[(k + 1) % corners.length]],
        ring[corners[(k + 2) % corners.length]],
        centre,
      ]);
    }
  }
  return quads;
}
