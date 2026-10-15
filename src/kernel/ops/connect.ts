import { type Vec3, centroid, distance, distanceSq, dot, lerp, sub } from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Vert } from '../mesh/types';

import { type KnifePoint, knifeCut, knifeSegmentFace } from './knife';

export interface ConnectPathResult {
  /** Every edge the path now runs along, new or already there. */
  edges: Edge[];
  /** Vertices added where the path crosses an edge. */
  verts: Vert[];
  /** How many times a face was divided in two. */
  splits: number;
}

/**
 * How far off the straight line a point may sit, against the line's length, and
 * still be on it. Loose enough for a surface that is flat up to rounding.
 */
const ON_LINE = 1e-4;

/**
 * Joins vertices one after the next along the straight line between each pair.
 *
 * Where that line lies on the surface the whole way, every face under it is cut
 * along it: a new vertex goes on each edge it crosses, a vertex it passes
 * through is used rather than one beside it, and the faces either side end up
 * separate. Where it leaves the surface, through the air or through the inside
 * of a solid, the pair gets a plain edge and no face is touched.
 */
export function connectVertPath(mesh: BMesh, verts: readonly Vert[]): ConnectPathResult {
  const runs: KnifePoint[][] = [];
  const bare: [Vert, Vert][] = [];

  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i];
    const b = verts[i + 1];
    if (a === b) continue;
    const path = mesh.findEdge(a, b) ? [vertPoint(a), vertPoint(b)] : linePath(mesh, a, b);
    if (path) runs.push(path);
    else bare.push([a, b]);
  }

  // Every path is found on the mesh as it stands, and the knife cuts them all
  // at once, so two paths over one face divide it where they cross.
  const cut = knifeCut(mesh, runs);
  const edges = [...cut.edges, ...bare.map(([a, b]) => mesh.addEdge(a, b))];
  return { edges, verts: cut.verts, splits: cut.splits };
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

interface Step {
  point: KnifePoint;
  /** How far along the line from `a` to `b`, 0 to 1. */
  along: number;
  prev: Step | null;
}

/**
 * The knife points along the straight line from `a` to `b`, each piece between
 * two of them inside one face, or null when the line leaves the surface.
 *
 * Walks from face to face, always forward along the line, through the vertices
 * on it and the points where it crosses edges.
 */
function linePath(mesh: BMesh, a: Vert, b: Vert): KnifePoint[] | null {
  const span = sub(b.co, a.co);
  const lengthSq = dot(span, span);
  if (lengthSq === 0) return null;
  const tolerance = Math.sqrt(lengthSq) * ON_LINE;
  const alongLine = (co: Vec3): number | null => {
    const t = dot(sub(co, a.co), span) / lengthSq;
    return distance(co, lerp(a.co, b.co, t)) <= tolerance ? t : null;
  };
  /** Where along the edge it comes nearest the line, or null when that is at or past an end. */
  const nearest = (edge: Edge): number | null => {
    const d = sub(edge.v1.co, edge.v0.co);
    const r = sub(edge.v0.co, a.co);
    const dd = dot(d, d);
    const ds = dot(d, span);
    const denom = dd * lengthSq - ds * ds;
    if (denom <= 1e-12 * dd * lengthSq) return null;
    const t = (ds * dot(span, r) - lengthSq * dot(d, r)) / denom;
    return t > 0 && t < 1 ? t : null;
  };
  const key = (point: KnifePoint) =>
    point.kind === 'vert' ? `v${point.vert}` : point.kind === 'edge' ? `e${point.edge}` : '';

  const seen = new Set<string>();
  const open: Step[] = [{ point: vertPoint(a), along: 0, prev: null }];
  seen.add(key(open[0].point));

  const reach = (from: Step, point: KnifePoint, along: number | null) => {
    if (along === null || along <= from.along || along > 1 + ON_LINE) return;
    const id = key(point);
    if (seen.has(id) || !pieceOnFace(mesh, from.point, point)) return;
    seen.add(id);
    open.push({ point, along, prev: from });
  };

  while (open.length > 0) {
    let index = 0;
    for (let i = 1; i < open.length; i++) if (open[i].along < open[index].along) index = i;
    const [step] = open.splice(index, 1);

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
      for (const vert of mesh.faceVerts(face)) reach(step, vertPoint(vert), alongLine(vert.co));
      for (const edge of mesh.faceEdges(face)) {
        if (alongLine(edge.v0.co) !== null || alongLine(edge.v1.co) !== null) continue;
        const t = nearest(edge);
        if (t === null) continue;
        const co = lerp(edge.v0.co, edge.v1.co, t);
        reach(step, { kind: 'edge', edge: edge.id, t }, alongLine(co));
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
