import {
  type Vec3,
  add,
  addScaled,
  basisFromNormal,
  centroid,
  clamp,
  cross,
  distanceSq,
  dot,
  length,
  lerp,
  mul,
  normalize,
  polygonArea,
  polygonNormal,
  sub,
  vec3,
} from '../math';
import type { BMesh } from '../mesh';
import { triangulatePolygon } from '../mesh';
import type { Edge, Face, Loop, Vert } from '../mesh/types';

export interface SubdivideOptions {
  /** Cuts taken out of every edge: 1 leaves a quad as four, 3 as sixteen. */
  cuts?: number;
  /** 0 keeps the cage, 1 pulls new points onto the Catmull-Clark limit points. */
  smooth?: number;
}

/**
 * Catmull-Clark style subdivision of the selected faces.
 *
 * One pass, however many cuts: a quad comes back as a grid of (cuts + 1) by
 * (cuts + 1), which is what a count of cuts reads as everywhere else. Running
 * the one-cut scheme `cuts` times instead (which is what this used to do)
 * cuts every edge two to the power of it, so four asked for came back as
 * sixteen.
 *
 * At a single cut it is exactly Catmull-Clark, which is what the modifier
 * stacks a level at a time: a quad becomes four, a face of any other shape
 * becomes one quad per corner around its face point, and `smooth` blends the
 * new points onto the limit surface.
 *
 * Faces bordering the selection keep their shape but gain the new edge points,
 * so the mesh stays watertight.
 */
export function subdivideFaces(
  mesh: BMesh,
  faces: readonly Face[],
  options: SubdivideOptions = {},
): Face[] {
  const cuts = Math.max(1, Math.floor(options.cuts ?? 1));
  const smooth = clamp(options.smooth ?? 0, 0, 1);
  return subdividePass(mesh, faces, cuts, smooth);
}

/**
 * Splits each edge, adding `cuts` evenly spaced vertices along it.
 *
 * The vertices cannot just be dropped onto the edge: a face's ring is its own
 * list of corners, so every face touching a split edge is rebuilt with the new
 * points spliced into its ring. Without that the face would still span the old
 * corners and the new vertex would sit on a seam that nothing references.
 */
export function subdivideEdges(mesh: BMesh, edges: readonly Edge[], cuts = 1): Vert[] {
  const count = Math.max(1, Math.floor(cuts));
  const live = edges.filter((edge) => mesh.edges.has(edge.id));
  if (live.length === 0) return [];

  // Points are stored running v0 -> v1, the edge's own direction.
  const points = new Map<number, Vert[]>();
  const created: Vert[] = [];
  for (const edge of live) {
    const inserted: Vert[] = [];
    for (let i = 1; i <= count; i++) {
      inserted.push(mesh.addVert(lerp(edge.v0.co, edge.v1.co, i / (count + 1))));
    }
    points.set(edge.id, inserted);
    created.push(...inserted);
  }

  const affected = new Map<number, Face>();
  for (const edge of live) {
    for (const face of mesh.edgeFaces(edge)) affected.set(face.id, face);
  }

  interface RingSpec {
    ring: Vert[];
    materialIndex: number;
    smooth: boolean;
  }
  const specs: RingSpec[] = [];
  for (const face of affected.values()) {
    const ring: Vert[] = [];
    for (const loop of mesh.faceLoops(face)) {
      ring.push(loop.vert);
      const inserted = points.get(loop.edge.id);
      if (!inserted) continue;
      // A loop traverses its edge from loop.vert onwards, which is v1 -> v0 for
      // half the faces sharing it, so those need the points in reverse.
      ring.push(...(loop.edge.v0 === loop.vert ? inserted : [...inserted].reverse()));
    }
    specs.push({ ring, materialIndex: face.materialIndex, smooth: face.smooth });
  }

  const stale = new Set<Edge>();
  for (const face of affected.values()) {
    for (const edge of mesh.faceEdges(face)) stale.add(edge);
    mesh.removeFace(face);
  }

  for (const spec of specs) {
    if (spec.ring.length < 3) continue;
    mesh.addFace(spec.ring, { materialIndex: spec.materialIndex, smooth: spec.smooth });
  }

  // A wire edge has no face to rebuild, so its own segments are chained instead.
  for (const edge of live) {
    if (!mesh.edges.has(edge.id) || edge.loops.length > 0) continue;
    const chain = [edge.v0, ...(points.get(edge.id) ?? []), edge.v1];
    mesh.removeEdge(edge);
    for (let i = 0; i < chain.length - 1; i++) mesh.addEdge(chain[i], chain[i + 1]);
  }

  for (const edge of stale) {
    if (mesh.edges.has(edge.id) && edge.loops.length === 0) mesh.removeEdge(edge);
  }

  for (const vert of created) vert.selected = true;
  mesh.computeNormals();
  return created;
}

/**
 * How far the quads fanned off a face may overshoot it and still be a fan.
 *
 * Relative, and only there to absorb the arithmetic: the sums it compares are
 * equal exactly when the fan tiles the face, so anything above rounding is a
 * real fold.
 */
const FAN_SLACK = 1e-6;

/**
 * Whether the quads fanned off a face's corners tile it, given that centre.
 *
 * Subdivision turns each corner into a quad reaching back to a point in the
 * middle of the face, and those quads cover the face exactly when the point can
 * see every edge of it: when every triangle from the point out to an edge
 * turns the same way.
 *
 * Summed with their signs those triangles come to the face's own area wherever
 * the point is put; summed without them they come to more the moment one folds
 * back. The difference is ground the fan covers twice and the face does not
 * cover at all, which is what a boolean's ring of surface around a hole turns
 * into: a starburst across the hole where a wall should be.
 */
function fansCleanly(points: readonly Vec3[], centre: Vec3): boolean {
  if (points.length < 4) return true;

  const normal = normalize(polygonNormal(points));
  let spread = 0;
  let net = 0;

  for (let i = 0; i < points.length; i++) {
    const reach = dot(
      normal,
      cross(sub(points[i], centre), sub(points[(i + 1) % points.length], centre)),
    );
    spread += Math.abs(reach);
    net += reach;
  }

  return spread <= Math.abs(net) * (1 + FAN_SLACK);
}

/**
 * The point a face is subdivided around.
 *
 * Catmull-Clark says the average of the corners, and that is what is used
 * wherever it works, which is every face that is anywhere near convex. A face
 * left around a hole is not: its corners crowd the rim, so their average is
 * dragged into the hole, off the surface altogether. Weighting by area follows
 * the material instead of the crowd, and is the best point available even for
 * the faces that cannot be fanned from anywhere.
 */
function facePointOf(mesh: BMesh, face: Face): Vec3 {
  const points = mesh.facePoints(face);
  const average = centroid(points);
  if (fansCleanly(points, average)) return average;

  const indices = triangulatePolygon(points, polygonNormal(points));
  let weighted = vec3();
  let total = 0;

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const triangle = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
    const area = polygonArea(triangle);
    weighted = add(weighted, mul(centroid(triangle), area));
    total += area;
  }

  return total > 0 ? mul(weighted, 1 / total) : average;
}

/** A point on the plane a face lies in. */
interface Flat {
  x: number;
  y: number;
}

/** How square a triangle is: 1 for equilateral, towards 0 for a sliver. */
function triangleQuality(a: Flat, b: Flat, c: Flat): number {
  const twice = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const sides =
    (b.x - a.x) ** 2 +
    (b.y - a.y) ** 2 +
    (c.x - b.x) ** 2 +
    (c.y - b.y) ** 2 +
    (a.x - c.x) ** 2 +
    (a.y - c.y) ** 2;
  return sides === 0 ? 0 : (2 * Math.sqrt(3) * Math.abs(twice)) / sides;
}

function insideTriangle(p: Flat, a: Flat, b: Flat, c: Flat): boolean {
  const side = (u: Flat, v: Flat) => (v.x - u.x) * (p.y - u.y) - (v.y - u.y) * (p.x - u.x);
  const one = side(a, b);
  const two = side(b, c);
  const three = side(c, a);
  return !((one < 0 || two < 0 || three < 0) && (one > 0 || two > 0 || three > 0));
}

/**
 * Triangulates a ring by clipping the squarest ear available, not the first one.
 *
 * The order ears come off in decides the shape of what is left behind. Taking
 * the first one that fits (which is all a triangulation for drawing needs)
 * walks around the ring peeling slivers off the same corner, and leaves every
 * diagonal meeting there: a fan, whose hub carries one vertex of enormous
 * valence. Subdivision reads that hub as an extraordinary point and pinches the
 * surface into a funnel around it, which is what a bored face came back as.
 *
 * Taking the squarest ear each time spreads the diagonals around the ring
 * instead. It is the same triangulation problem answered with a Delaunay-ish
 * preference, and it costs a sweep of the ring per ear.
 */
function squarestEars(flat: readonly Flat[]): number[][] {
  const ring = flat.map((_, index) => index);
  let doubled = 0;
  for (let i = 0; i < flat.length; i++) {
    const a = flat[i];
    const b = flat[(i + 1) % flat.length];
    doubled += a.x * b.y - b.x * a.y;
  }
  const facing = Math.sign(doubled) || 1;

  const pieces: number[][] = [];
  for (let guard = ring.length * ring.length + 16; ring.length > 3 && guard > 0; guard--) {
    let clip = -1;
    let best = -Infinity;

    for (let i = 0; i < ring.length; i++) {
      const a = flat[ring[(i - 1 + ring.length) % ring.length]];
      const b = flat[ring[i]];
      const c = flat[ring[(i + 1) % ring.length]];
      const turn = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (turn * facing <= 0) continue;

      let clear = true;
      for (let k = 0; k < ring.length && clear; k++) {
        const other = (i - 1 + ring.length) % ring.length;
        if (k === i || k === other || k === (i + 1) % ring.length) continue;
        if (insideTriangle(flat[ring[k]], a, b, c)) clear = false;
      }
      if (!clear) continue;

      const quality = triangleQuality(a, b, c);
      if (quality > best) {
        best = quality;
        clip = i;
      }
    }
    if (clip < 0) break;

    pieces.push([
      ring[(clip - 1 + ring.length) % ring.length],
      ring[clip],
      ring[(clip + 1) % ring.length],
    ]);
    ring.splice(clip, 1);
  }

  if (ring.length === 3) pieces.push([ring[0], ring[1], ring[2]]);
  return pieces;
}

/** Whether a flattened ring turns the same way at every corner. */
function isConvex(ring: readonly Flat[]): boolean {
  let facing = 0;

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const c = ring[(i + 2) % ring.length];
    const turn = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(turn) < 1e-12) continue;
    const way = Math.sign(turn);
    if (facing === 0) facing = way;
    else if (way !== facing) return false;
  }

  return true;
}

/**
 * Joins two rings along the edge they share, or null if they do not share one.
 *
 * The two traverse it in opposite directions, being consistently wound, so the
 * join is one walk of each with the shared edge itself stepped over.
 */
function weldRings(left: number[], right: number[], from: number, to: number): number[] | null {
  const at = (ring: number[], a: number, b: number) =>
    ring.findIndex((_, i) => ring[i] === a && ring[(i + 1) % ring.length] === b);

  const li = at(left, from, to);
  const ri = at(right, to, from);
  if (li < 0 || ri < 0) return null;

  const joined: number[] = [];
  for (let k = 1; k <= left.length; k++) joined.push(left[(li + k) % left.length]);
  for (let k = 2; k < right.length; k++) joined.push(right[(ri + k) % right.length]);
  return joined;
}

/**
 * Cuts a ring into convex pieces, as index rings into `points`.
 *
 * Ear clipping first, then the diagonals it drew are taken back out wherever
 * the two pieces either side of one make a convex piece together, Hertel and
 * Mehlhorn's decomposition. What comes out is a handful of convex pieces rather
 * than a fan of slivers, which is what the subdivision downstream wants: a
 * convex piece is seen whole from its own middle, so the quads fanned off its
 * corners tile it and nothing sweeps across the hole the face went round.
 */
function convexPieces(points: readonly Vec3[], normal: Vec3): number[][] {
  const { u, v } = basisFromNormal(normalize(normal));
  const flat = points.map((point) => ({ x: dot(point, u), y: dot(point, v) }));

  const pieces: (number[] | null)[] = squarestEars(flat);
  if (pieces.length === 0) return [];

  // The ring's own edges are the face's outline and are never dissolved; only
  // the diagonals the ear clipper drew are up for removal.
  const spanKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const outline = new Set<string>();
  for (let i = 0; i < points.length; i++) outline.add(spanKey(i, (i + 1) % points.length));

  for (let guard = 0; guard < pieces.length * 3; guard++) {
    const shared = new Map<string, number[]>();
    pieces.forEach((piece, index) => {
      if (!piece) return;
      for (let i = 0; i < piece.length; i++) {
        const span = spanKey(piece[i], piece[(i + 1) % piece.length]);
        if (outline.has(span)) continue;
        const held = shared.get(span);
        if (held) held.push(index);
        else shared.set(span, [index]);
      }
    });

    let dissolved = false;
    for (const [span, sides] of shared) {
      if (sides.length !== 2) continue;
      const left = pieces[sides[0]];
      const right = pieces[sides[1]];
      if (!left || !right) continue;

      const [a, b] = span.split(':').map(Number);
      const joined = weldRings(left, right, a, b) ?? weldRings(left, right, b, a);
      if (!joined || !isConvex(joined.map((index) => flat[index]))) continue;

      pieces[sides[0]] = joined;
      pieces[sides[1]] = null;
      dissolved = true;
      break;
    }
    if (!dissolved) break;
  }

  return pieces.filter((piece): piece is number[] => piece !== null && piece.length >= 3);
}

/**
 * How square a ring is: 1 for a circle, about 0.79 for a square, 0 for a sliver.
 */
function plumpness(points: readonly Vec3[]): number {
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    perimeter += Math.sqrt(distanceSq(points[i], points[(i + 1) % points.length]));
  }
  return perimeter === 0 ? 0 : (4 * Math.PI * polygonArea(points)) / perimeter ** 2;
}

/**
 * How much thinner than the face itself its pieces may come out.
 *
 * Cutting a face up is only worth doing if what it leaves is something
 * subdivision can work with. A wall with a small bore out of it comes apart
 * into pieces about a third as square as the wall was, and subdividing those
 * holds the shape. A wall with a large ragged hole comes apart into splinters a
 * fortieth as square, and subdividing those folds the wall into fins, worse
 * than never having cut it. The two are an order of magnitude apart, and this
 * sits between them.
 */
const PIECE_PLUMPNESS_FLOOR = 0.1;

/**
 * Cuts a face into convex pieces in the mesh, and hands back what replaced it.
 *
 * Returns the face untouched when it was already one piece, when the cut would
 * have lost part of it, or when the pieces come out as splinters.
 */
function openFace(mesh: BMesh, face: Face): Face[] {
  const verts = mesh.faceVerts(face);
  const points = verts.map((vert) => vert.co);
  const rings = convexPieces(points, polygonNormal(points));
  if (rings.length < 2) return [face];

  const covered = rings.reduce(
    (sum, ring) => sum + polygonArea(ring.map((index) => points[index])),
    0,
  );
  if (Math.abs(covered - polygonArea(points)) > polygonArea(points) * FAN_SLACK) return [face];

  const scores = rings
    .map((ring) => plumpness(ring.map((index) => points[index])))
    .sort((a, b) => a - b);
  const middling = scores[Math.floor(scores.length / 2)];
  if (middling < plumpness(points) * PIECE_PLUMPNESS_FLOOR) return [face];

  const { materialIndex, smooth } = face;
  mesh.removeFace(face);
  return rings.map((ring) =>
    mesh.addFace(
      ring.map((index) => verts[index]),
      { materialIndex, smooth },
    ),
  );
}

/**
 * Whether the outline turns at a vertex, or merely runs through it.
 *
 * Subdividing one face leaves the faces around it carrying vertices along the
 * shared edges: still square, no longer quads by their vertex count. Reading
 * where the outline actually turns is what lets the next subdivision cut them
 * like the squares they are, rather than fanning a sliver off every vertex.
 */
const COLLINEAR = 1e-3;

function turnsAt(previous: Vec3, at: Vec3, next: Vec3): boolean {
  const into = sub(at, previous);
  const away = sub(next, at);
  const reach = length(into) * length(away);
  if (reach === 0) return true;
  return length(cross(into, away)) / reach > COLLINEAR || dot(into, away) < 0;
}

/** A face's outline, grouped into the sides between the corners it turns at. */
interface Outline {
  sides: Loop[][];
  /** Four corners: cut into a grid. Anything else: one quad per corner. */
  grid: boolean;
}

function outlineOf(mesh: BMesh, face: Face): Outline | null {
  const loops = mesh.faceLoops(face);
  const count = loops.length;
  if (count < 3) return null;

  const corners: number[] = [];
  for (let i = 0; i < count; i++) {
    const previous = loops[(i - 1 + count) % count].vert.co;
    const next = loops[(i + 1) % count].vert.co;
    if (turnsAt(previous, loops[i].vert.co, next)) corners.push(i);
  }
  if (corners.length < 3) return null;

  const sides: Loop[][] = [];
  for (let c = 0; c < corners.length; c++) {
    const until = corners[(c + 1) % corners.length];
    const run: Loop[] = [];
    for (let i = corners[c]; i !== until; i = (i + 1) % count) run.push(loops[i]);
    sides.push(run);
  }

  return { sides, grid: sides.length === 4 };
}

/** Cuts each edge of a side takes so the side reaches about the asked spacing. */
function cutsPerEdge(side: readonly Loop[], cuts: number): number {
  return Math.max(0, Math.ceil((cuts + 1) / side.length) - 1);
}

/** Segments a side ends up carrying once the planned cuts are made. */
function sideSegments(side: readonly Loop[], splits: ReadonlyMap<Edge, number>): number {
  return side.reduce((total, loop) => total + (splits.get(loop.edge) ?? 0) + 1, 0);
}

/** Whether this subdivision cut into a side, as against it already being long. */
function sideCut(side: readonly Loop[], splits: ReadonlyMap<Edge, number>): boolean {
  return side.some((loop) => (splits.get(loop.edge) ?? 0) > 0);
}

/**
 * Every edge a subdivision cuts, and how many times.
 *
 * The faces ask first: each side of a selected face is cut to about the spacing
 * asked for, and a side already finer than that is left as it is rather than
 * cut finer still. Then every cut runs. An edge cut n times hands the same n to
 * the edge across from it in whatever quad it passes into, and that edge to the
 * next, so a cut travels the ring it belongs to until the ring closes or meets
 * a face that is not a quad, which is where it ends.
 *
 * That travelling is what keeps the mesh in quads. A cut that stopped at the
 * edge of the selection would leave the face beside it carrying a vertex in the
 * middle of one side, and the next subdivision of that face has nowhere to put
 * a matching cut: the dead end where subdividing the face next to a subdivided
 * one did nothing at all.
 */
function planCuts(
  mesh: BMesh,
  outlines: ReadonlyMap<number, Outline>,
  cuts: number,
): Map<Edge, number> {
  const splits = new Map<Edge, number>();
  const queue: Edge[] = [];

  const demand = (edge: Edge, count: number) => {
    if (count < 1 || (splits.get(edge) ?? 0) >= count) return;
    splits.set(edge, count);
    queue.push(edge);
  };

  for (const outline of outlines.values()) {
    for (const side of outline.sides) demand_side(side);
  }

  function demand_side(side: Loop[]) {
    const count = cutsPerEdge(side, cuts);
    for (const loop of side) demand(loop.edge, count);
  }

  while (queue.length > 0) {
    const edge = queue.pop() as Edge;
    const count = splits.get(edge) ?? 0;

    for (const face of mesh.edgeFaces(edge)) {
      const loops = mesh.faceLoops(face);
      // Only a plain quad has an edge straight across from this one. Anything
      // else is a face the ring runs into and stops at.
      if (loops.length !== 4) continue;
      const entry = loops.find((loop) => loop.edge === edge);
      if (entry) demand(entry.next.next.edge, count);
    }
  }

  return splits;
}

/**
 * How many cells a face is cut into, across and down.
 *
 * The spacing asked for, but never finer than the sides can carry: every corner
 * of a cell has to land on a vertex the outline already has, or the cell next
 * to it hangs off nothing. A face keeping a row of vertices along one side is
 * cut as coarsely as the plain side facing it, and the cells along the crowded
 * side simply take several of its vertices each.
 *
 * A direction nothing was cut into stays one cell across, which is what makes a
 * face the loop only passes through come back as a strip rather than a grid.
 */
function faceDimensions(
  outline: Outline,
  splits: ReadonlyMap<Edge, number>,
  cuts: number,
  selected: boolean,
): [number, number] {
  const segments = outline.sides.map((side) => sideSegments(side, splits));

  if (!outline.grid) {
    // The ring ends at a face like this; only a selected one is cut up, and
    // only in twos, since the quads are fanned off a point halfway along each
    // side.
    if (!selected) return [1, 1];
    const even = Math.min(cuts + 1, ...segments) & ~1;
    return even >= 2 ? [even, even] : [1, 1];
  }

  const live = outline.sides.map((side) => sideCut(side, splits));
  const across = selected || live[0] || live[2] ? Math.min(cuts + 1, segments[0], segments[2]) : 1;
  const down = selected || live[1] || live[3] ? Math.min(cuts + 1, segments[1], segments[3]) : 1;
  return [across, down];
}

/** Cells a face comes apart into, for costing a subdivision before running it. */
function cellCount(outline: Outline, dimensions: [number, number]): number {
  const [across, down] = dimensions;
  if (outline.grid) return across * down;
  return across < 2 ? 1 : outline.sides.length * (across / 2) ** 2;
}

/**
 * Where a polyline of `segments` is cut to leave `parts` runs of it.
 *
 * Indices into the polyline, evenly spread and always landing on a vertex it
 * already has. `parts` never exceeds `segments`, so no two land together.
 */
function runBounds(segments: number, parts: number): number[] {
  const bounds: number[] = [];
  for (let i = 0; i <= parts; i++) bounds.push(Math.round((i * segments) / parts));
  return bounds;
}

/**
 * A point inside a patch, from its four boundaries: Coons interpolation.
 *
 * The two rulings between facing boundaries, less the bilinear surface through
 * the corners they share, which each of them already carries. A flat patch with
 * straight sides comes back as an even grid; one whose boundary was bowed by
 * smoothing comes back following it rather than cutting the corner.
 */
function coonsPoint(
  bottom: Vec3,
  top: Vec3,
  left: Vec3,
  right: Vec3,
  corners: readonly Vec3[],
  u: number,
  v: number,
): Vec3 {
  const rulings = add(add(mul(bottom, 1 - v), mul(top, v)), add(mul(left, 1 - u), mul(right, u)));
  const span = add(
    add(mul(corners[0], (1 - u) * (1 - v)), mul(corners[1], u * (1 - v))),
    add(mul(corners[2], u * v), mul(corners[3], (1 - u) * v)),
  );
  return sub(rulings, span);
}

/**
 * Fills a four-sided patch with cells, as rings ready to be added.
 *
 * The boundaries run bottom `C0 -> C1`, right `C1 -> C2`, top `C3 -> C2` and
 * left `C0 -> C3`, and each is shared out among the cells along it: a boundary
 * carrying more vertices than there are cells gives several to each, so those
 * cells come back as squares with vertices along one edge rather than as
 * anything the grid has to bend to accommodate.
 *
 * `middle` overrides the one interior point of a two-by-two patch: that is the
 * Catmull-Clark case, where the point is the face point and nothing else.
 */
function gridRings(
  mesh: BMesh,
  bottom: readonly Vert[],
  right: readonly Vert[],
  top: readonly Vert[],
  left: readonly Vert[],
  across: number,
  down: number,
  middle: Vec3 | null,
): Vert[][] {
  const alongBottom = runBounds(bottom.length - 1, across);
  const alongTop = runBounds(top.length - 1, across);
  const alongLeft = runBounds(left.length - 1, down);
  const alongRight = runBounds(right.length - 1, down);
  const corners = [bottom[0].co, bottom[bottom.length - 1].co, top[top.length - 1].co, top[0].co];

  const node: Vert[][] = [];
  for (let i = 0; i <= across; i++) {
    const column: Vert[] = [];
    for (let j = 0; j <= down; j++) {
      if (j === 0) column.push(bottom[alongBottom[i]]);
      else if (j === down) column.push(top[alongTop[i]]);
      else if (i === 0) column.push(left[alongLeft[j]]);
      else if (i === across) column.push(right[alongRight[j]]);
      else if (middle && across === 2 && down === 2) column.push(mesh.addVert(middle));
      else {
        column.push(
          mesh.addVert(
            coonsPoint(
              bottom[alongBottom[i]].co,
              top[alongTop[i]].co,
              left[alongLeft[j]].co,
              right[alongRight[j]].co,
              corners,
              i / across,
              j / down,
            ),
          ),
        );
      }
    }
    node.push(column);
  }

  /** One side of a cell, without its far end: a run of the boundary or a step. */
  const walk = (
    boundary: readonly Vert[],
    bounds: readonly number[],
    at: number,
    onEdge: boolean,
    reverse: boolean,
    from: Vert,
  ): Vert[] => {
    if (!onEdge) return [from];
    const run = boundary.slice(bounds[at], bounds[at + 1] + 1);
    if (reverse) run.reverse();
    return run.slice(0, -1);
  };

  const rings: Vert[][] = [];
  for (let i = 0; i < across; i++) {
    for (let j = 0; j < down; j++) {
      rings.push([
        ...walk(bottom, alongBottom, i, j === 0, false, node[i][j]),
        ...walk(right, alongRight, j, i === across - 1, false, node[i + 1][j]),
        ...walk(top, alongTop, i, j === down - 1, true, node[i + 1][j + 1]),
        ...walk(left, alongLeft, j, i === 0, true, node[i][j + 1]),
      ]);
    }
  }
  return rings;
}

/**
 * The cells a face comes apart into, or null when it is left whole.
 *
 * Four corners give a grid. Anything else is cut the way Catmull-Clark cuts it:
 * one quad per corner, reaching back to a point in the middle of the face,
 * gridded in turn when the sides carry more than the one cut that scheme needs.
 */
function patchRings(
  mesh: BMesh,
  outline: Outline,
  runs: Vert[][],
  dimensions: [number, number],
  middle: Vec3,
): Vert[][] | null {
  const [across, down] = dimensions;

  if (outline.grid) {
    if (across < 2 && down < 2) return null;
    return gridRings(
      mesh,
      runs[0],
      runs[1],
      [...runs[2]].reverse(),
      [...runs[3]].reverse(),
      across,
      down,
      middle,
    );
  }

  if (across < 2) return null;
  const half = across / 2;

  const centre = mesh.addVert(middle);
  // One spoke per side, from the point halfway along it to the middle. Shared
  // by the two corner quads either side of it, so it is drawn once.
  const middles = runs.map((run) => run[runBounds(run.length - 1, across)[half]]);
  const spokes = middles.map((from) => {
    const spoke: Vert[] = [from];
    for (let k = 1; k < half; k++) spoke.push(mesh.addVert(lerp(from.co, middle, k / half)));
    spoke.push(centre);
    return spoke;
  });

  const rings: Vert[][] = [];
  for (let c = 0; c < runs.length; c++) {
    const before = (c - 1 + runs.length) % runs.length;
    const start = runs[c].indexOf(middles[c]);
    const back = runs[before].indexOf(middles[before]);
    rings.push(
      ...gridRings(
        mesh,
        runs[c].slice(0, start + 1),
        spokes[c],
        spokes[before],
        [...runs[before].slice(back)].reverse(),
        half,
        half,
        null,
      ),
    );
  }
  return rings;
}

/** Faces a subdivision touches: the selection, and everything its cuts run into. */
function touchedFaces(
  mesh: BMesh,
  selected: readonly Face[],
  splits: ReadonlyMap<Edge, number>,
): Map<number, Face> {
  const touched = new Map<number, Face>();
  for (const face of selected) touched.set(face.id, face);
  for (const edge of splits.keys()) {
    for (const face of mesh.edgeFaces(edge)) touched.set(face.id, face);
  }
  return touched;
}

/**
 * Faces the mesh would hold after this subdivision.
 *
 * The plan alone, with nothing cut: the cuts travel as far as they would and
 * every face they reach is counted, which is the only honest figure to check a
 * budget against now that one cut can run the width of the mesh.
 */
export function subdivisionCost(mesh: BMesh, faces: readonly Face[], cuts: number): number {
  const live = faces.filter((face) => mesh.faces.has(face.id));
  const asked = Math.max(1, Math.floor(cuts));
  const selectedIds = new Set(live.map((face) => face.id));

  const outlines = new Map<number, Outline>();
  for (const face of live) {
    const outline = outlineOf(mesh, face);
    if (outline) outlines.set(face.id, outline);
  }

  const splits = planCuts(mesh, outlines, asked);
  const touched = touchedFaces(mesh, live, splits);

  let cells = 0;
  for (const face of touched.values()) {
    const outline = outlines.get(face.id) ?? outlineOf(mesh, face);
    if (!outline) {
      cells += 1;
      continue;
    }
    cells += cellCount(outline, faceDimensions(outline, splits, asked, selectedIds.has(face.id)));
  }

  return mesh.faces.size - touched.size + cells;
}

function subdividePass(mesh: BMesh, faces: readonly Face[], cuts: number, smooth: number): Face[] {
  const live = faces.filter((face) => mesh.faces.has(face.id));
  if (live.length === 0) return [];

  // A face no point in it can see the whole of is cut into convex pieces before
  // anything else happens, because the quads fanned off a face only tile it
  // when its middle can see every edge. The ring a boolean leaves around a hole
  // is the case that matters, and left whole it comes back as a starburst.
  const selected: Face[] = [];
  for (const face of live) {
    const points = mesh.facePoints(face);
    if (fansCleanly(points, facePointOf(mesh, face))) selected.push(face);
    else selected.push(...openFace(mesh, face));
  }

  const selectedIds = new Set(selected.map((face) => face.id));

  // Read once per face and shared by all three rules below, so the edge points,
  // the relaxed corners and the middle a face is cut around all agree.
  const points = new Map<number, Vec3>();
  const facePoint = (face: Face) => {
    const held = points.get(face.id);
    if (held) return held;
    const found = facePointOf(mesh, face);
    points.set(face.id, found);
    return found;
  };

  const outlines = new Map<number, Outline>();
  for (const face of selected) {
    const outline = outlineOf(mesh, face);
    if (outline) outlines.set(face.id, outline);
  }

  const splits = planCuts(mesh, outlines, cuts);

  const edgePoints = new Map<Edge, Vert[]>();
  for (const [edge, count] of splits) {
    const midpoint = mul(add(edge.v0.co, edge.v1.co), 0.5);
    const adjacent = mesh.edgeFaces(edge);
    const limit =
      adjacent.length === 2
        ? centroid([edge.v0.co, edge.v1.co, ...adjacent.map(facePoint)])
        : midpoint;
    const pull = sub(limit, midpoint);

    const inserted: Vert[] = [];
    for (let i = 1; i <= count; i++) {
      const t = i / (count + 1);
      const along = lerp(edge.v0.co, edge.v1.co, t);
      // Weighted to nothing at the ends and to the whole of the pull in the
      // middle: one cut then lands exactly on the Catmull-Clark edge point, and
      // a row of them bows the edge rather than stepping it.
      const weight = 4 * t * (1 - t) * smooth;
      inserted.push(mesh.addVert(weight > 0 ? addScaled(along, pull, weight) : along));
    }
    edgePoints.set(edge, inserted);
  }

  const touched = touchedFaces(mesh, selected, splits);

  // Catmull-Clark also relaxes the original corners: (F + 2R + (n-3)V) / n.
  // Only corners whose whole fan is selected move, so a partial subdivision
  // cannot drag the surrounding surface out of shape.
  const relaxed = new Map<number, Vec3>();
  if (smooth > 0) {
    for (const face of selected) {
      for (const vert of mesh.faceVerts(face)) {
        if (relaxed.has(vert.id)) continue;
        const fan = mesh.vertFaces(vert);
        if (!fan.every((candidate) => selectedIds.has(candidate.id))) continue;

        const valence = vert.edges.length;
        if (valence < 3) continue;

        const faceAverage = centroid(fan.map(facePoint));
        const edgeAverage = centroid(
          vert.edges.map((edge) => mul(add(edge.v0.co, edge.v1.co), 0.5)),
        );
        const limit = mul(
          add(add(faceAverage, mul(edgeAverage, 2)), mul(vert.co, valence - 3)),
          1 / valence,
        );
        relaxed.set(vert.id, lerp(vert.co, limit, smooth));
      }
    }
  }

  /** The points cut into one edge, running the way this loop crosses it. */
  const alongLoop = (loop: Loop) => {
    const inserted = edgePoints.get(loop.edge) ?? [];
    return loop.edge.v0 === loop.vert ? inserted : [...inserted].reverse();
  };

  /** One side of a face, corner to corner, with the new points spliced in. */
  const sideVerts = (side: Loop[]) => {
    const run: Vert[] = [side[0].vert];
    for (const loop of side) run.push(...alongLoop(loop), loop.next.vert);
    return run;
  };

  /** The face's own ring with the new points spliced into it. */
  const widened = (face: Face) => {
    const ring: Vert[] = [];
    for (const loop of mesh.faceLoops(face)) ring.push(loop.vert, ...alongLoop(loop));
    return ring;
  };

  interface FaceSpec {
    ring: Vert[];
    materialIndex: number;
    smooth: boolean;
    fromSelection: boolean;
  }
  const created: FaceSpec[] = [];
  const replaced: Face[] = [];
  /** Selected faces nothing reached: left standing, still selected. */
  const untouched: Face[] = [];

  for (const face of touched.values()) {
    const chosen = selectedIds.has(face.id);
    const outline = outlines.get(face.id) ?? outlineOf(mesh, face);
    const middle = facePoint(face);

    // A face no point can see the whole of keeps its ring instead of being cut
    // up. It still takes whatever points the cuts put on its edges, so the mesh
    // stays watertight; it simply is not carved, because the only way to carve
    // it is into quads that miss it.
    const rings =
      outline && fansCleanly(mesh.facePoints(face), middle)
        ? patchRings(
            mesh,
            outline,
            outline.sides.map(sideVerts),
            faceDimensions(outline, splits, cuts, chosen),
            middle,
          )
        : null;
    const ring = rings ?? [widened(face)];

    // Not cut, and nothing cut into its edges either: there is nothing to
    // rebuild, and rebuilding it anyway would be churn on a face this
    // subdivision decided to leave alone.
    if (!rings && ring[0].length === mesh.faceLoops(face).length) {
      if (chosen) untouched.push(face);
      continue;
    }

    replaced.push(face);
    for (const points of ring) {
      created.push({
        ring: points,
        materialIndex: face.materialIndex,
        smooth: face.smooth,
        fromSelection: chosen,
      });
    }
  }

  const staleEdges = new Set<Edge>();
  for (const face of replaced) {
    for (const edge of mesh.faceEdges(face)) staleEdges.add(edge);
    mesh.removeFace(face);
  }

  const result: Face[] = [...untouched];
  for (const spec of created) {
    if (spec.ring.length < 3) continue;
    const face = mesh.addFace(spec.ring, {
      materialIndex: spec.materialIndex,
      smooth: spec.smooth,
    });
    if (spec.fromSelection) {
      face.selected = true;
      result.push(face);
    }
  }

  for (const edge of staleEdges) {
    if (mesh.edges.has(edge.id) && edge.loops.length === 0) mesh.removeEdge(edge);
  }
  mesh.removeLooseVerts();

  // Applied last so the limit positions above were all read off the cage.
  for (const [vertId, position] of relaxed) {
    const vert = mesh.verts.get(vertId);
    if (vert) vert.co = position;
  }

  mesh.computeNormals();

  return result.filter((face) => mesh.faces.has(face.id));
}

/** Splits n-gons into triangles. Required by some export targets. */
export function triangulateFaces(mesh: BMesh, faces: readonly Face[]): Face[] {
  const created: Face[] = [];

  for (const face of faces) {
    if (!mesh.faces.has(face.id)) continue;
    const verts = mesh.faceVerts(face);
    if (verts.length <= 3) {
      created.push(face);
      continue;
    }

    const indices = triangulatePolygon(
      verts.map((vert) => vert.co),
      face.normal,
    );
    const { materialIndex, smooth, selected } = face;
    mesh.removeFace(face);

    for (let i = 0; i < indices.length; i += 3) {
      const triangle = mesh.addFace(
        [verts[indices[i]], verts[indices[i + 1]], verts[indices[i + 2]]],
        { materialIndex, smooth },
      );
      triangle.selected = selected;
      created.push(triangle);
    }
  }

  mesh.computeNormals();
  return created;
}

/** Merges adjacent, near-coplanar triangle pairs back into quads. */
export function trisToQuads(mesh: BMesh, faces: readonly Face[], angleLimit = 40): Face[] {
  const limit = Math.cos((angleLimit * Math.PI) / 180);
  const candidates = faces.filter(
    (face) => mesh.faces.has(face.id) && mesh.faceLoops(face).length === 3,
  );
  const consumed = new Set<number>();
  const result: Face[] = [];

  for (const face of candidates) {
    if (consumed.has(face.id)) continue;

    for (const loop of mesh.faceLoops(face)) {
      const partner = mesh.edgeFaces(loop.edge).find((other) => other !== face);
      if (!partner || consumed.has(partner.id)) continue;
      if (mesh.faceLoops(partner).length !== 3) continue;
      if (dot(face.normal, partner.normal) < limit) continue;

      const partnerLoop = loop.edge.loops.find((candidate) => candidate.face === partner);
      if (!partnerLoop) continue;

      // Drop the shared edge: a -> apex -> b -> the original third corner.
      const apex = partnerLoop.next.next.vert;
      const quad = [loop.vert, apex, loop.next.vert, loop.next.next.vert];
      if (new Set(quad.map((vert) => vert.id)).size !== 4) continue;

      const { materialIndex, smooth } = face;
      const sharedEdge = loop.edge;
      consumed.add(face.id);
      consumed.add(partner.id);
      mesh.removeFace(face);
      mesh.removeFace(partner);
      if (mesh.edges.has(sharedEdge.id) && sharedEdge.loops.length === 0) {
        mesh.removeEdge(sharedEdge);
      }
      result.push(mesh.addFace(quad, { materialIndex, smooth }));
      break;
    }
  }

  mesh.computeNormals();
  return result;
}
