import {
  type Vec3,
  addScaled,
  basisFromNormal,
  centroid,
  cross,
  degToRad,
  distanceSq,
  dot,
  length,
  lengthSq,
  lerp,
  normalize,
  polygonArea,
  polygonNormal,
  sub,
  vec3,
} from '../math';
import { BMesh, cloneMesh, triangulatePolygon } from '../mesh';
import type { Edge, Face, Loop, Vert } from '../mesh/types';

import { connectedRegions, dissolveVerts } from './dissolve';
import { weldVerts } from './merge';
import { dedupeRing } from './region';
import { trisToQuads } from './subdivide';

export type BooleanOp = 'union' | 'difference' | 'intersect';

/**
 * How far off a plane a point may sit and still count as lying on it, as a
 * fraction of the model's own size.
 *
 * Relative rather than absolute, because an absolute figure is a different
 * instruction at every scale: 1e-5 m is a reasonable "on the plane" for a
 * table and a structural gap for a rivet. Everything downstream hangs off it:
 * too tight and coincident faces split each other into slivers, too loose and
 * thin geometry is swallowed whole.
 */
const PLANE_EPSILON = 5e-6;

/**
 * How far apart two cut points may be and still be the same vertex.
 *
 * An order tighter than the plane tolerance, and deliberately so: points that
 * ought to coincide are the same intersection computed twice and agree to
 * within floating-point noise, so the weld needs no slack. Given slack it takes
 * it: welding a T-junction vertex onto the corner beside it, which tears the
 * ring it was holding together.
 */
const WELD_EPSILON = 5e-7;

/** Cap on the merge/strand loop below; it converges long before this. */
const RESOLVE_PASSES = 8;

/**
 * How far two coplanar triangles may fold and still be paired into a quad.
 *
 * Only the tidying pass at the end of `resolve` reads this. Which faces may be
 * merged at all is decided by provenance, not by angle; see
 * `mergeSourceFragments`.
 */
const QUAD_PAIR_LIMIT_DEGREES = 1;

/**
 * How much of its area a face may lose and still count as having come through
 * untouched. Loose enough to ignore a clip that shaved off a sliver, tight
 * enough that any real cut is seen.
 */
const AREA_EPSILON = 1e-6;

/**
 * How near the other operand a face may come and still count as clear of it, in
 * plane tolerances. Past that the tree cannot take the two for one surface, so
 * nothing but a plane running on past what it bounds can cut the face.
 */
const TOUCH_REACH = 2;

/** How many polygons a leaf of a `BoxTree` holds; each is tested by hand. */
const BOX_LEAF_SIZE = 8;

/**
 * How far a face may stand off its own plane, as a fraction of its width, and
 * still be put back together as one face after the cut.
 *
 * A face moved by hand is seldom exactly flat, and one only a few degrees out
 * is still the one face the user sees. Anything bent further is left as the
 * triangles it was cut as; see `meshToPolys`.
 */
const WARP_LIMIT = 0.05;

/**
 * How close two corners of a broken cutter may sit, and how thin one of its
 * faces may be, as a fraction of the cutter's size, before they are taken for
 * one corner and for no face at all. See `flattenCutter`.
 */
const COLLAPSE_LIMIT = 2e-3;

/**
 * How far a face of a cutter may lean from the first face of its flat run and
 * still line the hole as one face with it. See `flattenCutter`.
 */
const FLAT_WALL_DEGREES = 1;

/**
 * How the work of one boolean divides up, measured on a cut dense enough to be
 * worth a progress bar at all. The remainder after these two is `resolve`.
 */
const CSG_SHARE = 0.88;
const REBUILD_SHARE = 0.07;

/** The largest side of the box the polygons fill; the model's own scale. */
function extentOf(polys: readonly { points: readonly Vec3[] }[]): number {
  let min = { x: Infinity, y: Infinity, z: Infinity };
  let max = { x: -Infinity, y: -Infinity, z: -Infinity };

  for (const poly of polys) {
    for (const point of poly.points) {
      min = {
        x: Math.min(min.x, point.x),
        y: Math.min(min.y, point.y),
        z: Math.min(min.z, point.z),
      };
      max = {
        x: Math.max(max.x, point.x),
        y: Math.max(max.y, point.y),
        z: Math.max(max.z, point.z),
      };
    }
  }

  const extent = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
  return Number.isFinite(extent) && extent > 0 ? extent : 1;
}

interface Plane {
  normal: Vec3;
  /** Signed distance from the origin along the normal. */
  w: number;
}

/** A polygon, carrying the slot and the input face it came from. */
interface Poly {
  points: Vec3[];
  plane: Plane;
  materialIndex: number;
  /**
   * The input face this is a piece of, unique across both operands. A face
   * that is not flat is a source per triangle instead; see `meshToPolys`.
   *
   * A BSP splits a face by every plane in the tree, not only by the ones that
   * end up bounding the solid, so the surface arrives carved along lines the
   * finished shape has no reason to show. Knowing which pieces were one face is
   * what lets those cuts be undone without touching anything else; see
   * `mergeSourceFragments`.
   */
  source: number;
}

/** An input face as it was modelled, and the sources its pieces will carry. */
interface InputFace {
  /** Wound the way its polygons are, which is not always the way the mesh has it. */
  points: Vec3[];
  materialIndex: number;
  sources: number[];
  /** The ids of its vertices, which tie it to the faces beside it. */
  verts: number[];
  /** A point on the face itself, where a concave ring's middle may not be. */
  inner: Vec3;
}

/** One side of a cut: its polygons, its faces as modelled, whether it has an inside. */
interface Operand {
  polys: Poly[];
  faces: InputFace[];
  solid: boolean;
}

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

/**
 * The plane a polygon lies in.
 *
 * Newell's normal rather than one cross product: it averages over the whole
 * ring, so a polygon whose first three points happen to be collinear (which a
 * ring carrying a T-junction vertex often is) still gets a usable plane.
 */
function planeFrom(points: readonly Vec3[]): Plane {
  const normal = normalize(polygonNormal(points));
  return { normal, w: dot(normal, centroid(points)) };
}

function usablePlane(plane: Plane): boolean {
  return (
    Number.isFinite(plane.w) &&
    Number.isFinite(plane.normal.x) &&
    Number.isFinite(plane.normal.y) &&
    Number.isFinite(plane.normal.z)
  );
}

/**
 * Whether a polygon can go into the tree whole rather than as triangles.
 *
 * The split only holds for planar convex polygons: a plane cuts one of those
 * into exactly two pieces, while a concave ring can come apart into three or
 * more and the two rings the split writes back would be nonsense.
 */
function isSplittable(points: readonly Vec3[], normal: Vec3, epsilon: number): boolean {
  if (!isFlat(points, normal, epsilon)) return false;

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    // Collinear corners pass: they turn neither way, which is exactly what a
    // vertex sitting part-way along an edge looks like.
    if (dot(cross(sub(b, a), sub(c, b)), normal) < -epsilon) return false;
  }

  return true;
}

function isFlat(points: readonly Vec3[], normal: Vec3, epsilon: number): boolean {
  const offset = dot(normal, centroid(points));
  return points.every((point) => Math.abs(dot(normal, point) - offset) <= epsilon);
}

function flipPlane(plane: Plane): Plane {
  return { normal: { x: -plane.normal.x, y: -plane.normal.y, z: -plane.normal.z }, w: -plane.w };
}

function flipPoly(poly: Poly): Poly {
  return {
    points: [...poly.points].reverse(),
    plane: flipPlane(poly.plane),
    materialIndex: poly.materialIndex,
    source: poly.source,
  };
}

/**
 * Sorts one polygon against a plane, splitting it where it straddles.
 *
 * The four output lists are what the BSP needs to keep the two coplanar cases
 * apart: a face lying in the plane belongs to whichever side it faces, and
 * getting that wrong is what leaves holes where two solids share a wall.
 */
function splitPoly(
  plane: Plane,
  poly: Poly,
  coplanarFront: Poly[],
  coplanarBack: Poly[],
  front: Poly[],
  back: Poly[],
  epsilon: number,
): void {
  let polyType = 0;
  const types: number[] = [];

  for (const point of poly.points) {
    const distance = dot(plane.normal, point) - plane.w;
    const type = distance < -epsilon ? BACK : distance > epsilon ? FRONT : COPLANAR;
    polyType |= type;
    types.push(type);
  }

  if (polyType === COPLANAR) {
    (dot(plane.normal, poly.plane.normal) > 0 ? coplanarFront : coplanarBack).push(poly);
    return;
  }
  if (polyType === FRONT) {
    front.push(poly);
    return;
  }
  if (polyType === BACK) {
    back.push(poly);
    return;
  }

  const frontPoints: Vec3[] = [];
  const backPoints: Vec3[] = [];

  for (let i = 0; i < poly.points.length; i++) {
    const j = (i + 1) % poly.points.length;
    const ti = types[i];
    const tj = types[j];
    const pi = poly.points[i];
    const pj = poly.points[j];

    if (ti !== BACK) frontPoints.push(pi);
    if (ti !== FRONT) backPoints.push(pi);

    if ((ti | tj) === SPANNING) {
      const t = (plane.w - dot(plane.normal, pi)) / dot(plane.normal, sub(pj, pi));
      const cut = lerp(pi, pj, t);
      frontPoints.push(cut);
      backPoints.push({ ...cut });
    }
  }

  // A split can leave a two-point sliver on one side; it has no area, and
  // feeding it back in would give it a garbage plane.
  // Both halves keep the parent's plane, so every fragment of one input face
  // stays exactly coplanar with its siblings however many times it is cut.
  if (frontPoints.length >= 3) {
    front.push({
      points: frontPoints,
      plane: poly.plane,
      materialIndex: poly.materialIndex,
      source: poly.source,
    });
  }
  if (backPoints.length >= 3) {
    back.push({
      points: backPoints,
      plane: poly.plane,
      materialIndex: poly.materialIndex,
      source: poly.source,
    });
  }
}

interface Node {
  plane: Plane | null;
  front: Node | null;
  back: Node | null;
  polys: Poly[];
}

function emptyNode(): Node {
  return { plane: null, front: null, back: null, polys: [] };
}

/** Every node in the tree, root first. Iterative: these trees get deep. */
function nodes(root: Node): Node[] {
  const all: Node[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    all.push(node);
    if (node.front) stack.push(node.front);
    if (node.back) stack.push(node.back);
  }
  return all;
}

/**
 * Adds polygons to the tree, choosing the first one's plane as each split.
 *
 * Iterative rather than recursive: the depth follows the input, and a mesh of
 * any size would otherwise be one long face-fan away from blowing the stack.
 */
function build(root: Node, polys: readonly Poly[], epsilon: number): void {
  if (polys.length === 0) return;
  const stack: { node: Node; polys: Poly[] }[] = [{ node: root, polys: [...polys] }];

  while (stack.length > 0) {
    const { node, polys: batch } = stack.pop() as { node: Node; polys: Poly[] };
    if (batch.length === 0) continue;
    if (!node.plane) node.plane = batch[0].plane;

    const front: Poly[] = [];
    const back: Poly[] = [];
    for (const poly of batch) {
      // A polygon is always in its own plane, whatever its points say. One that
      // is not quite flat has a corner past the tolerance, and sorted by the
      // test its piece on that side carries the same plane down into a child
      // that picks that plane again: the build never ends.
      if (poly.plane === node.plane) node.polys.push(poly);
      else splitPoly(node.plane, poly, node.polys, node.polys, front, back, epsilon);
    }

    if (front.length > 0) {
      node.front ??= emptyNode();
      stack.push({ node: node.front, polys: front });
    }
    if (back.length > 0) {
      node.back ??= emptyNode();
      stack.push({ node: node.back, polys: back });
    }
  }
}

/** Turns the solid inside out, so "inside" tests become "outside" tests. */
function invert(root: Node): void {
  for (const node of nodes(root)) {
    node.polys = node.polys.map(flipPoly);
    if (node.plane) node.plane = flipPlane(node.plane);
    const front = node.front;
    node.front = node.back;
    node.back = front;
  }
}

/**
 * Drops the parts of `polys` that fall inside the solid this tree describes.
 *
 * With `keepInside` nothing is dropped: the polygons are only cut wherever the
 * tree's planes cross them.
 */
function clipPolys(
  root: Node,
  polys: readonly Poly[],
  epsilon: number,
  keepInside = false,
): Poly[] {
  const kept: Poly[] = [];
  const stack: { node: Node; polys: Poly[] }[] = [{ node: root, polys: [...polys] }];

  while (stack.length > 0) {
    const { node, polys: batch } = stack.pop() as { node: Node; polys: Poly[] };
    if (batch.length === 0) continue;
    if (!node.plane) {
      kept.push(...batch);
      continue;
    }

    const front: Poly[] = [];
    const back: Poly[] = [];
    for (const poly of batch) splitPoly(node.plane, poly, front, back, front, back, epsilon);

    if (node.front) stack.push({ node: node.front, polys: front });
    else kept.push(...front);
    // No back child means the space behind this plane is solid, so anything
    // there is inside and goes no further.
    if (node.back) stack.push({ node: node.back, polys: back });
    else if (keepInside) kept.push(...back);
  }

  return kept;
}

function clipTo(root: Node, other: Node, epsilon: number, keepInside = false): void {
  for (const node of nodes(root)) node.polys = clipPolys(other, node.polys, epsilon, keepInside);
}

/** The parts of `poly` outside `over`, a convex polygon lying in the same plane. */
function outside(poly: Poly, over: Poly, epsilon: number): Poly[] {
  const kept: Poly[] = [];
  let rest = [poly];

  for (let i = 0; i < over.points.length && rest.length > 0; i++) {
    const a = over.points[i];
    const along = sub(over.points[(i + 1) % over.points.length], a);
    if (lengthSq(along) <= epsilon * epsilon) continue;

    // Stood up off the plane on the edge, facing away from the polygon.
    const normal = normalize(cross(along, over.plane.normal));
    const inside: Poly[] = [];
    for (const piece of rest) {
      splitPoly({ normal, w: dot(normal, a) }, piece, kept, inside, kept, inside, epsilon);
    }
    rest = inside;
  }

  // Nothing left inside means the two never overlapped, and the cuts made on
  // the way would only be fragments for the merge pass to undo.
  return rest.length === 0 ? [poly] : kept;
}

interface Box {
  min: Vec3;
  max: Vec3;
}

function boxOf(poly: Poly): Box {
  const xs = poly.points.map((point) => point.x);
  const ys = poly.points.map((point) => point.y);
  const zs = poly.points.map((point) => point.z);
  return {
    min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
    max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
  };
}

/** Whether two boxes stand more than `reach` apart along some axis. */
function boxesApart(a: Box, b: Box, reach: number): boolean {
  return (
    a.max.x < b.min.x - reach ||
    a.max.y < b.min.y - reach ||
    a.max.z < b.min.z - reach ||
    b.max.x < a.min.x - reach ||
    b.max.y < a.min.y - reach ||
    b.max.z < a.min.z - reach
  );
}

/**
 * What is left of `polys` once every stretch lying flat on `cover` is cut away.
 *
 * Needed only where two surfaces share a plane. A solid's tree settles this on
 * its own, its side walls fencing each face in, but a surface's tree holds
 * nothing but the plane it lies in and cannot say where in that plane it ends.
 * Each covering polygon is convex, so its own edges, stood up off the plane,
 * are that fence. Without it a union of two such surfaces came back as two
 * sheets stacked on each other with not one vertex in common.
 */
function uncovered(polys: readonly Poly[], cover: readonly Poly[], epsilon: number): Poly[] {
  const boxes = cover.map(boxOf);

  return polys.flatMap((poly) => {
    const box = boxOf(poly);
    let pieces = [poly];
    cover.forEach((over, i) => {
      if (boxesApart(box, boxes[i], epsilon)) return;
      const { normal, w } = over.plane;
      if (poly.points.some((point) => Math.abs(dot(normal, point) - w) > epsilon)) return;
      pieces = pieces.flatMap((piece) => outside(piece, over, epsilon));
    });
    return pieces;
  });
}

/**
 * Whether two polygons come within `reach` of each other.
 *
 * Separating axes: any line along which the two project more than `reach` apart
 * proves they are, so a polygon that is not quite convex can only read as nearer
 * than it is, and that errs the safe way. Axes in each polygon's own plane are
 * what tell apart two lying side by side in one plane, which edge crossed with
 * edge cannot.
 */
function polysReach(a: Poly, b: Poly, reach: number): boolean {
  const apartAlong = (axis: Vec3) => {
    const size = length(axis);
    if (size === 0) return false;
    let [aLow, aHigh, bLow, bHigh] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const point of a.points) {
      const at = dot(point, axis) / size;
      aLow = Math.min(aLow, at);
      aHigh = Math.max(aHigh, at);
    }
    for (const point of b.points) {
      const at = dot(point, axis) / size;
      bLow = Math.min(bLow, at);
      bHigh = Math.max(bHigh, at);
    }
    return aHigh < bLow - reach || bHigh < aLow - reach;
  };

  const edges = (poly: Poly) =>
    poly.points.map((point, i) => sub(poly.points[(i + 1) % poly.points.length], point));
  const aEdges = edges(a);
  const bEdges = edges(b);

  if (apartAlong(a.plane.normal) || apartAlong(b.plane.normal)) return false;
  for (const edge of aEdges) if (apartAlong(cross(a.plane.normal, edge))) return false;
  for (const edge of bEdges) if (apartAlong(cross(b.plane.normal, edge))) return false;
  for (const aEdge of aEdges) {
    for (const bEdge of bEdges) if (apartAlong(cross(aEdge, bEdge))) return false;
  }
  return true;
}

/** Boxes within boxes over a set of polygons, for "what could this one reach". */
interface BoxTree {
  box: Box;
  /** Empty except at a leaf. */
  items: readonly { poly: Poly; box: Box }[];
  kids: [BoxTree, BoxTree] | null;
}

function boxTreeOf(items: readonly { poly: Poly; box: Box }[]): BoxTree {
  const box: Box = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  // A loop rather than `Math.min(...all)`: spread over a dense mesh overflows.
  for (const { box: each } of items) {
    box.min = {
      x: Math.min(box.min.x, each.min.x),
      y: Math.min(box.min.y, each.min.y),
      z: Math.min(box.min.z, each.min.z),
    };
    box.max = {
      x: Math.max(box.max.x, each.max.x),
      y: Math.max(box.max.y, each.max.y),
      z: Math.max(box.max.z, each.max.z),
    };
  }
  if (items.length <= BOX_LEAF_SIZE) return { box, items, kids: null };

  const spans = { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z };
  const axis = spans.x >= spans.y && spans.x >= spans.z ? 'x' : spans.y >= spans.z ? 'y' : 'z';
  const sorted = [...items].sort(
    (a, b) => a.box.min[axis] + a.box.max[axis] - b.box.min[axis] - b.box.max[axis],
  );
  const half = sorted.length >> 1;
  return {
    box,
    items: [],
    kids: [boxTreeOf(sorted.slice(0, half)), boxTreeOf(sorted.slice(half))],
  };
}

function reachesTree(poly: Poly, box: Box, tree: BoxTree, reach: number): boolean {
  if (boxesApart(box, tree.box, reach)) return false;
  if (tree.kids) {
    return (
      reachesTree(poly, box, tree.kids[0], reach) || reachesTree(poly, box, tree.kids[1], reach)
    );
  }
  return tree.items.some(
    (item) => !boxesApart(box, item.box, reach) && polysReach(poly, item.poly, reach),
  );
}

/**
 * The sources with a polygon within `reach` of the other operand.
 *
 * Measured against what the cut itself will see, so a lid `capRims` laid counts:
 * that is a surface the other operand gets cut along, even though it goes again
 * afterwards.
 */
function touchingSources(a: readonly Poly[], b: readonly Poly[], reach: number): Set<number> {
  const touched = new Set<number>();
  const mark = (polys: readonly Poly[], others: readonly Poly[]) => {
    if (others.length === 0) return;
    const tree = boxTreeOf(others.map((poly) => ({ poly, box: boxOf(poly) })));
    for (const poly of polys) {
      if (touched.has(poly.source)) continue;
      if (reachesTree(poly, boxOf(poly), tree, reach)) touched.add(poly.source);
    }
  };
  mark(a, b);
  mark(b, a);
  return touched;
}

/**
 * How many times a surface winds round a point: its solid angle, in whole spheres.
 *
 * About one inside a closed solid and nought outside, and unlike reading a BSP
 * it does not lose its way over shells overlapping in one object, or over a
 * small crack, which each cost it only the fraction they leave open.
 */
function windingOf(point: Vec3, polys: readonly Poly[]): number {
  let total = 0;
  for (const { points } of polys) {
    const a = sub(points[0], point);
    const la = length(a);
    for (let i = 1; i + 1 < points.length; i++) {
      const b = sub(points[i], point);
      const c = sub(points[i + 1], point);
      const [lb, lc] = [length(b), length(c)];
      total += Math.atan2(
        dot(a, cross(b, c)),
        la * lb * lc + dot(a, b) * lc + dot(b, c) * la + dot(c, a) * lb,
      );
    }
  }
  return total / (2 * Math.PI);
}

/**
 * The faces touching nothing, in patches joined by the vertices they share.
 *
 * A patch cannot cross the other operand's surface without some face in it
 * touching that surface, so all of it lies on one side, whatever its size.
 */
function untouchedPatches(
  faces: readonly InputFace[],
  touched: ReadonlySet<number>,
): InputFace[][] {
  const free = faces.filter(
    (face) => face.sources.length > 0 && !face.sources.some((source) => touched.has(source)),
  );

  const root = new Map<number, number>();
  const find = (id: number): number => {
    let at = id;
    while (root.get(at) !== at) at = root.get(at) as number;
    root.set(id, at);
    return at;
  };
  for (const face of free) {
    for (const vert of face.verts) {
      if (!root.has(vert)) root.set(vert, vert);
      root.set(find(vert), find(face.verts[0]));
    }
  }

  const patches = new Map<number, InputFace[]>();
  for (const face of free) {
    const id = find(face.verts[0]);
    const patch = patches.get(id);
    if (patch) patch.push(face);
    else patches.set(id, [face]);
  }
  return [...patches.values()];
}

/**
 * What a cut does with a face lying wholly on one side of the other operand.
 * `claimed` says the face lies inside it, which takes a solid: a surface has no
 * inside to put anything in.
 */
function keepsUntouched(
  op: BooleanOp,
  isTool: boolean,
  claimed: boolean,
  ownSolid: boolean,
): boolean {
  if (op === 'intersect') return claimed;
  // The tool's surface only ever comes back as the wall of the cavity it made.
  if (op === 'difference' && isTool) return ownSolid && claimed;
  return !claimed;
}

/**
 * Settles every input face that touches nothing, in place of what the BSP did.
 *
 * Such a face lies wholly inside the other operand or wholly outside it, so a
 * cut has one thing to say about it: stay or go. Asking the BSP is no good for
 * either half of that. Whatever it cuts the face into is a plane running on past
 * what it bounds, and merging those pieces back is not reliable: a quad a hair
 * off flat goes in as two triangles in two planes, and pieces that would not fit
 * back together stayed, as n-gons a long way from anything the boolean touched.
 * And its answer is not reliable either: on a real model it can read part of a
 * face that touches nothing as inside, which left holes there. So its pieces are
 * thrown away, the winding number settles it once for each patch, and the face
 * goes back as it was modelled.
 *
 * Comes first in the list because the weld keeps the first position it sees of
 * a point, and these are the ones the user modelled.
 */
function settleUntouched(
  op: BooleanOp,
  output: readonly Poly[],
  target: Operand,
  tool: Operand,
  touched: ReadonlySet<number>,
  areaOf: Map<number, number>,
): { polys: Poly[]; untouched: Set<number> } {
  const settled = new Set<number>();
  const whole: Poly[] = [];
  const untouched = new Set<number>();

  for (const [own, other, isTool] of [
    [target, tool, false],
    [tool, target, true],
  ] as const) {
    for (const patch of untouchedPatches(own.faces, touched)) {
      const claimed = other.solid && Math.abs(windingOf(patch[0].inner, other.polys)) > 0.5;
      const keeps = keepsUntouched(op, isTool, claimed, own.solid);

      for (const face of patch) {
        for (const source of face.sources) settled.add(source);
        if (!keeps) continue;

        // A cavity's walls are the tool's faces turned inside out.
        const points = op === 'difference' && isTool ? [...face.points].reverse() : face.points;
        const source = face.sources[0];
        // One source now, however many triangles it went in as.
        areaOf.set(source, polygonArea(points));
        untouched.add(source);
        whole.push({
          points,
          plane: planeFrom(points),
          materialIndex: face.materialIndex,
          source,
        });
      }
    }
  }

  return { polys: [...whole, ...output.filter((poly) => !settled.has(poly.source))], untouched };
}

function allPolys(root: Node): Poly[] {
  return nodes(root).flatMap((node) => node.polys);
}

function treeFrom(polys: readonly Poly[], epsilon: number): Node {
  const root = emptyNode();
  build(root, polys, epsilon);
  return root;
}

/**
 * Runs a staged operation straight through, ignoring the progress it reports.
 *
 * The stages exist so a caller that wants to paint between them can; one that
 * does not should not have to know they are there.
 */
function drain<T>(steps: Generator<number, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * Constructive solid geometry over two polygon soups, pausing where it can
 * afford to.
 *
 * The classic BSP formulation: each solid is clipped against the other, the
 * inversions decide which side survives, and what comes back is the boundary
 * of the combined solid.
 *
 * An operand that is a surface rather than a solid (`solid` false) is never
 * clipped against. Its tree would answer anyway: every leaf behind a plane
 * reads as inside, so a filled circle stands for the whole half-space under
 * it, and a union with one sliced the other object off along its plane. With
 * nothing inside it, a surface removes nothing from the other operand and
 * keeps whatever part of itself the other one's inside does not claim. A union
 * still cuts each operand where the other meets it, so the two come back
 * joined along the contact rather than merely overlapping. Two surfaces lying
 * in one plane are the exception: there the tool covers part of the target,
 * and a difference takes that part away.
 *
 * The fractions are measured, not guessed: building the two BSP trees is about
 * sixty per cent of the work and the final rebuild most of the rest, while the
 * clips together are barely one. They are also the only seams available: each
 * of those calls recurses over a whole tree in one go, so a bar cannot move
 * inside them without the tree build itself being taken apart.
 */
function* csgStaged(
  op: BooleanOp,
  a: readonly Poly[],
  b: readonly Poly[],
  epsilon = PLANE_EPSILON * extentOf([...a, ...b]),
  solid: { a: boolean; b: boolean } = { a: true, b: true },
): Generator<number, Poly[]> {
  const left = treeFrom(a, epsilon);
  yield 0.34;
  const right = treeFrom(b, epsilon);
  yield 0.68;

  if (op === 'union') {
    if (solid.b) {
      clipTo(left, right, epsilon);
      // Turned inside out, what lies flat on one of the solid's faces reads as
      // inside it and goes, as the solid's own coplanar faces do below.
      if (!solid.a) {
        invert(left);
        clipTo(left, right, epsilon);
        invert(left);
      }
    } else {
      // A surface takes nothing away, but the solid still has to be cut where
      // the surface meets it, or the two touch without sharing a vertex and the
      // union is two meshes in one object.
      clipTo(left, right, epsilon, true);
    }
    if (solid.a) {
      clipTo(right, left, epsilon);
      invert(right);
      clipTo(right, left, epsilon);
      invert(right);
    }
    yield 0.69;
    // Building the rest into the tree cuts it by every plane there, which is
    // what marks the target's surface on it in turn.
    const rest =
      solid.a || solid.b ? allPolys(right) : uncovered(allPolys(right), allPolys(left), epsilon);
    build(left, rest, epsilon);
    return allPolys(left);
  }

  if (op === 'difference') {
    // Neither has an inside, but where the two lie in one plane the tool still
    // covers part of the target, and that part is what a cut takes away.
    if (!solid.a && !solid.b) return uncovered(allPolys(left), allPolys(right), epsilon);
    invert(left);
    if (solid.b) clipTo(left, right, epsilon);
    // The tool's surface only ever comes back as the wall of the cavity it
    // made, and a surface on either side makes no cavity.
    if (solid.a && solid.b) {
      clipTo(right, left, epsilon);
      invert(right);
      clipTo(right, left, epsilon);
      invert(right);
      yield 0.69;
      build(left, allPolys(right), epsilon);
    }
    invert(left);
    return allPolys(left);
  }

  // Each operand keeps only what lies inside the other, and a surface has no
  // inside to keep anything in.
  if (!solid.a && !solid.b) return [];
  if (!solid.a) return surfaceInside(left, right, epsilon);
  if (!solid.b) return surfaceInside(right, left, epsilon);

  invert(left);
  clipTo(right, left, epsilon);
  invert(right);
  clipTo(left, right, epsilon);
  clipTo(right, left, epsilon);
  yield 0.69;
  build(left, allPolys(right), epsilon);
  invert(left);
  return allPolys(left);
}

/**
 * The part of a surface that lies inside a solid.
 *
 * Both are turned inside out first, as the full intersect does, so a stretch of
 * the surface lying flat on one of the solid's faces counts as inside it.
 */
function surfaceInside(surface: Node, solid: Node, epsilon: number): Poly[] {
  invert(surface);
  invert(solid);
  clipTo(surface, solid, epsilon);
  invert(surface);
  return allPolys(surface);
}

/**
 * Six times the volume the polygons enclose, signed by which way they face.
 *
 * The divergence theorem on the position field: each triangle contributes the
 * signed volume of the tetrahedron it makes with the origin, and on a closed
 * surface everything outside the solid cancels. Positive means the polygons
 * face out of what they enclose, which is the one thing every test in the BSP
 * takes for granted.
 */
function sixVolume(polys: readonly Poly[]): number {
  let total = 0;

  for (const poly of polys) {
    const a = poly.points[0];
    for (let i = 1; i + 1 < poly.points.length; i++) {
      total += dot(a, cross(poly.points[i], poly.points[i + 1]));
    }
  }

  return total;
}

/** Closed and manifold: every edge has a face on both sides. */
function isClosed(mesh: BMesh): boolean {
  for (const edge of mesh.edges.values()) if (edge.loops.length !== 2) return false;
  return mesh.faces.size > 0;
}

/**
 * How far a mesh's faces may lean one way and it still count as a solid: their
 * areas summed as vectors, as a fraction of their areas summed as sizes.
 *
 * A closed surface faces every way at once and sums to nothing, while a filled
 * circle or a plane faces one way and sums to all of itself. Read off the
 * geometry rather than the topology, because a boolean's own output is not
 * always watertight: a dropped sliver leaves a crack, and a seam left unwelded
 * leaves two, yet the surface still closes and sums to next to nothing. Read
 * as a surface on that account, a solid would stop cutting anything.
 */
const OPENING_LIMIT = 0.01;

/**
 * How far a mesh with open rims may lean and still be cut as the solid it
 * nearly is, with its rims closed for the length of the cut; see `capRims`.
 *
 * A part separated off a model is left open where it was cut away, and leans
 * by the area of that opening: a pillar parted from its cap, by about a
 * seventh. Read as a surface it had no inside, so a union kept all of what was
 * stuck into it, walls buried in the pillar included. A sheet leans by all of
 * itself and a bowl by half, and both stay surfaces.
 */
const RIM_LIMIT = 0.4;

/** How far a mesh's faces lean one way, as `OPENING_LIMIT` measures it. */
function leanOf(mesh: BMesh): number {
  let lean = vec3();
  let total = 0;
  for (const face of mesh.faces.values()) {
    const points = mesh.facePoints(face);
    const area = polygonArea(points);
    lean = addScaled(lean, polygonNormal(points), area);
    total += area;
  }
  return total > 0 ? length(lean) / total : 0;
}

/**
 * Closes the open rims of a mesh for the length of a cut, or null where they
 * do not trace as clean loops.
 *
 * A rim is walked the way the faces beside it run, so reversed it runs the way
 * a face across the gap would, and the closed shell faces one way all round.
 * Each lid is a source of its own, listed in `caps`, so whatever the cut keeps
 * of it can be taken away again; see `dropCaps`.
 */
function capRims(
  mesh: BMesh,
  toTarget: (point: Vec3) => Vec3,
  base: number,
  caps: Set<number>,
): Poly[] | null {
  const rims = boundaryCycles(mesh, [...mesh.faces.values()]);
  if (!rims || rims.length === 0) return null;

  const lids: Poly[] = [];
  let source = base + caps.size;
  for (const rim of rims) {
    const points = rim.map((vert) => toTarget(vert.co)).reverse();
    source += 1;
    caps.add(source);

    const indices = triangulatePolygon(points, polygonNormal(points));
    for (let i = 0; i < indices.length; i += 3) {
      const tri = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
      const plane = planeFrom(tri);
      if (usablePlane(plane)) lids.push({ points: tri, plane, materialIndex: 0, source });
    }
  }
  return lids;
}

/**
 * An operand as the cut takes it: its polygons, and whether it has an inside.
 *
 * A tube with no caps counts as solid as it stands, its two open ends
 * cancelling. One open further than that has its rims closed, which is what
 * keeps the space past an opening outside it: read straight off the walls,
 * everything over a topless box's footprint lies behind every one of them.
 * Closed, it comes out facing outward as `meshToPolys` leaves a closed solid.
 */
function operand(
  mesh: BMesh,
  polys: Poly[],
  faces: InputFace[],
  toTarget: (point: Vec3) => Vec3,
  base: number,
  caps: Set<number>,
): Operand {
  const lean = leanOf(mesh);
  if (lean <= OPENING_LIMIT) return { polys, faces, solid: true };
  if (lean > RIM_LIMIT) return { polys, faces, solid: false };

  const lids = capRims(mesh, toTarget, base, caps);
  if (!lids) return { polys, faces, solid: false };
  const closed = [...polys, ...lids];
  if (sixVolume(closed) >= 0) return { polys: closed, faces, solid: true };
  flipFaces(faces);
  return { polys: closed.map(flipPoly), faces, solid: true };
}

/** Rewinds faces to match polygons that `flipPoly` turned over. */
function flipFaces(faces: InputFace[]): void {
  for (const face of faces) face.points = [...face.points].reverse();
}

/**
 * Takes away what the cut kept of the lids `capRims` laid, so a rim closed only
 * to give the cut an inside to read comes back the opening it was.
 */
function dropCaps(mesh: BMesh, sourceOf: Map<number, number>, caps: ReadonlySet<number>): void {
  const bared = new Set<Edge>();
  for (const face of [...mesh.faces.values()]) {
    const source = sourceOf.get(face.id);
    if (source === undefined || !caps.has(source)) continue;
    for (const edge of mesh.faceEdges(face)) bared.add(edge);
    mesh.removeFace(face);
    sourceOf.delete(face.id);
  }

  const loose = [...bared].filter((edge) => edge.loops.length === 0);
  for (const edge of loose) mesh.removeEdge(edge);
  mesh.removeLooseEnds(loose);
}

/** Whether a face passes a corner twice, or has an edge torn open or shared by three faces. */
function isBroken(mesh: BMesh, face: Face): boolean {
  const loops = mesh.faceLoops(face);
  if (new Set(loops.map((loop) => loop.vert.id)).size !== loops.length) return true;
  return loops.some((loop) => loop.edge.loops.length !== 2);
}

/** Whether a face is no wider than `limit` across the line between its furthest corners. */
function isSliver(mesh: BMesh, face: Face, limit: number): boolean {
  const points = mesh.facePoints(face);
  let span = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      span = Math.max(span, distanceSq(points[i], points[j]));
    }
  }
  return span === 0 || (2 * polygonArea(points)) / Math.sqrt(span) <= limit;
}

/** How far moving the rest of `cluster` onto `kept` lifts the faces they leave off their planes. */
function bendOf(mesh: BMesh, kept: Vert, cluster: readonly Vert[]): number {
  let bend = 0;
  for (const moved of cluster) {
    if (moved === kept) continue;
    const shift = sub(kept.co, moved.co);
    for (const face of mesh.vertFaces(moved)) {
      if (!mesh.faceVerts(face).includes(kept)) bend += Math.abs(dot(face.normal, shift));
    }
  }
  return bend;
}

/**
 * Welds the corners within `limit` of each other round the broken faces of a
 * mesh, each cluster onto the corner whose move bends the faces round it least.
 *
 * A face bent by a hair goes into the cut as triangles in planes a hair apart,
 * and the two lines they cut across the target leave a sliver between them
 * that never rejoins it. Welding a rib's corner onto its twin one way left a
 * scrap of the pillar hanging off the notch; the other way left nothing.
 */
function weldBroken(mesh: BMesh, limit: number): void {
  const broken = new Set<Vert>();
  for (const face of mesh.faces.values()) {
    if (isBroken(mesh, face)) for (const vert of mesh.faceVerts(face)) broken.add(vert);
  }
  if (broken.size < 2) return;

  const verts = [...broken];
  const root = new Map(verts.map((vert) => [vert.id, vert.id]));
  const find = (id: number): number => {
    let at = id;
    while (root.get(at) !== at) at = root.get(at) as number;
    root.set(id, at);
    return at;
  };

  const index = grid(verts, 32);
  for (const vert of verts) {
    for (const other of index.near(vert.co, vert.co, limit)) {
      if (other !== vert && distanceSq(other.co, vert.co) <= limit * limit) {
        root.set(find(other.id), find(vert.id));
      }
    }
  }

  const clusters = new Map<number, Vert[]>();
  for (const vert of verts) {
    const cluster = clusters.get(find(vert.id));
    if (cluster) cluster.push(vert);
    else clusters.set(find(vert.id), [vert]);
  }

  const mapping = new Map<number, Vert>();
  for (const cluster of clusters.values()) {
    if (cluster.length < 2) continue;
    const bends = cluster.map((vert) => bendOf(mesh, vert, cluster));
    const kept = cluster[bends.indexOf(Math.min(...bends))];
    for (const vert of cluster) if (vert !== kept) mapping.set(vert.id, kept);
  }
  weldVerts(mesh, mapping);
}

/**
 * The cutter of a difference as the cut takes it: each flat side one face.
 *
 * The cutter's faces that end up inside the target are the walls of the hole,
 * and they came through as the cutter carried them. A rib whose buried side
 * had been left as a fan of triangles notched a pillar with the fan's
 * diagonals across the floor, where the other ribs left one face. Nobody sees
 * a cutter's buried side before the cut, so its tiling is nothing to keep.
 *
 * That rib was broken as well, and a broken cutter is mended first: corners a
 * hair apart round a face that passes a corner twice, or sits on a torn or
 * overfilled edge, are welded, which closes a crack the notch would otherwise
 * carry. A face with no width left between two flat ones joins their run, so
 * the run is one piece to merge. All of it on a copy: the cutter keeps its mesh.
 */
function flattenCutter(tool: BMesh): BMesh {
  const mesh = cloneMesh(tool);
  const limit =
    COLLAPSE_LIMIT * extentOf([{ points: [...mesh.verts.values()].map((vert) => vert.co) }]);

  weldBroken(mesh, limit);

  const slivers = new Set<number>();
  for (const face of mesh.faces.values()) {
    if (isSliver(mesh, face, limit)) slivers.add(face.id);
  }

  const flat = Math.cos(degToRad(FLAT_WALL_DEGREES));
  const claimed = new Set<number>();
  const runs: Face[][] = [];
  for (const seed of mesh.faces.values()) {
    if (claimed.has(seed.id) || slivers.has(seed.id)) continue;
    claimed.add(seed.id);

    // Measured against the seed rather than from face to face, or a run could
    // creep round a dense curve a degree at a time.
    const run = [seed];
    for (let i = 0; i < run.length; i++) {
      for (const edge of mesh.faceEdges(run[i])) {
        for (const next of mesh.edgeFaces(edge)) {
          if (claimed.has(next.id) || next.materialIndex !== seed.materialIndex) continue;
          if (!slivers.has(next.id) && dot(next.normal, seed.normal) < flat) continue;
          claimed.add(next.id);
          run.push(next);
        }
      }
    }
    if (run.length > 1) runs.push(run);
  }

  for (const run of runs) {
    const edges = run.flatMap((face) => mesh.faceEdges(face));
    mergeRegionGreedy(mesh, run);
    mesh.removeLooseEnds(edges);
  }

  mesh.computeNormals();
  return mesh;
}

/**
 * Reads a mesh out as triangles in the target's space.
 *
 * `toTarget` carries each point through the source object's transform and back
 * through the target's, because a boolean is only meaningful where the two
 * solids actually sit relative to each other.
 *
 * A closed solid comes out facing outward whatever it arrived as. That matters
 * because `toTarget` is free to reverse handedness (an object mirrored by a
 * negative scale on one axis, which is an ordinary thing to have in a scene)
 * and a reversed map turns every ring the other way round, so the solid reaches
 * the BSP inside out. Nothing then errors: "inside" and "outside" are simply
 * exchanged for that operand, and the answer comes back confidently wrong. A
 * union returns a fragment, a difference returns the cutter. Reading the sign
 * off the volume catches a source mesh that was already inverted as well.
 */
function meshToPolys(
  mesh: BMesh,
  toTarget: (point: Vec3) => Vec3,
  slotFor: (face: Face) => number = (face) => face.materialIndex,
  /** Start of this operand's source ids; the two operands must not overlap. */
  base = 0,
  /** Filled with the area each input face came in with; see `untouchedSources`. */
  areaOf?: Map<number, number>,
  /** Filled with each face as it came in; see `settleUntouched`. */
  inputs?: InputFace[],
  epsilon = PLANE_EPSILON,
): Poly[] {
  const polys: Poly[] = [];
  let source = base;

  for (const face of mesh.faces.values()) {
    const points = mesh.facePoints(face).map(toTarget);
    if (points.length < 3) continue;

    const normal = polygonNormal(points);
    const slot = slotFor(face);
    const verts = mesh.faceVerts(face).map((vert) => vert.id);

    // A face the boolean never touches should come out the far side as the
    // same face. Triangulating everything on the way in is what left a plain
    // union of two boxes covered in diagonals answering to nothing in the shape.
    if (isSplittable(points, normal, epsilon)) {
      const plane = planeFrom(points);
      if (usablePlane(plane)) {
        source += 1;
        areaOf?.set(source, polygonArea(points));
        polys.push({ points, plane, materialIndex: slot, source });
        inputs?.push({
          points,
          materialIndex: slot,
          sources: [source],
          verts,
          inner: centroid(points),
        });
        continue;
      }
    }

    // The triangles of a face that is not flat lie in planes of their own, and
    // stitching their pieces back into one ring after a cut bends it across
    // all of them. Drawn flat, a ring like that folds over the hole the cut
    // left and paints a flap across it, so each triangle is a source of its own.
    // Only once it is bent well out of true, though: one a few degrees off is
    // one face to the user, and cut as triangles of their own, it kept the
    // diagonal between them wherever the tool landed on it.
    const flat = isFlat(points, normal, Math.max(epsilon, WARP_LIMIT * extentOf([{ points }])));
    const parts: number[] = [];
    if (flat) {
      source += 1;
      areaOf?.set(source, polygonArea(points));
      parts.push(source);
    }

    const indices = triangulatePolygon(points, normal);
    let inner: Vec3 | null = null;
    for (let i = 0; i < indices.length; i += 3) {
      const tri = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
      const plane = planeFrom(tri);
      // A degenerate triangle has no usable plane, and one bad plane in the
      // tree misroutes every polygon sorted against it.
      if (!usablePlane(plane)) continue;
      if (!flat) {
        source += 1;
        areaOf?.set(source, polygonArea(tri));
        parts.push(source);
      }
      inner ??= centroid(tri);
      polys.push({ points: tri, plane, materialIndex: slot, source });
    }
    // With no triangle to its name it never reached the cut, so it has no say.
    if (inner) inputs?.push({ points, materialIndex: slot, sources: parts, verts, inner });
  }

  // Only for a closed mesh: an open shell encloses nothing, so the sign of its
  // volume is an accident of where it sits relative to the origin and reversing
  // it on that evidence would be worse than leaving it alone.
  if (!isClosed(mesh) || sixVolume(polys) >= 0) return polys;
  if (inputs) flipFaces(inputs);
  return polys.map(flipPoly);
}

/** A uniform grid over a point set, for "what is near this box" lookups. */
function grid(verts: readonly Vert[], resolution: number) {
  let min = { x: Infinity, y: Infinity, z: Infinity };
  let max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const vert of verts) {
    min = {
      x: Math.min(min.x, vert.co.x),
      y: Math.min(min.y, vert.co.y),
      z: Math.min(min.z, vert.co.z),
    };
    max = {
      x: Math.max(max.x, vert.co.x),
      y: Math.max(max.y, vert.co.y),
      z: Math.max(max.z, vert.co.z),
    };
  }

  const extent = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
  const size = extent > 0 ? extent / resolution : 1;
  const cells = new Map<string, Vert[]>();
  const coord = (value: number, origin: number) => Math.floor((value - origin) / size);
  const key = (x: number, y: number, z: number) => `${x}:${y}:${z}`;

  for (const vert of verts) {
    const id = key(coord(vert.co.x, min.x), coord(vert.co.y, min.y), coord(vert.co.z, min.z));
    const bucket = cells.get(id);
    if (bucket) bucket.push(vert);
    else cells.set(id, [vert]);
  }

  return {
    size,
    /** Everything in the cells the box passes through, duplicates included. */
    near(a: Vec3, b: Vec3, margin: number): Vert[] {
      const lo = {
        x: coord(Math.min(a.x, b.x) - margin, min.x),
        y: coord(Math.min(a.y, b.y) - margin, min.y),
        z: coord(Math.min(a.z, b.z) - margin, min.z),
      };
      const hi = {
        x: coord(Math.max(a.x, b.x) + margin, min.x),
        y: coord(Math.max(a.y, b.y) + margin, min.y),
        z: coord(Math.max(a.z, b.z) + margin, min.z),
      };

      const found: Vert[] = [];
      for (let x = lo.x; x <= hi.x; x++) {
        for (let y = lo.y; y <= hi.y; y++) {
          for (let z = lo.z; z <= hi.z; z++) {
            const bucket = cells.get(key(x, y, z));
            if (bucket) found.push(...bucket);
          }
        }
      }
      return found;
    },
  };
}

/**
 * Rebuilds a mesh from CSG output, welding the seams back together.
 *
 * Two passes, and both are needed. The BSP hands back loose triangles that
 * share their cut points only by value, so the first pass welds those into one
 * vertex each: without it the result is a pile of disconnected faces with no
 * edges to bevel and no loops to select.
 *
 * The second pass closes the T-junctions the split leaves behind: where one
 * triangle was cut and the neighbour it sits against was not, the cut point
 * lands part-way along the neighbour's edge and belongs to only one of them.
 * Geometrically the surface is already sealed; topologically that edge has a
 * single face on it, which reads as a crack to everything downstream. Adding
 * the point to the ring that is missing it makes the two share an edge again.
 *
 * A face in `untouched` takes such a point only from what the cut made. A
 * modelled corner sitting on its edge is a crack the user's mesh already had,
 * and closing it would hand a quad back with five corners. What is left on such
 * a face is therefore always the cut's own, and free to move; see `slideStrays`.
 * The vertices standing where `inputs` had a corner come back as `corners`.
 */
function polysToMesh(
  polys: readonly Poly[],
  tolerance = WELD_EPSILON * extentOf(polys),
  untouched: ReadonlySet<number> = new Set(),
  inputs: readonly InputFace[] = [],
): { mesh: BMesh; sourceOf: Map<number, number>; corners: Set<Vert> } {
  const mesh = new BMesh();
  const sourceOf = new Map<number, number>();
  const corners = new Set<Vert>();
  const cell = Math.max(tolerance, Number.EPSILON) * 2;
  const buckets = new Map<string, Vert[]>();
  const limitSq = tolerance * tolerance;
  const bucketKey = (point: Vec3) =>
    `${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}:${Math.floor(point.z / cell)}`;

  // Neighbouring cells are searched too: quantising alone drops the weld
  // whenever two points a hair apart fall either side of a cell boundary.
  const welded = (point: Vec3): Vert | null => {
    const cx = Math.floor(point.x / cell);
    const cy = Math.floor(point.y / cell);
    const cz = Math.floor(point.z / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = buckets.get(`${cx + dx}:${cy + dy}:${cz + dz}`);
          if (!bucket) continue;
          for (const vert of bucket) {
            if (distanceSq(vert.co, point) <= limitSq) return vert;
          }
        }
      }
    }
    return null;
  };

  const weld = (point: Vec3): Vert => {
    const found = welded(point);
    if (found) return found;

    const vert = mesh.addVert(point);
    const id = bucketKey(point);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(vert);
    else buckets.set(id, [vert]);
    return vert;
  };

  const rings: { verts: Vert[]; materialIndex: number; source: number }[] = [];
  for (const poly of polys) {
    const verts = poly.points.map(weld);
    // The weld can collapse a sliver onto itself, which is no longer a face.
    const ring = verts.filter((vert, index) => vert !== verts[(index + 1) % verts.length]);
    if (ring.length < 3) continue;
    rings.push({ verts: ring, materialIndex: poly.materialIndex, source: poly.source });
  }

  for (const input of inputs) {
    for (const point of input.points) {
      const vert = welded(point);
      if (vert) corners.add(vert);
    }
  }

  const all = [...mesh.verts.values()];
  const index = grid(all, 32);

  for (const ring of rings) {
    const expanded: Vert[] = [];
    const asModelled = untouched.has(ring.source);

    for (let i = 0; i < ring.verts.length; i++) {
      const a = ring.verts[i];
      const b = ring.verts[(i + 1) % ring.verts.length];
      expanded.push(a);

      const along = sub(b.co, a.co);
      const spanSq = lengthSq(along);
      if (spanSq === 0) continue;

      // Endpoints are already in the ring, so the ends of the span are excluded
      // by a whole tolerance rather than by an arbitrary fraction of it.
      const margin = tolerance / Math.sqrt(spanSq);
      const between: { vert: Vert; t: number }[] = [];

      for (const candidate of index.near(a.co, b.co, tolerance)) {
        if (candidate === a || candidate === b) continue;
        if (asModelled && corners.has(candidate)) continue;
        const t = dot(sub(candidate.co, a.co), along) / spanSq;
        if (t <= margin || t >= 1 - margin) continue;
        if (distanceSq(candidate.co, lerp(a.co, b.co, t)) > limitSq) continue;
        if (between.some((entry) => entry.vert === candidate)) continue;
        between.push({ vert: candidate, t });
      }

      between.sort((left, right) => left.t - right.t);
      for (const entry of between) expanded.push(entry.vert);
    }

    if (polygonArea(expanded.map((vert) => vert.co)) > Number.EPSILON) {
      const face = mesh.addFace(expanded, { materialIndex: ring.materialIndex });
      sourceOf.set(face.id, ring.source);
    }
  }

  mesh.computeNormals();
  return { mesh, sourceOf, corners };
}

/**
 * A set of coplanar fragments grown back into one face, and its outline.
 *
 * `ring` is null when the set never became something a face could hold, which
 * leaves its fragments alone rather than rebuilding them as something wrong.
 */
interface Disc {
  faces: Face[];
  ring: Vert[] | null;
  /** Edges that ended up between two of the disc's faces; the merge is done with them. */
  interior: Set<number>;
}

/**
 * Whether an edge carries more than the two faces a surface has on it.
 *
 * The extra face is the other operand meeting this one there, and that line of
 * edges is the whole of what joins them: a surface standing on a face, or
 * passing through one, hangs off it and nothing else. Merging the faces either
 * side of a seam would leave what hangs there joined to nothing.
 */
function isSeam(edge: Edge): boolean {
  return edge.loops.length > 2;
}

/**
 * The largest disc that can be grown out of `pool`, starting from `seed`.
 *
 * Two discs glued along a single unbroken run of shared edges give a disc.
 * Glued along two separate runs they give a ring, which encloses a hole; met at
 * a lone vertex they pinch. Neither has an outline one face could carry, so
 * each candidate is turned away as it comes rather than the whole region being
 * thrown back once the damage is done.
 *
 * The bookkeeping is over the region's own boundary (the edges carrying
 * exactly one of its faces) rather than over which faces are in it. That is
 * what makes it hold on real boolean output instead of only on the clean
 * manifold the argument above assumes: a crack where a sliver was dropped
 * leaves an edge with one face in the entire mesh, and it belongs to the
 * outline like any other edge does, while an edge that somehow carries three
 * faces must not be allowed to take a fourth.
 *
 * Greedy, and swept until a whole pass adds nothing: a fragment turned away
 * because its shared edges came in two runs becomes addable the moment the gap
 * between them is filled, and around a hole that happens constantly. Faces
 * taken are removed from `pool`, so repeated calls partition it.
 */
function growDisc(mesh: BMesh, seed: Face, pool: Map<number, Face>): Disc {
  const faces: Face[] = [];
  const interior = new Set<number>();
  const verts = new Set<number>();
  /** Edge id to the loop of this region that walks it, for its boundary only. */
  const border = new Map<number, Loop>();
  /** Boundary edges leaving each vertex. A disc's outline never has two. */
  const leaving = new Map<number, Set<number>>();
  let frontier: Face[] = [];

  const attach = (loop: Loop) => {
    border.set(loop.edge.id, loop);
    const at = leaving.get(loop.vert.id);
    if (at) at.add(loop.edge.id);
    else leaving.set(loop.vert.id, new Set([loop.edge.id]));
  };

  const detach = (loop: Loop) => {
    border.delete(loop.edge.id);
    leaving.get(loop.vert.id)?.delete(loop.edge.id);
  };

  /** Adds a face and hands back the undo, because some are only tried. */
  const take = (face: Face) => {
    const held: Loop[] = [];
    const laid: Loop[] = [];
    const fresh: number[] = [];

    faces.push(face);
    pool.delete(face.id);

    for (const loop of mesh.faceLoops(face)) {
      if (!verts.has(loop.vert.id)) {
        verts.add(loop.vert.id);
        fresh.push(loop.vert.id);
      }

      const met = border.get(loop.edge.id);
      if (met) {
        detach(met);
        interior.add(loop.edge.id);
        held.push(met);
      } else {
        attach(loop);
        laid.push(loop);
      }

      for (const neighbour of mesh.edgeFaces(loop.edge)) {
        if (pool.has(neighbour.id)) frontier.push(neighbour);
      }
    }

    return () => {
      for (const loop of laid) detach(loop);
      for (const loop of held) {
        interior.delete(loop.edge.id);
        attach(loop);
      }
      for (const vert of fresh) verts.delete(vert);
      faces.pop();
      pool.set(face.id, face);
    };
  };

  /** Whether the outline still leaves every vertex of `face` at most once. */
  const simple = (face: Face) =>
    mesh.faceLoops(face).every((loop) => (leaving.get(loop.vert.id)?.size ?? 0) <= 1);

  const worthTrying = (face: Face): boolean => {
    const loops = mesh.faceLoops(face);
    // An edge already between two of the region's faces cannot take a third.
    if (loops.some((loop) => interior.has(loop.edge.id))) return false;
    if (loops.some((loop) => isSeam(loop.edge) && border.has(loop.edge.id))) return false;

    const shared = loops.map((loop) => border.has(loop.edge.id));
    let runs = 0;
    for (let i = 0; i < shared.length; i++) {
      if (shared[i] && !shared[(i - 1 + shared.length) % shared.length]) runs += 1;
    }
    // Zero covers both a face sharing nothing and a face sharing everything:
    // the second closes the region into a shell rather than widening it.
    if (runs !== 1) return false;

    // `shared[i]` is the edge leaving vertex `i`, so vertex `i` sits on the run
    // when the edge before it or the edge after it is part of that run.
    for (let i = 0; i < loops.length; i++) {
      if (!verts.has(loops[i].vert.id)) continue;
      if (shared[i] || shared[(i - 1 + loops.length) % loops.length]) continue;
      return false;
    }

    return true;
  };

  take(seed);
  // A fragment whose own ring passes the same vertex twice is already pinched,
  // and nothing grown from it could come back as one face.
  if (!simple(seed)) return { faces, ring: null, interior };

  while (frontier.length > 0) {
    const wave = frontier;
    frontier = [];

    const deferred: Face[] = [];
    let added = 0;
    for (const face of wave) {
      if (!pool.has(face.id)) continue;

      if (worthTrying(face)) {
        const undo = take(face);
        if (simple(face)) {
          added += 1;
          continue;
        }
        undo();
      }
      deferred.push(face);
    }

    // Nothing added means nothing moved, so the deferred would only fail
    // again; they are left to seed a disc of their own.
    if (added > 0) frontier.push(...deferred);
  }

  return { faces, ring: traceBorder(border), interior };
}

/** Walks a region's boundary into one ring, or gives up on finding it is two. */
function traceBorder(border: ReadonlyMap<number, Loop>): Vert[] | null {
  if (border.size < 3) return null;

  const onward = new Map<number, Loop>();
  for (const loop of border.values()) {
    if (onward.has(loop.vert.id)) return null;
    onward.set(loop.vert.id, loop);
  }

  const start = onward.values().next().value as Loop;
  const ring: Vert[] = [];
  let current = start;
  do {
    ring.push(current.vert);
    const next = onward.get(current.next.vert.id);
    if (!next) return null;
    current = next;
  } while (current !== start && ring.length <= onward.size);

  // Short of every boundary edge means the walk closed early, and what it left
  // out is a second outline (a hole) sitting somewhere it never reached.
  return current === start && ring.length === onward.size ? ring : null;
}

/**
 * How far the outline has to turn at a vertex for it to count as a corner.
 *
 * A holed surface is split along seams run out to corners, which is what lets
 * every other vertex of the outline keep nothing but its two collinear edges
 * and be dissolved. See `splitAcrossHole`.
 */
const SEAM_CORNER_DEGREES = 10;

/** How many places on one outline a seam is allowed to be looked for. */
const SEAM_ANCHOR_LIMIT = 12;

/** A point on the plane a coplanar region lies in. */
interface Flat {
  x: number;
  y: number;
}

/**
 * The boundary of a set of faces, as one cycle per closed loop.
 *
 * A region with nothing inside it gives one cycle; one with a hole gives two.
 * Null when the boundary is not a set of clean loops at all: pinched at a
 * vertex, or torn in a way that leaves the walk a choice to make.
 */
function boundaryCycles(mesh: BMesh, region: readonly Face[]): Vert[][] | null {
  const ids = new Set(region.map((face) => face.id));
  const onward = new Map<number, Loop>();

  for (const face of region) {
    for (const loop of mesh.faceLoops(face)) {
      if (mesh.edgeFaces(loop.edge).filter((other) => ids.has(other.id)).length !== 1) continue;
      if (onward.has(loop.vert.id)) return null;
      onward.set(loop.vert.id, loop);
    }
  }

  const cycles: Vert[][] = [];
  const walked = new Set<number>();

  for (const start of onward.values()) {
    if (walked.has(start.vert.id)) continue;

    const cycle: Vert[] = [];
    let current = start;
    do {
      walked.add(current.vert.id);
      cycle.push(current.vert);
      const next = onward.get(current.next.vert.id);
      if (!next) return null;
      current = next;
    } while (current !== start && !walked.has(current.vert.id));

    // Anything but a return to the start means the walk ran into a loop it was
    // not on, which is not a boundary the split below could work from.
    if (current !== start || cycle.length < 3) return null;
    cycles.push(cycle);
  }

  return cycles;
}

/** The stretch of a cycle from `start` to `end` inclusive, going forwards. */
function arc(cycle: readonly Vert[], start: number, end: number): Vert[] {
  const run: Vert[] = [];
  for (let i = start; ; i = (i + 1) % cycle.length) {
    run.push(cycle[i]);
    if (i === end) break;
  }
  return run;
}

function signedArea(ring: readonly Flat[]): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

function turnOf(a: Flat, b: Flat, c: Flat): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Whether two segments cross properly; meeting at an endpoint does not count. */
function segmentsCross(a: Flat, b: Flat, c: Flat, d: Flat): boolean {
  return turnOf(a, b, c) * turnOf(a, b, d) < 0 && turnOf(c, d, a) * turnOf(c, d, b) < 0;
}

/** Whether `point` is enclosed by `ring`, by the parity of a ray cast east. */
function enclosedBy(point: Flat, ring: readonly Flat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > point.y === b.y > point.y) continue;
    if (point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function nearSegment(point: Flat, a: Flat, b: Flat, reach: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = dx * dx + dy * dy;
  if (span === 0) return false;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / span));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)) <= reach;
}

/**
 * Whether a seam from `outer[i]` to `hole[j]` stays on the surface.
 *
 * It has to cross neither outline, pass through no other vertex (a seam that
 * grazed one would join the two halves there as well as along itself, which is
 * a pinch) and run over material rather than through the hole or off the face.
 */
function seamFits(
  outer: readonly Flat[],
  hole: readonly Flat[],
  i: number,
  j: number,
  reach: number,
): boolean {
  const from = outer[i];
  const to = hole[j];

  for (let k = 0; k < outer.length; k++) {
    if (k === i || (k + 1) % outer.length === i) continue;
    if (segmentsCross(from, to, outer[k], outer[(k + 1) % outer.length])) return false;
  }
  for (let k = 0; k < hole.length; k++) {
    if (k === j || (k + 1) % hole.length === j) continue;
    if (segmentsCross(from, to, hole[k], hole[(k + 1) % hole.length])) return false;
  }

  for (let k = 0; k < outer.length; k++) {
    if (k !== i && nearSegment(outer[k], from, to, reach)) return false;
  }
  for (let k = 0; k < hole.length; k++) {
    if (k !== j && nearSegment(hole[k], from, to, reach)) return false;
  }

  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  return enclosedBy(middle, outer) && !enclosedBy(middle, hole);
}

/**
 * Outline positions a seam is allowed to land on.
 *
 * Corners if the outline has any: a seam pins whatever vertex it meets, and a
 * corner was never going to dissolve anyway. Where the outline is a curve (
 * a bore through a cylinder's cap) nothing turns far enough to be a corner,
 * and then anything that turns at all will do, since the dissolve pass would
 * have kept it regardless. Either way the list is thinned, because the search
 * that follows is quadratic in it and a fine curve has hundreds.
 */
function seamAnchors(ring: readonly Flat[]): number[] {
  const corner = Math.cos(degToRad(SEAM_CORNER_DEGREES));
  const turns = ring.map((point, i) => {
    const previous = ring[(i - 1 + ring.length) % ring.length];
    const next = ring[(i + 1) % ring.length];
    const into = { x: point.x - previous.x, y: point.y - previous.y };
    const away = { x: next.x - point.x, y: next.y - point.y };
    const span = Math.hypot(into.x, into.y) * Math.hypot(away.x, away.y);
    return span === 0 ? 1 : (into.x * away.x + into.y * away.y) / span;
  });

  const corners = turns.flatMap((turn, i) => (turn < corner ? [i] : []));
  // The same limit the dissolve pass reads a vertex as straight by, so nothing
  // is pinned that would otherwise have gone.
  const bent = turns.flatMap((turn, i) => (turn < 1 - PLANE_EPSILON ? [i] : []));

  const anchors = corners.length >= 2 ? corners : bent;
  const stride = Math.max(1, Math.ceil(anchors.length / SEAM_ANCHOR_LIMIT));
  return anchors.filter((_, i) => i % stride === 0);
}

/**
 * Opens a surface with a hole in it into two faces, along two seams.
 *
 * Two is the fewest a hole can be stated in. A face carries one ring, so a
 * single one would have to reach into the hole and back out along its own
 * path, and an ear clipper handed that fills straight across and paints over
 * the hole. Opened in two places instead, both halves are ordinary simple
 * polygons that fill the way anything else does.
 *
 * Where the seams land is the whole question, and the answer is corners. Every
 * vertex a seam touches is pinned to the outline: it keeps a third edge, so
 * the pass that dissolves what the cut left behind walks past it. Pinning a
 * corner costs nothing: a corner was never going to dissolve. Pinning a point
 * part-way along a straight edge keeps a vertex the shape has no use for, and
 * that edge is shared with the wall behind it, so a box bored through the top
 * comes back with a six-sided side face the cutter never went near.
 *
 * Null when no pair of seams works, which leaves the region to be grown as
 * discs instead rather than forcing a split that runs off the surface.
 */
function splitAcrossHole(mesh: BMesh, region: readonly Face[]): Vert[][] | null {
  const cycles = boundaryCycles(mesh, region);
  if (!cycles || cycles.length !== 2) return null;

  const { u, v } = basisFromNormal(normalize(polygonNormal(cycles[0].map((vert) => vert.co))));
  const flats = cycles.map((cycle) =>
    cycle.map((vert) => ({ x: dot(vert.co, u), y: dot(vert.co, v) })),
  );

  // The outer boundary is the one enclosing the most: a hole is by definition
  // inside it, so it can never be the larger of the two.
  const outerAt = Math.abs(signedArea(flats[0])) >= Math.abs(signedArea(flats[1])) ? 0 : 1;
  const outer = cycles[outerAt];
  const outerFlat = flats[outerAt];
  let hole = cycles[1 - outerAt];
  let holeFlat = flats[1 - outerAt];

  // Both halves are read off in one direction, so the hole has to run against
  // the outline rather than with it.
  if (signedArea(outerFlat) * signedArea(holeFlat) > 0) {
    hole = [...hole].reverse();
    holeFlat = [...holeFlat].reverse();
  }

  // How close a vertex may sit to a seam and still not count as on it, taken
  // from the outline's own size rather than from where it happens to sit.
  let low = { x: Infinity, y: Infinity };
  let high = { x: -Infinity, y: -Infinity };
  for (const point of outerFlat) {
    low = { x: Math.min(low.x, point.x), y: Math.min(low.y, point.y) };
    high = { x: Math.max(high.x, point.x), y: Math.max(high.y, point.y) };
  }
  const reach = Math.max(high.x - low.x, high.y - low.y, Number.EPSILON) * 1e-9;
  const centre = {
    x: holeFlat.reduce((sum, point) => sum + point.x, 0) / holeFlat.length,
    y: holeFlat.reduce((sum, point) => sum + point.y, 0) / holeFlat.length,
  };

  const seams: { on: number; of: number; bearing: number }[] = [];
  for (const on of seamAnchors(outerFlat)) {
    let best = -1;
    let shortest = Infinity;
    for (let of = 0; of < holeFlat.length; of++) {
      const gap = (outerFlat[on].x - holeFlat[of].x) ** 2 + (outerFlat[on].y - holeFlat[of].y) ** 2;
      if (gap >= shortest) continue;
      if (!seamFits(outerFlat, holeFlat, on, of, reach)) continue;
      shortest = gap;
      best = of;
    }
    if (best < 0) continue;
    const bearing = Math.atan2(outerFlat[on].y - centre.y, outerFlat[on].x - centre.x);
    seams.push({ on, of: best, bearing });
  }
  if (seams.length < 2) return null;

  // The pair facing most nearly away from each other, so the two halves come
  // out even rather than as a splinter and a horseshoe.
  let pair: [number, number] | null = null;
  let widest = -Infinity;
  for (let a = 0; a < seams.length; a++) {
    for (let b = a + 1; b < seams.length; b++) {
      if (seams[a].of === seams[b].of) continue;
      const turn = seams[a].bearing - seams[b].bearing;
      const apart = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
      if (apart <= widest) continue;
      if (
        segmentsCross(
          outerFlat[seams[a].on],
          holeFlat[seams[a].of],
          outerFlat[seams[b].on],
          holeFlat[seams[b].of],
        )
      ) {
        continue;
      }
      widest = apart;
      pair = [a, b];
    }
  }
  if (!pair) return null;

  const [first, second] = [seams[pair[0]], seams[pair[1]]];
  const halves = [
    [...arc(outer, first.on, second.on), ...arc(hole, second.of, first.of)],
    [...arc(outer, second.on, first.on), ...arc(hole, first.of, second.of)],
  ];
  if (halves.some((half) => half.length < 3)) return null;

  // What the halves cover has to be what the fragments covered. A ring put
  // together the wrong way round, or one that doubles back over itself, comes
  // out with the wrong area and is dropped rather than drawn. Measured on the
  // plane the seams were laid out on, because the fragments of a face bent a
  // degree off flat tilt either way of it and their own areas never add up.
  const flatArea = (verts: readonly Vert[]) =>
    Math.abs(signedArea(verts.map((vert) => ({ x: dot(vert.co, u), y: dot(vert.co, v) }))));
  const covered = halves.reduce((sum, half) => sum + flatArea(half), 0);
  const before = region.reduce((sum, face) => sum + flatArea(mesh.faceVerts(face)), 0);
  if (before <= 0 || Math.abs(covered - before) > before * 1e-6) return null;

  return halves;
}

/**
 * Replaces a set of faces with new rings, clearing the edges left behind.
 *
 * The vertices the removal strands are left for the caller to sweep once at the
 * end: dropping them is a walk of the whole mesh, and doing it per region turns
 * a pass over a dense cut into a walk per region of it.
 */
function rebuildAs(mesh: BMesh, region: readonly Face[], rings: readonly Vert[][]): Face[] {
  const { materialIndex, smooth } = region[0];
  const ids = new Set(region.map((face) => face.id));
  const interior = new Set<Edge>();

  for (const face of region) {
    for (const edge of mesh.faceEdges(face)) {
      if (mesh.edgeFaces(edge).filter((other) => ids.has(other.id)).length === 2)
        interior.add(edge);
    }
  }

  for (const face of region) mesh.removeFace(face);
  for (const edge of interior) {
    if (mesh.edges.has(edge.id) && edge.loops.length === 0) mesh.removeEdge(edge);
  }

  return rings.map((ring) => mesh.addFace(ring, { materialIndex, smooth }));
}

/** Whether `region` is already exactly the faces `rings` describes. */
function alreadyIs(mesh: BMesh, region: readonly Face[], rings: readonly Vert[][]): boolean {
  if (region.length !== rings.length) return false;
  const held = region.map((face) => new Set(mesh.faceVerts(face).map((vert) => vert.id)));
  return rings.every((ring) =>
    held.some((set) => set.size === ring.length && ring.every((vert) => set.has(vert.id))),
  );
}

/**
 * Rebuilds one region of same-source fragments as few faces as it can be.
 *
 * A region with a hole in it (the surface a tool left around its own
 * footprint) is opened along two seams run out to corners of its outline, so
 * that the split costs the shape no vertex it would not have had anyway. That
 * is `splitAcrossHole`, and it is the case a bore through a flat face lands in.
 *
 * Everything else is grown as discs: each takes fragments until one more would
 * close a ring, and each becomes one n-gon whose outline is edges the cut
 * actually made. A region with no hole is one disc and comes back as one face,
 * which is the ordinary case and the one that matters most. It is also where a
 * torn region ends up, the seams having nowhere sound to land.
 */
function mergeRegion(mesh: BMesh, region: readonly Face[]): Face[] {
  // Both halves are traced from the region's outline alone, so a seam running
  // between two of its faces would be dropped from them.
  const ids = new Set(region.map((face) => face.id));
  const seamed = region.some((face) =>
    mesh
      .faceEdges(face)
      .some(
        (edge) => isSeam(edge) && edge.loops.filter((loop) => ids.has(loop.face.id)).length > 1,
      ),
  );
  const halves = seamed ? null : splitAcrossHole(mesh, region);
  if (halves === null) return mergeRegionGreedy(mesh, region);
  return alreadyIs(mesh, region, halves) ? [] : rebuildAs(mesh, region, halves);
}

function mergeRegionGreedy(mesh: BMesh, region: readonly Face[]): Face[] {
  const pool = new Map(region.map((face) => [face.id, face]));
  const made: Face[] = [];

  while (pool.size > 0) {
    const seed = pool.values().next().value as Face;
    const { faces, ring, interior } = growDisc(mesh, seed, pool);
    if (faces.length < 2 || !ring) continue;

    const { materialIndex, smooth } = faces[0];
    for (const face of faces) mesh.removeFace(face);
    for (const id of interior) {
      const edge = mesh.edges.get(id);
      if (edge && edge.loops.length === 0) mesh.removeEdge(edge);
    }

    made.push(mesh.addFace(ring, { materialIndex, smooth }));
  }

  return made;
}

/**
 * Puts each input face back together from the fragments the BSP cut it into.
 *
 * Grouping by source rather than by angle is the whole point. Every fragment of
 * one face carries that face's own plane, so siblings are exactly coplanar and
 * no tolerance is needed to recognise them, while two neighbouring faces of a
 * finely tessellated mesh sit well inside any usable coplanarity limit and are
 * not siblings at all. Merging those is not undoing a split; it is dissolving
 * the surface the user brought in, and a dense sphere lost its poles to it.
 */
function mergeSourceFragments(mesh: BMesh, sourceOf: Map<number, number>): number {
  const bySource = new Map<number, Face[]>();
  for (const face of mesh.faces.values()) {
    const source = sourceOf.get(face.id);
    if (source === undefined) continue;
    const bucket = bySource.get(source);
    if (bucket) bucket.push(face);
    else bySource.set(source, [face]);
  }

  let merged = 0;
  for (const [source, faces] of bySource) {
    if (faces.length < 2) continue;

    // Whole region at a time. A BSP carves a face into strips that often meet
    // along two separate edges, and the last interior edge of a fan ends up
    // with both loops on one face, which no pairwise merge can resolve.
    for (const region of connectedRegions(mesh, faces)) {
      if (region.length < 2) continue;
      for (const face of mergeRegion(mesh, region)) {
        sourceOf.set(face.id, source);
        merged += 1;
      }
    }
  }

  // Once, not once per region: the sweep walks every vertex in the mesh, and a
  // dense cut has thousands of regions to merge.
  if (merged > 0) mesh.removeLooseVerts();
  mesh.computeNormals();
  return merged;
}

/**
 * Drops the stranded vertices, keeping every face's provenance across the pass.
 *
 * `dissolveVerts` rebuilds a face rather than editing it, so the face comes back
 * under a new id and its source would be lost with it, and a face with no
 * source reads as one the cut reshaped, which is how a reassembled face ends up
 * being tiled into hundreds of pieces. A rebuilt face is its old self minus the
 * vertex that went, so the old ring containing all of the new one's vertices is
 * the face it came from.
 */
function dissolveStranded(
  mesh: BMesh,
  verts: readonly Vert[],
  sourceOf: Map<number, number>,
): void {
  const before: { source: number; verts: Set<number> }[] = [];
  // Indexed by the vertices each old ring held, because the search below is
  // otherwise a walk of every face for every face, which on a dense cut is the
  // slowest thing the boolean does.
  const holding = new Map<number, number[]>();

  for (const face of mesh.faces.values()) {
    const source = sourceOf.get(face.id);
    if (source === undefined) continue;

    const ids = mesh.faceVerts(face).map((vert) => vert.id);
    const at = before.length;
    before.push({ source, verts: new Set(ids) });
    for (const id of ids) {
      const bucket = holding.get(id);
      if (bucket) bucket.push(at);
      else holding.set(id, [at]);
    }
  }

  dissolveVerts(mesh, verts);

  for (const face of mesh.faces.values()) {
    if (sourceOf.has(face.id)) continue;
    const ids = mesh.faceVerts(face).map((vert) => vert.id);
    // Any ring containing all of them contains the first, so only the rings
    // that held that one are worth testing.
    for (const at of holding.get(ids[0]) ?? []) {
      if (!ids.every((id) => before[at].verts.has(id))) continue;
      sourceOf.set(face.id, before[at].source);
      break;
    }
  }
}

/** Whether a vertex is nothing but a point part-way along a straight edge. */
function isRedundant(mesh: BMesh, vert: Vert, epsilon: number): boolean {
  if (vert.edges.length !== 2) return false;

  const [a, b] = vert.edges.map((edge) => mesh.edgeOther(edge, vert).co);
  const left = sub(a, vert.co);
  const right = sub(b, vert.co);
  const span = Math.sqrt(lengthSq(left) * lengthSq(right));
  if (span === 0) return true;

  // Facing directly away from each other: the vertex bends the edge nowhere.
  return dot(left, right) / span < -1 + epsilon;
}

/**
 * The input faces that came through the boolean whole.
 *
 * Read off the raw output before anything has been merged, and judged by area
 * rather than by piece count: a face the BSP split arrives as several pieces,
 * but a face it merely clipped arrives as one smaller piece and is just as
 * changed. Only a lone piece still carrying its whole area is the face the user
 * modelled, and nothing below has any business tiling that into quads or
 * pairing it with a neighbour.
 */
function untouchedSources(
  mesh: BMesh,
  sourceOf: Map<number, number>,
  areaOf: Map<number, number>,
): Set<number> {
  const pieces = new Map<number, Face[]>();
  for (const face of mesh.faces.values()) {
    const source = sourceOf.get(face.id);
    if (source === undefined) continue;
    const bucket = pieces.get(source);
    if (bucket) bucket.push(face);
    else pieces.set(source, [face]);
  }

  const whole = new Set<number>();
  for (const [source, faces] of pieces) {
    const before = areaOf.get(source);
    if (faces.length !== 1 || before === undefined || before <= 0) continue;
    const after = polygonArea(mesh.facePoints(faces[0]));
    if (Math.abs(after - before) <= before * AREA_EPSILON) whole.add(source);
  }
  return whole;
}

/** Whether a ring runs over itself once flattened onto its own plane. */
function ringCrosses(points: readonly Vec3[]): boolean {
  const { u, v } = basisFromNormal(normalize(polygonNormal(points)));
  const flat = points.map((point) => ({ x: dot(point, u), y: dot(point, v) }));
  const count = flat.length;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (segmentsCross(flat[i], flat[(i + 1) % count], flat[j], flat[(j + 1) % count])) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A ring cut apart at each vertex it passes twice, one simple ring to a piece.
 * Anything too short to enclose ground is dropped.
 */
function lobesOf(ring: readonly Vert[]): Vert[][] {
  const lobes: Vert[][] = [];
  let open: Vert[] = [];
  for (const vert of ring) {
    const at = open.indexOf(vert);
    if (at >= 0) {
      lobes.push(open.slice(at));
      open = open.slice(0, at);
    }
    open.push(vert);
  }
  lobes.push(open);
  return lobes.filter((lobe) => lobe.length >= 3);
}

/**
 * Moves a cut point along a straight edge into `onto`, if the surface stays put.
 *
 * The point is one the cut made, so the faces round it are pieces of one input
 * face and running it along the edge moves only the line between them. That is
 * safe only if each ring still runs the way it did and not over itself, or the
 * pieces end up overlapping. A piece that now passes `onto` twice comes apart
 * there into two; a triangle lying on the edge closes up and goes.
 */
function slideInto(mesh: BMesh, vert: Vert, onto: Vert, sourceOf: Map<number, number>): boolean {
  const rebuilt = mesh.vertFaces(vert).map((face) => ({
    face,
    lobes: lobesOf(dedupeRing(mesh.faceVerts(face).map((each) => (each === vert ? onto : each)))),
  }));

  for (const { face, lobes } of rebuilt) {
    const was = polygonNormal(mesh.facePoints(face));
    for (const lobe of lobes) {
      const now = lobe.map((each) => each.co);
      if (!(dot(was, polygonNormal(now)) > 0) || ringCrosses(now)) return false;
    }
  }

  const touching = vert.edges.map((edge) => mesh.edgeOther(edge, vert));
  for (const { face } of rebuilt) mesh.removeFace(face);
  mesh.removeVert(vert);
  for (const { face, lobes } of rebuilt) {
    const { materialIndex, smooth } = face;
    const source = sourceOf.get(face.id);
    for (const lobe of lobes) {
      const made = mesh.addFace(lobe, { materialIndex, smooth });
      if (source !== undefined) sourceOf.set(made.id, source);
    }
  }
  // Only a triangle that closed up can leave an edge with nothing on it.
  for (const other of touching) {
    const edge = mesh.findEdge(onto, other);
    if (edge && edge.loops.length === 0) mesh.removeEdge(edge);
  }
  return true;
}

/**
 * Takes the cut's stray points back off the faces that touched nothing.
 *
 * Where the cut leaves a face in two pieces, the line between them can end
 * part-way along the edge it shares with an untouched face, which has to carry
 * that point to stay sealed: a quad with five corners and nothing touching it.
 * The edge is straight, so the point can run along it into a corner, and only
 * the end of the line moves. A modelled corner never gets this far: see
 * `polysToMesh`.
 */
function slideStrays(
  mesh: BMesh,
  sourceOf: Map<number, number>,
  untouched: ReadonlySet<number>,
  corners: ReadonlySet<Vert>,
): void {
  const isUntouched = (face: Face) => {
    const source = sourceOf.get(face.id);
    return source !== undefined && untouched.has(source);
  };

  let slid = false;
  for (const vert of [...mesh.verts.values()]) {
    if (corners.has(vert) || !mesh.verts.has(vert.id)) continue;
    const own = mesh.vertFaces(vert).find(isUntouched);
    if (!own) continue;

    const ring = mesh.faceVerts(own);
    const at = ring.indexOf(vert);
    const ends = [ring[(at + ring.length - 1) % ring.length], ring[(at + 1) % ring.length]].sort(
      (a, b) => distanceSq(a.co, vert.co) - distanceSq(b.co, vert.co),
    );
    for (const end of ends) {
      if (slideInto(mesh, vert, end, sourceOf)) {
        slid = true;
        break;
      }
    }
  }
  if (slid) mesh.computeNormals();
}

/**
 * Puts the raw boolean output back into a shape someone could model with.
 *
 * A BSP splits every polygon by every plane in the tree, not only by the ones
 * that end up bounding the solid, so the surface comes back carved along lines
 * the finished shape has no reason to show. Putting each input face back
 * together out of its own fragments undoes exactly that and nothing else; the
 * vertices left stranded mid-edge by it are then no longer holding anything,
 * and go too. A modelled corner stays even when it bends nothing: it is the
 * user's, not the split's.
 *
 * Every operation is treated alike. What a boolean owes the user is the shape,
 * plus as much of the two surfaces they modelled as the shape allows, and that
 * is the same debt whether the tool added material or took it away.
 */
function resolve(
  mesh: BMesh,
  epsilon: number,
  sourceOf: Map<number, number>,
  areaOf: Map<number, number>,
  untouched: ReadonlySet<number>,
  corners: ReadonlySet<Vert>,
): void {
  const whole = untouchedSources(mesh, sourceOf, areaOf);

  // Both halves feed each other, so they run until neither has anything left
  // to do: merging two faces can strand the vertex that was holding their
  // shared edge, and removing that vertex can free the next merge along. One
  // pass of each leaves most of a stepped union still carved into strips.
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    const merged = mergeSourceFragments(mesh, sourceOf);

    const stranded = [...mesh.verts.values()].filter(
      (vert) => !corners.has(vert) && isRedundant(mesh, vert, epsilon),
    );
    if (stranded.length > 0) dissolveStranded(mesh, stranded, sourceOf);

    if (merged === 0 && stranded.length === 0) break;
  }

  // After the merge, so only what the merge could not take away is left to move.
  slideStrays(mesh, sourceOf, untouched, corners);

  // What the cut actually broke. A face that came through whole is left out of
  // the pass below entirely, as the one it might pair with as well as the one
  // doing the pairing: it is the face the user modelled, down to its winding,
  // and the boolean has no business touching it.
  const leftAlone = (face: Face) => {
    const source = sourceOf.get(face.id);
    return source !== undefined && whole.has(source);
  };
  const reshaped = [...mesh.faces.values()].filter((face) => !leftAlone(face));
  // Only the seam is left to tidy, and only ever by merging: pairing two
  // coplanar triangles into a quad removes a face, it never adds one. Nothing
  // splits a ring any more: a face this boolean put back together is the face
  // the user modelled, and cutting it up again to chase quads is what turned
  // one face of a cube into three hundred.
  trisToQuads(mesh, reshaped, QUAD_PAIR_LIMIT_DEGREES, leftAlone);
}

/**
 * One boolean, mesh in and mesh out, in the target's local space.
 *
 * The raw cut is tidied the same way whichever operation made it: every input
 * face is put back together from the fragments the BSP carved it into, and the
 * coplanar triangles left along the seam are paired back into quads. The
 * pairing limit is tight on purpose: merging across a real crease would
 * flatten the very edges the boolean just created. See `resolve`.
 */
export function booleanMesh(
  op: BooleanOp,
  target: BMesh,
  tool: BMesh,
  toTarget: (point: Vec3) => Vec3,
  toolSlot: (face: Face) => number = (face) => face.materialIndex,
): BMesh {
  return drain(booleanMeshStaged(op, target, tool, toTarget, toolSlot));
}

/**
 * The same boolean, reporting how far along it is between stages.
 *
 * Yields a fraction from 0 to 1 at each point it can safely be interrupted, so
 * a caller driving it can let the browser paint. This is what the editor uses:
 * a cut between two dense meshes runs for a couple of seconds, and a frozen
 * window with no explanation reads as a crash rather than as work in progress.
 *
 * `booleanMesh` is this function run straight through, so there is one
 * implementation and the two can never drift.
 */
export function* booleanMeshStaged(
  op: BooleanOp,
  target: BMesh,
  tool: BMesh,
  toTarget: (point: Vec3) => Vec3,
  toolSlot: (face: Face) => number = (face) => face.materialIndex,
): Generator<number, BMesh> {
  const cutter = op === 'difference' ? flattenCutter(tool) : tool;

  // One scale for the whole operation, taken from both solids together: a
  // small tool cutting a large target has to be measured against the pair,
  // not against whichever of them happens to be under the tolerance first.
  // Taken before the faces are read, so a face called flat there is flat by
  // the same measure the tree sorts it with.
  const scale = extentOf([
    { points: [...target.verts.values()].map((vert) => vert.co) },
    { points: [...cutter.verts.values()].map((vert) => toTarget(vert.co)) },
  ]);
  const epsilon = PLANE_EPSILON * scale;

  const areaOf = new Map<number, number>();
  const targetFaces: InputFace[] = [];
  const toolFaces: InputFace[] = [];
  const a = meshToPolys(target, (point) => point, undefined, 0, areaOf, targetFaces, epsilon);
  // Past every id the target used, so a face of one operand is never mistaken
  // for a face of the other. Not its face count: a warped face takes an id per
  // triangle.
  const base = a.reduce((last, poly) => Math.max(last, poly.source), 0);
  const b = meshToPolys(cutter, toTarget, toolSlot, base, areaOf, toolFaces, epsilon);

  // Lids take ids past both operands' own.
  const last = b.reduce((most, poly) => Math.max(most, poly.source), base);
  const caps = new Set<number>();
  const left = operand(target, a, targetFaces, (point) => point, last, caps);
  const right = operand(cutter, b, toolFaces, toTarget, last, caps);
  const touched = touchingSources(left.polys, right.polys, TOUCH_REACH * epsilon);

  // The CSG carries most of the cost, so its own stages are passed straight
  // through; rebuilding the mesh and resolving it share what is left.
  const steps = csgStaged(op, left.polys, right.polys, epsilon, {
    a: left.solid,
    b: right.solid,
  });
  let step = steps.next();
  while (!step.done) {
    yield step.value * CSG_SHARE;
    step = steps.next();
  }

  const { polys, untouched } = settleUntouched(op, step.value, left, right, touched, areaOf);
  const { mesh, sourceOf, corners } = polysToMesh(polys, WELD_EPSILON * scale, untouched, [
    ...targetFaces,
    ...toolFaces,
  ]);
  dropCaps(mesh, sourceOf, caps);
  yield CSG_SHARE + REBUILD_SHARE;

  resolve(mesh, PLANE_EPSILON, sourceOf, areaOf, untouched, corners);
  mesh.computeNormals();
  return mesh;
}
