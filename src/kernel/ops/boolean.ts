import {
  type Vec3,
  centroid,
  cross,
  distanceSq,
  dot,
  lengthSq,
  lerp,
  normalize,
  polygonArea,
  polygonNormal,
  sub,
} from '../math';
import { BMesh, triangulatePolygon } from '../mesh';
import type { Face, Vert } from '../mesh/types';

import { dissolveFaces, dissolveVerts, limitedDissolve } from './dissolve';
import { trisToQuads } from './subdivide';

export type BooleanOp = 'union' | 'difference' | 'intersect';

/**
 * How far off a plane a point may sit and still count as lying on it, as a
 * fraction of the model's own size.
 *
 * Relative rather than absolute, because an absolute figure is a different
 * instruction at every scale: 1e-5 m is a reasonable "on the plane" for a
 * table and a structural gap for a rivet. Everything downstream hangs off it —
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
 * it — welding a T-junction vertex onto the corner beside it, which tears the
 * ring it was holding together.
 */
const WELD_EPSILON = 5e-7;

/** Cap on the merge/strand loop below; it converges long before this. */
const RESOLVE_PASSES = 8;

/**
 * How far two faces may fold and still be merged back into one.
 *
 * Tight on purpose. The point is to undo splits the BSP made along planes that
 * do not bound the finished solid, and those leave the two halves exactly
 * coplanar. Anything looser starts flattening the crease the cut just made.
 */
const COPLANAR_LIMIT_DEGREES = 0.5;

/** The largest side of the box the polygons fill; the model's own scale. */
function extentOf(polys: readonly Poly[]): number {
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

/** A convex polygon — always a triangle here — carrying the slot it came from. */
interface Poly {
  points: Vec3[];
  plane: Plane;
  materialIndex: number;
}

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

/**
 * The plane a polygon lies in.
 *
 * Newell's normal rather than one cross product: it averages over the whole
 * ring, so a polygon whose first three points happen to be collinear — which a
 * ring carrying a T-junction vertex often is — still gets a usable plane.
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
  const offset = dot(normal, centroid(points));
  for (const point of points) {
    if (Math.abs(dot(normal, point) - offset) > epsilon) return false;
  }

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

function flipPlane(plane: Plane): Plane {
  return { normal: { x: -plane.normal.x, y: -plane.normal.y, z: -plane.normal.z }, w: -plane.w };
}

function flipPoly(poly: Poly): Poly {
  return {
    points: [...poly.points].reverse(),
    plane: flipPlane(poly.plane),
    materialIndex: poly.materialIndex,
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
  if (frontPoints.length >= 3) {
    front.push({ points: frontPoints, plane: poly.plane, materialIndex: poly.materialIndex });
  }
  if (backPoints.length >= 3) {
    back.push({ points: backPoints, plane: poly.plane, materialIndex: poly.materialIndex });
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
      splitPoly(node.plane, poly, node.polys, node.polys, front, back, epsilon);
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

/** Drops the parts of `polys` that fall inside the solid this tree describes. */
function clipPolys(root: Node, polys: readonly Poly[], epsilon: number): Poly[] {
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
  }

  return kept;
}

function clipTo(root: Node, other: Node, epsilon: number): void {
  for (const node of nodes(root)) node.polys = clipPolys(other, node.polys, epsilon);
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
 * Constructive solid geometry over two triangle soups.
 *
 * The classic BSP formulation: each solid is clipped against the other, the
 * inversions decide which side survives, and what comes back is the boundary
 * of the combined solid. It assumes both inputs are closed — an open shell has
 * no inside for the tests to answer about, and the result will show it.
 */
function csg(
  op: BooleanOp,
  a: readonly Poly[],
  b: readonly Poly[],
  epsilon = PLANE_EPSILON * extentOf([...a, ...b]),
): Poly[] {
  const left = treeFrom(a, epsilon);
  const right = treeFrom(b, epsilon);

  if (op === 'union') {
    clipTo(left, right, epsilon);
    clipTo(right, left, epsilon);
    invert(right);
    clipTo(right, left, epsilon);
    invert(right);
    build(left, allPolys(right), epsilon);
    return allPolys(left);
  }

  if (op === 'difference') {
    invert(left);
    clipTo(left, right, epsilon);
    clipTo(right, left, epsilon);
    invert(right);
    clipTo(right, left, epsilon);
    invert(right);
    build(left, allPolys(right), epsilon);
    invert(left);
    return allPolys(left);
  }

  invert(left);
  clipTo(right, left, epsilon);
  invert(right);
  clipTo(left, right, epsilon);
  clipTo(right, left, epsilon);
  build(left, allPolys(right), epsilon);
  invert(left);
  return allPolys(left);
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
 * Reads a mesh out as triangles in the target's space.
 *
 * `toTarget` carries each point through the source object's transform and back
 * through the target's, because a boolean is only meaningful where the two
 * solids actually sit relative to each other.
 *
 * A closed solid comes out facing outward whatever it arrived as. That matters
 * because `toTarget` is free to reverse handedness — an object mirrored by a
 * negative scale on one axis, which is an ordinary thing to have in a scene —
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
  epsilon = PLANE_EPSILON,
): Poly[] {
  const polys: Poly[] = [];

  for (const face of mesh.faces.values()) {
    const points = mesh.facePoints(face).map(toTarget);
    if (points.length < 3) continue;

    const normal = polygonNormal(points);
    const slot = slotFor(face);

    // A face the boolean never touches should come out the far side as the
    // same face. Triangulating everything on the way in is what left a plain
    // union of two boxes covered in diagonals answering to nothing in the shape.
    if (isSplittable(points, normal, epsilon)) {
      const plane = planeFrom(points);
      if (usablePlane(plane)) {
        polys.push({ points, plane, materialIndex: slot });
        continue;
      }
    }

    const indices = triangulatePolygon(points, normal);
    for (let i = 0; i < indices.length; i += 3) {
      const tri = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
      const plane = planeFrom(tri);
      // A degenerate triangle has no usable plane, and one bad plane in the
      // tree misroutes every polygon sorted against it.
      if (!usablePlane(plane)) continue;
      polys.push({ points: tri, plane, materialIndex: slot });
    }
  }

  // Only for a closed mesh: an open shell encloses nothing, so the sign of its
  // volume is an accident of where it sits relative to the origin and reversing
  // it on that evidence would be worse than leaving it alone.
  if (!isClosed(mesh)) return polys;
  return sixVolume(polys) < 0 ? polys.map(flipPoly) : polys;
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
 * vertex each — without it the result is a pile of disconnected faces with no
 * edges to bevel and no loops to select.
 *
 * The second pass closes the T-junctions the split leaves behind: where one
 * triangle was cut and the neighbour it sits against was not, the cut point
 * lands part-way along the neighbour's edge and belongs to only one of them.
 * Geometrically the surface is already sealed; topologically that edge has a
 * single face on it, which reads as a crack to everything downstream. Adding
 * the point to the ring that is missing it makes the two share an edge again.
 */
function polysToMesh(
  polys: readonly Poly[],
  tolerance = WELD_EPSILON * extentOf(polys),
): BMesh {
  const mesh = new BMesh();
  const cell = Math.max(tolerance, Number.EPSILON) * 2;
  const buckets = new Map<string, Vert[]>();
  const limitSq = tolerance * tolerance;
  const bucketKey = (point: Vec3) =>
    `${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}:${Math.floor(point.z / cell)}`;

  // Neighbouring cells are searched too: quantising alone drops the weld
  // whenever two points a hair apart fall either side of a cell boundary.
  const weld = (point: Vec3): Vert => {
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

    const vert = mesh.addVert(point);
    const id = bucketKey(point);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(vert);
    else buckets.set(id, [vert]);
    return vert;
  };

  const rings: { verts: Vert[]; materialIndex: number }[] = [];
  for (const poly of polys) {
    const verts = poly.points.map(weld);
    // The weld can collapse a sliver onto itself, which is no longer a face.
    const ring = verts.filter((vert, index) => vert !== verts[(index + 1) % verts.length]);
    if (ring.length < 3) continue;
    rings.push({ verts: ring, materialIndex: poly.materialIndex });
  }

  const all = [...mesh.verts.values()];
  const index = grid(all, 32);

  for (const ring of rings) {
    const expanded: Vert[] = [];

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
      mesh.addFace(expanded, { materialIndex: ring.materialIndex });
    }
  }

  mesh.computeNormals();
  return mesh;
}

/**
 * Merges every run of touching coplanar faces back into one face.
 *
 * Region at a time rather than edge at a time. A BSP carves a face into strips
 * that often meet each other along two separate edges, and a pairwise merge
 * cannot join those: the ring it would build passes through the same vertex
 * twice, so it gives up and leaves the strips. Rebuilding the region's outline
 * in one go has no such trouble — and it steps around a region with a hole in
 * it, whose boundary is two rings rather than one, by leaving it alone.
 */
function mergeCoplanar(mesh: BMesh, limitDegrees: number): number {
  const limit = Math.cos((limitDegrees * Math.PI) / 180);
  const group = new Map<number, number>();
  for (const face of mesh.faces.values()) group.set(face.id, face.id);

  const rootOf = (id: number): number => {
    let root = id;
    while (group.get(root) !== root) root = group.get(root) as number;
    let walk = id;
    while (group.get(walk) !== root) {
      const next = group.get(walk) as number;
      group.set(walk, root);
      walk = next;
    }
    return root;
  };

  for (const edge of mesh.edges.values()) {
    const faces = mesh.edgeFaces(edge);
    if (faces.length !== 2) continue;
    if (dot(faces[0].normal, faces[1].normal) < limit) continue;
    group.set(rootOf(faces[0].id), rootOf(faces[1].id));
  }

  const regions = new Map<number, Face[]>();
  for (const face of mesh.faces.values()) {
    const root = rootOf(face.id);
    const region = regions.get(root);
    if (region) region.push(face);
    else regions.set(root, [face]);
  }

  let merged = 0;
  for (const region of regions.values()) {
    // Regions are disjoint, so the faces of the ones still to come are never
    // the ones a merge just removed.
    if (region.length > 1) merged += dissolveFaces(mesh, region).length;
  }
  return merged;
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

/** Whether a ring turns the same way at every corner, so it reads as a quad. */
function isConvexRing(points: readonly Vec3[], normal: Vec3): boolean {
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    if (dot(cross(sub(b, a), sub(c, b)), normal) < 0) return false;
  }
  return true;
}

/**
 * Pairs a polygon's triangles up into quads, taking as many pairs as it can.
 *
 * The triangles of a simple polygon meet along their shared edges in a tree, so
 * repeatedly matching whichever triangle has the fewest partners left takes the
 * maximum number of pairs — a leaf has one chance and has to use it, and
 * spending it can never cost more than it saves. That is the difference between
 * an L-shaped region coming back as two quads and coming back as a quad with
 * two triangles hanging off it.
 */
function pairTriangles(triangles: readonly number[][], normal: Vec3, points: readonly Vec3[]) {
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const byEdge = new Map<string, number[]>();

  triangles.forEach((tri, index) => {
    for (let i = 0; i < 3; i++) {
      const key = edgeKey(tri[i], tri[(i + 1) % 3]);
      const bucket = byEdge.get(key);
      if (bucket) bucket.push(index);
      else byEdge.set(key, [index]);
    }
  });

  /** The quad two triangles make, or null when it would fold back on itself. */
  const quadOf = (left: number, right: number): number[] | null => {
    const a = triangles[left];
    const b = triangles[right];
    const shared = a.filter((index) => b.includes(index));
    if (shared.length !== 2) return null;

    const lone = a.find((index) => !shared.includes(index));
    const apex = b.find((index) => !shared.includes(index));
    if (lone === undefined || apex === undefined) return null;

    // Wound off the first triangle: its own corner, then round through the
    // partner's, so the ring traces the pair's outline rather than crossing it.
    const start = a.indexOf(lone);
    const quad = [lone, a[(start + 1) % 3], apex, a[(start + 2) % 3]];
    return isConvexRing(
      quad.map((index) => points[index]),
      normal,
    )
      ? quad
      : null;
  };

  const partners = triangles.map((_, index) => {
    const found = new Set<number>();
    for (const bucket of byEdge.values()) {
      if (!bucket.includes(index)) continue;
      for (const other of bucket) {
        if (other !== index && quadOf(index, other)) found.add(other);
      }
    }
    return found;
  });

  const taken = new Set<number>();
  const rings: number[][] = [];

  for (;;) {
    let next = -1;
    let fewest = Infinity;
    for (let i = 0; i < triangles.length; i++) {
      if (taken.has(i)) continue;
      const open = [...partners[i]].filter((other) => !taken.has(other));
      if (open.length > 0 && open.length < fewest) {
        fewest = open.length;
        next = i;
      }
    }
    if (next === -1) break;

    const partner = [...partners[next]].find((other) => !taken.has(other)) as number;
    const quad = quadOf(next, partner);
    taken.add(next);
    taken.add(partner);
    rings.push(quad ?? triangles[next]);
    if (!quad) taken.delete(partner);
  }

  for (let i = 0; i < triangles.length; i++) {
    if (!taken.has(i)) rings.push(triangles[i]);
  }

  return rings;
}

/**
 * Splits every n-gon into quads and triangles.
 *
 * Ear clipping rather than a fan from one corner: after the merge above, a
 * region can be an L and a fan would reach straight across the notch. The
 * clipper also takes strictly-turning corners only, so it works around the
 * vertices left sitting part-way along a straight side rather than making
 * pieces with no area out of them. The pieces are then paired back up, so what
 * comes out is quads wherever the region's vertex count allows.
 */
function retile(mesh: BMesh): void {
  for (const face of [...mesh.faces.values()]) {
    const ring = mesh.faceVerts(face);
    if (ring.length <= 4) continue;

    const { materialIndex, smooth } = face;
    const points = ring.map((vert) => vert.co);
    const normal = polygonNormal(points);
    const indices = triangulatePolygon(points, normal);
    if (indices.length < 3) continue;

    const triangles: number[][] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const tri = [indices[i], indices[i + 1], indices[i + 2]];
      if (new Set(tri).size === 3) triangles.push(tri);
    }

    mesh.removeFace(face);
    for (const piece of pairTriangles(triangles, normal, points)) {
      // No area test: the tiling covers the ring exactly, so leaving a piece
      // out is what would open it up.
      mesh.addFace(
        piece.map((index) => ring[index]),
        { materialIndex, smooth },
      );
    }
  }
}

/**
 * Puts the raw boolean output back into a shape someone could model with.
 *
 * A BSP splits every polygon by every plane in the tree, not only by the ones
 * that end up bounding the solid, so the surface comes back carved along lines
 * the finished shape has no reason to show. Merging the coplanar neighbours
 * back together undoes that; the vertices left stranded mid-edge by it are then
 * no longer holding anything, and go too. Only what survives both is a real
 * feature of the cut, and only that gets tiled.
 */
function resolve(mesh: BMesh, epsilon: number): void {
  // Both halves feed each other, so they run until neither has anything left
  // to do: merging two faces can strand the vertex that was holding their
  // shared edge, and removing that vertex can free the next merge along. One
  // pass of each leaves most of a stepped union still carved into strips.
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    // A region with a hole in it has two boundary rings, which the region
    // merge steps around; its strips still deserve joining up pairwise, which
    // is all a bored-through face ever needs.
    const merged =
      mergeCoplanar(mesh, COPLANAR_LIMIT_DEGREES) +
      limitedDissolve(mesh, COPLANAR_LIMIT_DEGREES).length;

    const stranded = [...mesh.verts.values()].filter((vert) => isRedundant(mesh, vert, epsilon));
    if (stranded.length > 0) dissolveVerts(mesh, stranded);

    if (merged === 0 && stranded.length === 0) break;
  }

  retile(mesh);
  trisToQuads(mesh, [...mesh.faces.values()], 1);
}

/**
 * One boolean, mesh in and mesh out, in the target's local space.
 *
 * The quad pass at the end is what makes the result workable rather than
 * merely correct: a cut leaves triangles along its seam, and pairing the
 * coplanar ones back up gives edge loops that run where the shape actually
 * turns. The angle limit is tight on purpose — merging across a real crease
 * would flatten the very edges the boolean just created.
 */
export function booleanMesh(
  op: BooleanOp,
  target: BMesh,
  tool: BMesh,
  toTarget: (point: Vec3) => Vec3,
  toolSlot: (face: Face) => number = (face) => face.materialIndex,
): BMesh {
  const a = meshToPolys(target, (point) => point);
  const b = meshToPolys(tool, toTarget, toolSlot);

  // One scale for the whole operation, taken from both solids together: a
  // small tool cutting a large target has to be measured against the pair,
  // not against whichever of them happens to be under the tolerance first.
  const scale = extentOf([...a, ...b]);
  const mesh = polysToMesh(csg(op, a, b, PLANE_EPSILON * scale), WELD_EPSILON * scale);

  resolve(mesh, PLANE_EPSILON);
  mesh.computeNormals();
  return mesh;
}
