import {
  type Vec3,
  add,
  centroid,
  cross,
  distance,
  distanceSq,
  dot,
  lerp,
  normalize,
  polygonNormal,
  sub,
  vec3,
} from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Vert } from '../mesh/types';

import { type KnifePoint, knifeCut, knifeSegmentFace } from './knife';

export type ConnectPathResult =
  | {
      connected: true;
      /** Every edge the path now runs along, new or already there. */
      edges: Edge[];
      /** Vertices added where the path crosses an edge. */
      verts: Vert[];
      /** How many times a face was divided in two. */
      splits: number;
    }
  | {
      connected: false;
      /** Where in the sequence the gap is: no surface runs from `verts[gap]` to the next. */
      gap: number;
    };

/** How far off the cutting plane a vertex may sit, against the span it cuts, and still be on it. */
const ON_PLANE = 1e-6;

/**
 * Joins vertices one after the next, cutting across every face in between.
 *
 * Each pair is joined along the surface, not through space: the path runs where
 * a plane through both vertices, stood up along the surface, meets the mesh. A
 * new vertex goes on every edge it crosses and each face it passes over is
 * divided along it, so the faces either side end up separate and nothing is left
 * hanging in the middle of a face or an edge. Where the plane passes through a
 * vertex already there, the path uses that vertex rather than one beside it.
 *
 * A vertex with no face at all can only be joined by a plain edge. Two vertices
 * on faces that no path across the surface links (separate islands) stop the
 * whole sequence before anything changes, and the result says where.
 */
export function connectVertPath(mesh: BMesh, verts: readonly Vert[]): ConnectPathResult {
  const runs: KnifePoint[][] = [];
  const bare: [Vert, Vert][] = [];

  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i];
    const b = verts[i + 1];
    if (a === b) continue;
    const loose = mesh.vertFaces(a).length === 0 || mesh.vertFaces(b).length === 0;
    if (loose && !mesh.findEdge(a, b)) bare.push([a, b]);
    else {
      const path = surfacePath(mesh, a, b);
      if (!path) return { connected: false, gap: i };
      runs.push(path);
    }
  }

  // Every path is found on the mesh as it stands, and the knife cuts them all
  // at once, so two paths over one face divide it where they cross.
  const cut = knifeCut(mesh, runs);
  const edges = [...cut.edges, ...bare.map(([a, b]) => mesh.addEdge(a, b))];
  return { connected: true, edges, verts: cut.verts, splits: cut.splits };
}

/**
 * The order to connect vertices in: the order they were picked when every one
 * was picked by hand, and otherwise a chain from one end of the selection,
 * stepping each time to the nearest vertex not yet on it.
 */
export function connectionOrder(verts: readonly Vert[]): Vert[] {
  const seqs = new Set(verts.map((vert) => vert.selectSeq));
  if (verts.every((vert) => vert.selectSeq > 0) && seqs.size === verts.length) {
    return [...verts].sort((a, b) => a.selectSeq - b.selectSeq);
  }
  if (verts.length === 0) return [];

  const middle = centroid(verts.map((vert) => vert.co));
  const left = new Set(verts);
  let current = verts.reduce((far, vert) =>
    distanceSq(vert.co, middle) > distanceSq(far.co, middle) ? vert : far,
  );
  const chain: Vert[] = [];
  while (current) {
    chain.push(current);
    left.delete(current);
    let nearest: Vert | undefined;
    for (const vert of left) {
      if (!nearest || distanceSq(vert.co, current.co) < distanceSq(nearest.co, current.co)) {
        nearest = vert;
      }
    }
    if (!nearest) break;
    current = nearest;
  }
  return chain;
}

function vertPoint(vert: Vert): KnifePoint {
  return { kind: 'vert', vert: vert.id };
}

/**
 * The shortest run of knife points across the surface from `a` to `b`, each
 * straight piece inside one face, or null when none reaches.
 *
 * The plane stood up along the averaged surface comes first. On a surface that
 * winds, such as a torus, it can meet the mesh in pieces that never join up, so
 * the planes stood up along each face round either end come next, then the axes.
 * When none of them reaches, the pair is joined through the vertex halfway along
 * the fewest edges between them, each half cut the same way. Halving ends at two
 * neighbours, so only vertices no edges link at all come back null.
 */
function surfacePath(mesh: BMesh, a: Vert, b: Vert): KnifePoint[] | null {
  if (mesh.findEdge(a, b)) return [vertPoint(a), vertPoint(b)];

  const planar = planePath(mesh, a, b);
  if (planar) return planar;

  const route = edgeRoute(a, b);
  if (!route) return null;
  const middle = route[Math.floor(route.length / 2)];
  const first = surfacePath(mesh, a, middle);
  const second = surfacePath(mesh, middle, b);
  return first && second ? [...first, ...second.slice(1)] : null;
}

/** The vertices along the fewest edges from `a` to `b`, both included, or null when none link them. */
function edgeRoute(a: Vert, b: Vert): Vert[] | null {
  const prev = new Map<Vert, Vert | null>([[a, null]]);
  const queue = [a];
  for (let i = 0; i < queue.length; i++) {
    const vert = queue[i];
    if (vert === b) {
      const route: Vert[] = [];
      for (let at: Vert | null = b; at; at = prev.get(at) ?? null) route.unshift(at);
      return route;
    }
    for (const edge of vert.edges) {
      const other = edge.v0 === vert ? edge.v1 : edge.v0;
      if (prev.has(other)) continue;
      prev.set(other, vert);
      queue.push(other);
    }
  }
  return null;
}

function planePath(mesh: BMesh, a: Vert, b: Vert): KnifePoint[] | null {
  const span = sub(b.co, a.co);
  const ups = [...mesh.vertFaces(a), ...mesh.vertFaces(b)].map((face) =>
    polygonNormal(mesh.faceVerts(face).map((vert) => vert.co)),
  );
  const tried: Vec3[] = [];
  for (const up of [
    ups.reduce(add, vec3(0, 0, 0)),
    ...ups,
    vec3(1, 0, 0),
    vec3(0, 1, 0),
    vec3(0, 0, 1),
  ]) {
    const normal = normalize(cross(span, up));
    if (normal.x === 0 && normal.y === 0 && normal.z === 0) continue;
    if (tried.some((other) => Math.abs(dot(other, normal)) > 1 - 1e-9)) continue;
    tried.push(normal);
    const path = walkPlane(mesh, a, b, normal);
    if (path) return path;
  }
  return null;
}

interface Step {
  point: KnifePoint;
  co: Vec3;
  cost: number;
  prev: Step | null;
}

/**
 * Walks from face to face where the plane through `a` with this normal meets
 * the mesh, shortest way first, until it reaches `b`.
 */
function walkPlane(mesh: BMesh, a: Vert, b: Vert, normal: Vec3): KnifePoint[] | null {
  const tolerance = distance(a.co, b.co) * ON_PLANE;
  const side = (vert: Vert) => dot(sub(vert.co, a.co), normal);
  const key = (point: KnifePoint) =>
    point.kind === 'vert' ? `v${point.vert}` : point.kind === 'edge' ? `e${point.edge}` : '';

  const best = new Map<string, Step>();
  const done = new Set<string>();
  const open: Step[] = [{ point: vertPoint(a), co: a.co, cost: 0, prev: null }];
  best.set(key(open[0].point), open[0]);

  const reach = (from: Step, point: KnifePoint, co: Vec3) => {
    const id = key(point);
    if (id === key(from.point) || done.has(id)) return;
    const cost = from.cost + distance(from.co, co);
    const known = best.get(id);
    if (known && known.cost <= cost) return;
    if (!pieceOnFace(mesh, from.point, point)) return;
    const step = { point, co, cost, prev: from };
    best.set(id, step);
    open.push(step);
  };

  while (open.length > 0) {
    let index = 0;
    for (let i = 1; i < open.length; i++) if (open[i].cost < open[index].cost) index = i;
    const [step] = open.splice(index, 1);
    const id = key(step.point);
    if (done.has(id) || best.get(id) !== step) continue;
    done.add(id);

    if (step.point.kind === 'vert' && step.point.vert === b.id) {
      const path: KnifePoint[] = [];
      for (let at: Step | null = step; at; at = at.prev) path.unshift(at.point);
      return path;
    }

    const here = step.point;
    const faces =
      here.kind === 'vert'
        ? mesh.vertFaces(mesh.verts.get(here.vert) as Vert)
        : here.kind === 'edge'
          ? mesh.edgeFaces(mesh.edges.get(here.edge) as Edge)
          : [];
    for (const face of faces) {
      for (const vert of mesh.faceVerts(face)) {
        if (Math.abs(side(vert)) <= tolerance) reach(step, vertPoint(vert), vert.co);
      }
      for (const edge of mesh.faceEdges(face)) {
        const d0 = side(edge.v0);
        const d1 = side(edge.v1);
        if (Math.abs(d0) <= tolerance || Math.abs(d1) <= tolerance || d0 < 0 === d1 < 0) continue;
        const t = d0 / (d0 - d1);
        reach(step, { kind: 'edge', edge: edge.id, t }, lerp(edge.v0.co, edge.v1.co, t));
      }
    }
  }
  return null;
}

/** Whether a straight piece between two points lies on the surface: across a face, or along an edge. */
function pieceOnFace(mesh: BMesh, from: KnifePoint, to: KnifePoint): boolean {
  if (from.kind === 'vert' && to.kind === 'vert') {
    const a = mesh.verts.get(from.vert);
    const b = mesh.verts.get(to.vert);
    if (a && b && mesh.findEdge(a, b)) return true;
  }
  return knifeSegmentFace(mesh, from, to) !== null;
}
