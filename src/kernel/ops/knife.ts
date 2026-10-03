import {
  type Vec3,
  basisFromNormal,
  distanceSq,
  dot,
  lerp,
  polygonArea,
  polygonNormal,
  sub,
} from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, Loop, Vert } from '../mesh/types';

import { carrySharp } from './normals';

/**
 * Where a knife cut touches the mesh: on a vertex, part of the way along an
 * edge, or somewhere inside a face.
 *
 * Held by id rather than by reference: a cut is drawn over several clicks and
 * handed to the operator table, which is the scripting boundary. `t` runs from
 * the edge's `v0` to its `v1`, and `co` is in the object's own space.
 */
export type KnifePoint =
  | { kind: 'vert'; vert: number }
  | { kind: 'edge'; edge: number; t: number }
  | { kind: 'face'; face: number; co: Vec3 };

export interface KnifeCutResult {
  /** Vertices the cut added: on the edges it crossed, and inside the faces it bent in. */
  verts: Vert[];
  /** Every edge the cut now runs along, new or already there. */
  edges: Edge[];
  /** How many times a face was divided in two. */
  splits: number;
  /** New edges that divide nothing, because their part of the cut stops inside a face. */
  loose: number;
}

/**
 * How near an end of its edge a point may fall before it is taken as that end.
 *
 * A cut a ten-thousandth of the way along an edge leaves a sliver nobody aimed
 * for, and the vertex beside it is what was meant.
 */
const EDGE_END = 1e-4;

/** Two points this close along one edge are one point. */
const SAME_ALONG = 1e-6;

/** Two points inside a face this close (squared, in object units) are one point. */
const SAME_SPOT_SQ = 1e-12;

/**
 * How small a piece of a divided face may be, against the face it came from.
 *
 * A cut run along the face's own border has nothing to divide, and going ahead
 * would leave a face of no area folded against the border.
 */
const MIN_PIECE_AREA = 1e-9;

/** Where a knife point sits, in object space, or null when the mesh no longer has it. */
export function knifePointPosition(mesh: BMesh, point: KnifePoint): Vec3 | null {
  if (point.kind === 'vert') return mesh.verts.get(point.vert)?.co ?? null;
  if (point.kind === 'face') return mesh.faces.has(point.face) ? point.co : null;
  const edge = mesh.edges.get(point.edge);
  return edge ? lerp(edge.v0.co, edge.v1.co, point.t) : null;
}

/**
 * The face a straight piece of cut between two points runs across.
 *
 * Null when the piece runs along an edge that is already there, or over no face
 * the two points share: across empty space, or round the outside of a face that
 * bends back on itself. A face both points touch only counts when the middle of
 * the piece lies inside it, which is what tells those last two apart.
 */
export function knifeSegmentFace(mesh: BMesh, a: KnifePoint, b: KnifePoint): Face | null {
  if (runsAlongEdge(mesh, a, b)) return null;

  const from = knifePointPosition(mesh, a);
  const to = knifePointPosition(mesh, b);
  if (!from || !to) return null;

  const others = new Set(knifePointFaces(mesh, b).map((face) => face.id));
  const middle = lerp(from, to, 0.5);
  for (const face of knifePointFaces(mesh, a)) {
    if (others.has(face.id) && insideFace(mesh, face, middle)) return face;
  }
  return null;
}

/**
 * Cuts the mesh along runs of knife points.
 *
 * Each run is a line drawn across the surface, with a point wherever it touches
 * the mesh: every vertex it passes through and every edge it crosses, as well as
 * wherever it was clicked. Each straight piece between two neighbouring points
 * lies inside one face, and the cut goes face by face:
 *
 * 1. Pieces inside one face that cross get a point where they cross, and a piece
 *    ending on another splits that one where it lands.
 * 2. Every edge with a point on it is split there, and a vertex is made for
 *    every point inside a face.
 * 3. The face is divided along every path its pieces make from a point on its
 *    border to another one, through points inside it. A piece left over, from
 *    a line that stops inside the face, divides nothing and stays as a loose
 *    edge: a face is one ring of corners, with no room in it for a slit.
 *
 * Neither the order of the runs nor of the pieces in them makes a difference.
 * Points closer than the tolerances above are one point, so a run ending where
 * it began closes, and a run of fewer than two points cuts nothing at all.
 */
export function knifeCut(mesh: BMesh, runs: readonly (readonly KnifePoint[])[]): KnifeCutResult {
  const nodes = new NodeTable(mesh);
  const byFace = new Map<Face, Pair<Node>[]>();
  const along: Pair<Node>[] = [];

  for (const run of runs) {
    const points = withoutRepeats(run.map((point) => nodes.node(point)).filter(isNode));
    for (let i = 0; i < points.length - 1; i++) {
      const pair: Pair<Node> = [points[i], points[i + 1]];
      // Read off the mesh as it stands, before any of it is cut: these are the
      // faces and edges the points' ids name.
      const face = knifeSegmentFace(mesh, pair[0].point, pair[1].point);
      if (face) byFace.set(face, [...(byFace.get(face) ?? []), pair]);
      else if (runsAlongEdge(mesh, pair[0].point, pair[1].point)) along.push(pair);
    }
  }

  for (const [face, pieces] of byFace) byFace.set(face, meetPieces(mesh, face, pieces, nodes));

  const created = nodes.build(new Set([...[...byFace.values()].flat(2), ...along.flat()]));
  const cut = new Set<Edge>();
  let splits = 0;
  let loose = 0;

  // Along an edge the cut adds nothing, but that edge is part of it.
  for (const [a, b] of along) {
    const edge = mesh.findEdge(nodes.vert(a), nodes.vert(b));
    if (edge) cut.add(edge);
  }

  /**
   * Divides whichever face a path runs across, from its first vertex to its
   * last, through the free vertices between. Two ends an edge already joins
   * count as done: that edge is the cut.
   */
  const divide = (path: readonly Vert[]): boolean => {
    const from = path[0];
    const to = path[path.length - 1];
    const inner = path.slice(1, -1);

    const existing = inner.length === 0 ? mesh.findEdge(from, to) : null;
    if (existing) {
      cut.add(existing);
      return true;
    }

    const probe = lerp(from.co, path[1].co, 0.5);
    const face = mesh
      .vertFaces(from)
      .find(
        (candidate) => mesh.faceVerts(candidate).includes(to) && insideFace(mesh, candidate, probe),
      );
    if (!face || !splitFace(mesh, face, from, inner, to)) return false;

    splits++;
    for (let i = 0; i < path.length - 1; i++) {
      const edge = mesh.findEdge(path[i], path[i + 1]);
      if (edge) cut.add(edge);
    }
    return true;
  };

  for (const pieces of byFace.values()) {
    let net = pieces
      .map(([a, b]): Pair<Vert> => [nodes.vert(a), nodes.vert(b)])
      .filter(([a, b]) => a !== b);

    // Each path taken puts its inner vertices on a border, which can open up
    // the next one: the middle of a cross only reaches a border once one of
    // its two lines has divided the face.
    let taken = divideOnce(net, divide);
    while (taken) {
      const path = taken;
      const used = new Set(path.slice(1).map((vert, i) => pairKey(path[i], vert)));
      net = net.filter(([a, b]) => !used.has(pairKey(a, b)));
      taken = divideOnce(net, divide);
    }

    for (const [a, b] of net) {
      const existing = mesh.findEdge(a, b);
      if (!existing) loose++;
      cut.add(existing ?? mesh.addEdge(a, b));
    }
  }

  // A point inside a face that no piece of the cut reached has nothing to hold.
  const kept = created.filter((vert) => {
    if (vert.edges.length > 0) return true;
    mesh.removeVert(vert);
    return false;
  });

  mesh.computeNormals();
  return {
    verts: kept,
    edges: [...cut].filter((edge) => mesh.edges.has(edge.id)),
    splits,
    loose,
  };
}

type Pair<T> = [T, T];

/** One key for a pair of vertices, whichever way round they come. */
function pairKey(a: Vert, b: Vert): string {
  return a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
}

/**
 * Divides a face along the first path through the net that will divide one,
 * and hands it back, or null when no path does.
 *
 * A path starts on a face's border, runs through vertices inside the face and
 * ends on a border again, at another vertex. Stopping at the first one that
 * divides matters: dividing moves the border, and the paths still to come were
 * worked out against the old one.
 */
function divideOnce(
  net: readonly Pair<Vert>[],
  divide: (path: readonly Vert[]) => boolean,
): Vert[] | null {
  const next = new Map<Vert, Vert[]>();
  for (const [a, b] of net) {
    next.set(a, [...(next.get(a) ?? []), b]);
    next.set(b, [...(next.get(b) ?? []), a]);
  }

  const path: Vert[] = [];
  const walk = (vert: Vert): Vert[] | null => {
    path.push(vert);
    for (const neighbour of next.get(vert) ?? []) {
      if (path.includes(neighbour)) continue;
      const found = onFace(neighbour)
        ? divide([...path, neighbour])
          ? [...path, neighbour]
          : null
        : walk(neighbour);
      if (found) return found;
    }
    path.pop();
    return null;
  };

  for (const start of next.keys()) {
    if (!onFace(start)) continue;
    const found = walk(start);
    if (found) return found;
  }
  return null;
}

/** How far into a piece another must reach, as a fraction of it, to meet it rather than its end. */
const INSIDE_PIECE = 1e-9;

/**
 * The pieces inside one face, split wherever two of them meet.
 *
 * Two pieces that cross get a point of their own where they cross, and a piece
 * ending on another splits that one where it lands, so the face divides along
 * both rather than having one lying across the other. Worked flat, on the plane
 * the face's corners average to.
 */
function meetPieces(
  mesh: BMesh,
  face: Face,
  pieces: readonly Pair<Node>[],
  nodes: NodeTable,
): Pair<Node>[] {
  if (pieces.length < 2) return [...pieces];

  const { u, v } = basisFromNormal(polygonNormal(mesh.facePoints(face)));
  const flat = (node: Node) => ({ x: dot(node.co, u), y: dot(node.co, v) });
  const meets = pieces.map(() => [] as { at: number; node: Node }[]);
  const inside = (at: number) => at > INSIDE_PIECE && at < 1 - INSIDE_PIECE;

  /** How far along a piece a point lies, when it lies on the piece short of either end. */
  const landing = (node: Node, [from, to]: Pair<Node>): number | null => {
    const p = flat(from);
    const q = flat(to);
    const n = flat(node);
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const span = dx * dx + dy * dy;
    if (span === 0) return null;
    const at = ((n.x - p.x) * dx + (n.y - p.y) * dy) / span;
    const off = Math.abs((n.x - p.x) * dy - (n.y - p.y) * dx) / span;
    return inside(at) && off <= INSIDE_PIECE ? at : null;
  };

  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const first = pieces[i];
      const second = pieces[j];
      if (first.some((node) => second.includes(node))) continue;

      for (const node of second) {
        const at = landing(node, first);
        if (at !== null) meets[i].push({ at, node });
      }
      for (const node of first) {
        const at = landing(node, second);
        if (at !== null) meets[j].push({ at, node });
      }

      const p = flat(first[0]);
      const q = flat(first[1]);
      const r = flat(second[0]);
      const s = flat(second[1]);
      const d1 = { x: q.x - p.x, y: q.y - p.y };
      const d2 = { x: s.x - r.x, y: s.y - r.y };
      const denominator = d1.x * d2.y - d1.y * d2.x;
      if (Math.abs(denominator) <= 1e-12 * Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)) {
        continue;
      }

      const w = { x: r.x - p.x, y: r.y - p.y };
      const alongFirst = (w.x * d2.y - w.y * d2.x) / denominator;
      const alongSecond = (w.x * d1.y - w.y * d1.x) / denominator;
      if (!inside(alongFirst) || !inside(alongSecond)) continue;

      const node = nodes.node({
        kind: 'face',
        face: face.id,
        co: lerp(first[0].co, first[1].co, alongFirst),
      });
      if (!node) continue;
      meets[i].push({ at: alongFirst, node });
      meets[j].push({ at: alongSecond, node });
    }
  }

  return pieces.flatMap((piece, i) => {
    const chain = withoutRepeats([
      piece[0],
      ...meets[i].sort((a, b) => a.at - b.at).map(({ node }) => node),
      piece[1],
    ]);
    return chain.slice(1).map((node, k): Pair<Node> => [chain[k], node]);
  });
}

/** A vertex is on a face's border once any face has it as a corner. */
function onFace(vert: Vert): boolean {
  return vert.edges.some((edge) => edge.loops.length > 0);
}

/**
 * A point of the cut, standing for the vertex it turns into.
 *
 * One per distinct point: two clicks on the same spot, or a run closing where
 * it began, share a node, and so share the vertex.
 */
interface Node {
  point: KnifePoint;
  co: Vec3;
}

function isNode(node: Node | null): node is Node {
  return node !== null;
}

/** Drops a point repeated straight after itself, which would be a piece of no length. */
function withoutRepeats(run: readonly Node[]): Node[] {
  return run.filter((node, i) => i === 0 || node !== run[i - 1]);
}

/**
 * Every point of a cut, made unique, and the vertex each one becomes.
 *
 * Built in two halves on purpose: nodes are handed out while the mesh still has
 * every element their ids name, and `build` only cuts once all of them are
 * known, since splitting an edge takes away the id its other points name.
 */
class NodeTable {
  private readonly verts = new Map<number, Node>();
  private readonly edges = new Map<number, Node[]>();
  private readonly faces = new Map<number, Node[]>();
  private readonly made = new Map<Node, Vert>();

  constructor(private readonly mesh: BMesh) {}

  /** The node for a point, or null for one naming something the mesh does not have. */
  node(raw: KnifePoint): Node | null {
    const point = settle(this.mesh, raw);
    const co = point ? knifePointPosition(this.mesh, point) : null;
    if (!point || !co) return null;

    if (point.kind === 'vert') {
      const known = this.verts.get(point.vert);
      if (known) return known;
      const node = { point, co };
      this.verts.set(point.vert, node);
      return node;
    }

    const table = point.kind === 'edge' ? this.edges : this.faces;
    const id = point.kind === 'edge' ? point.edge : point.face;
    const siblings = table.get(id) ?? [];
    const same = siblings.find((other) => samePoint(other.point, point));
    if (same) return same;

    const node = { point, co };
    siblings.push(node);
    table.set(id, siblings);
    return node;
  }

  /** Splits the edges and makes the face vertices the cut uses; returns every vertex it made. */
  build(used: ReadonlySet<Node>): Vert[] {
    const created: Vert[] = [];

    const cuts = new Map<Edge, Node[]>();
    for (const [id, nodes] of this.edges) {
      const edge = this.mesh.edges.get(id);
      const kept = nodes.filter((node) => used.has(node));
      if (!edge || kept.length === 0) continue;
      cuts.set(
        edge,
        kept.sort((a, b) => along(a) - along(b)),
      );
    }

    const split = splitEdges(
      this.mesh,
      new Map([...cuts].map(([edge, nodes]) => [edge, nodes.map(along)])),
    );
    for (const [edge, nodes] of cuts) {
      const verts = split.get(edge) ?? [];
      nodes.forEach((node, i) => this.made.set(node, verts[i]));
      created.push(...verts);
    }

    for (const nodes of this.faces.values()) {
      for (const node of nodes) {
        if (!used.has(node)) continue;
        const vert = this.mesh.addVert(node.co);
        this.made.set(node, vert);
        created.push(vert);
      }
    }

    return created;
  }

  vert(node: Node): Vert {
    const point = node.point;
    const vert = point.kind === 'vert' ? this.mesh.verts.get(point.vert) : this.made.get(node);
    if (!vert) throw new Error('A knife point was read before the cut was built');
    return vert;
  }
}

function along(node: Node): number {
  return node.point.kind === 'edge' ? node.point.t : 0;
}

/**
 * A point checked against the mesh: null when what it names is gone, and an
 * edge point at the very end of its edge taken as the vertex there.
 */
function settle(mesh: BMesh, point: KnifePoint): KnifePoint | null {
  if (point.kind === 'vert') return mesh.verts.has(point.vert) ? point : null;
  if (point.kind === 'face') return mesh.faces.has(point.face) ? point : null;

  const edge = mesh.edges.get(point.edge);
  if (!edge || !Number.isFinite(point.t)) return null;
  if (point.t <= EDGE_END) return { kind: 'vert', vert: edge.v0.id };
  if (point.t >= 1 - EDGE_END) return { kind: 'vert', vert: edge.v1.id };
  return point;
}

function samePoint(a: KnifePoint, b: KnifePoint): boolean {
  if (a.kind === 'edge' && b.kind === 'edge') return Math.abs(a.t - b.t) <= SAME_ALONG;
  if (a.kind === 'face' && b.kind === 'face') return distanceSq(a.co, b.co) <= SAME_SPOT_SQ;
  return false;
}

/** The faces a point lies on: round a vertex, either side of an edge, or the one it is inside. */
export function knifePointFaces(mesh: BMesh, point: KnifePoint): Face[] {
  if (point.kind === 'vert') {
    const vert = mesh.verts.get(point.vert);
    return vert ? mesh.vertFaces(vert) : [];
  }
  if (point.kind === 'edge') {
    const edge = mesh.edges.get(point.edge);
    return edge ? mesh.edgeFaces(edge) : [];
  }
  const face = mesh.faces.get(point.face);
  return face ? [face] : [];
}

/** Whether two points lie on one edge already there, end to end or part of the way along it. */
function runsAlongEdge(mesh: BMesh, a: KnifePoint, b: KnifePoint): boolean {
  if (a.kind === 'face' || b.kind === 'face') return false;
  if (a.kind === 'edge' && b.kind === 'edge') return a.edge === b.edge;

  if (a.kind === 'vert' && b.kind === 'vert') {
    const first = mesh.verts.get(a.vert);
    const second = mesh.verts.get(b.vert);
    return first !== undefined && second !== undefined && mesh.findEdge(first, second) !== null;
  }

  const edgeId = a.kind === 'edge' ? a.edge : b.kind === 'edge' ? b.edge : -1;
  const vertId = a.kind === 'vert' ? a.vert : b.kind === 'vert' ? b.vert : -1;
  const edge = mesh.edges.get(edgeId);
  return edge !== undefined && (edge.v0.id === vertId || edge.v1.id === vertId);
}

/**
 * Whether a point lies inside a face, seen square on to it.
 *
 * Even-odd against the face's own outline, laid flat on the plane its corners
 * average to, so a quad that is not quite flat still answers for a point the
 * cut put on it.
 */
function insideFace(mesh: BMesh, face: Face, point: Vec3): boolean {
  const corners = mesh.facePoints(face);
  const { u, v } = basisFromNormal(polygonNormal(corners));
  const x = dot(point, u);
  const y = dot(point, v);

  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const xi = dot(corners[i], u);
    const yi = dot(corners[i], v);
    const xj = dot(corners[j], u);
    const yj = dot(corners[j], v);
    if (yi > y === yj > y) continue;
    if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Splits edges at the parameters asked of them, splicing the new vertices into
 * every face each edge borders.
 *
 * Every such face is rebuilt with the new corners in the order it walks the
 * edge, which runs `v1` to `v0` for one of the two, and with UVs carried along
 * the edge, so an image plane keeps its picture where the knife went through.
 */
function splitEdges(mesh: BMesh, cuts: ReadonlyMap<Edge, readonly number[]>): Map<Edge, Vert[]> {
  const made = new Map<Edge, Vert[]>();
  const faces = new Map<number, Face>();
  for (const [edge, ts] of cuts) {
    made.set(
      edge,
      ts.map((t) => mesh.addVert(lerp(edge.v0.co, edge.v1.co, t))),
    );
    for (const face of mesh.edgeFaces(edge)) faces.set(face.id, face);
  }

  for (const face of faces.values()) {
    const ring: Vert[] = [];
    const uvs: { u: number; v: number }[] = [];
    for (const loop of mesh.faceLoops(face)) {
      ring.push(loop.vert);
      uvs.push({ ...loop.uv });

      const ts = cuts.get(loop.edge);
      const verts = made.get(loop.edge);
      if (!ts || !verts) continue;

      const forward = loop.edge.v0 === loop.vert;
      for (let k = 0; k < ts.length; k++) {
        const i = forward ? k : ts.length - 1 - k;
        const t = forward ? ts[i] : 1 - ts[i];
        ring.push(verts[i]);
        uvs.push({
          u: loop.uv.u + (loop.next.uv.u - loop.uv.u) * t,
          v: loop.uv.v + (loop.next.uv.v - loop.uv.v) * t,
        });
      }
    }

    const { materialIndex, smooth, selected } = face;
    mesh.removeFace(face);
    const rebuilt = mesh.addFace(ring, { materialIndex, smooth });
    rebuilt.selected = selected;
    mesh.faceLoops(rebuilt).forEach((loop, i) => {
      loop.uv = uvs[i];
    });
  }

  for (const [edge, verts] of made) {
    // The faces that bordered the edge now run through the new vertices, which
    // leaves it bordering nothing. A wire edge had no face to lay its pieces
    // down, so they are laid here; for every other edge they already exist.
    const chain = [edge.v0, ...verts, edge.v1];
    mesh.removeEdge(edge);
    for (let i = 0; i < chain.length - 1; i++) mesh.addEdge(chain[i], chain[i + 1]);
    carrySharp(mesh, edge, chain);
  }

  return made;
}

/**
 * Divides a face in two along a path from one of its corners to another,
 * through vertices inside it.
 *
 * Both halves keep the face's winding, material and smoothing. Corners keep
 * their UVs and the vertices inside take theirs from where they sit in the face.
 * False, with nothing touched, when the path cannot divide it: its ends are one
 * corner, or neighbours with nothing between them, or a half would have no area.
 */
function splitFace(mesh: BMesh, face: Face, from: Vert, inner: readonly Vert[], to: Vert): boolean {
  const loops = mesh.faceLoops(face);
  const ring = loops.map((loop) => loop.vert);
  const start = ring.indexOf(from);
  const end = ring.indexOf(to);
  if (start < 0 || end < 0 || start === end) return false;

  const first = [...sliceRing(ring, start, end), ...[...inner].reverse()];
  const second = [...sliceRing(ring, end, start), ...inner];
  if (first.length < 3 || second.length < 3) return false;

  const smallest = mesh.faceArea(face) * MIN_PIECE_AREA;
  const area = (verts: readonly Vert[]) => polygonArea(verts.map((vert) => vert.co));
  if (area(first) <= smallest || area(second) <= smallest) return false;

  const uvs = new Map(loops.map((loop) => [loop.vert.id, loop.uv]));
  const normal = polygonNormal(ring.map((vert) => vert.co));
  for (const vert of inner) uvs.set(vert.id, uvInside(loops, vert.co, normal));

  const { materialIndex, smooth, selected } = face;
  mesh.removeFace(face);
  for (const verts of [first, second]) {
    const half = mesh.addFace(verts, { materialIndex, smooth });
    half.selected = selected;
    for (const loop of mesh.faceLoops(half)) loop.uv = { ...(uvs.get(loop.vert.id) ?? loop.uv) };
  }
  return true;
}

/** The vertices from `start` to `end` inclusive, wrapping around the ring. */
function sliceRing(ring: readonly Vert[], start: number, end: number): Vert[] {
  const out: Vert[] = [];
  for (let i = start; ; i = (i + 1) % ring.length) {
    out.push(ring[i]);
    if (i === end) break;
  }
  return out;
}

/**
 * The UV at a point inside a face, from its corners.
 *
 * Mean value coordinates: each corner weighs in by how much of the view from
 * the point it takes up. That reproduces any UV layout lying flat across the
 * face exactly, an image plane's included, and stays smooth for one that does not.
 */
function uvInside(loops: readonly Loop[], point: Vec3, normal: Vec3): { u: number; v: number } {
  const { u: axisU, v: axisV } = basisFromNormal(normal);
  const corners = loops.map((loop) => {
    const offset = sub(loop.vert.co, point);
    return { x: dot(offset, axisU), y: dot(offset, axisV) };
  });
  const lengths = corners.map((corner) => Math.hypot(corner.x, corner.y));
  const count = corners.length;

  const halfTangents: number[] = [];
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    if (lengths[i] < 1e-12) return { ...loops[i].uv };

    const a = corners[i];
    const b = corners[next];
    const sine = a.x * b.y - a.y * b.x;
    const cosine = a.x * b.x + a.y * b.y;
    // On the side between two corners, where the angle it sees opens to a
    // straight line: those two corners alone decide it.
    if (Math.abs(sine) <= 1e-12 * lengths[i] * lengths[next] && cosine < 0) {
      const share = lengths[i] / (lengths[i] + lengths[next]);
      const { uv } = loops[i];
      const far = loops[next].uv;
      return { u: uv.u + (far.u - uv.u) * share, v: uv.v + (far.v - uv.v) * share };
    }
    halfTangents.push((lengths[i] * lengths[next] - cosine) / sine);
  }

  let total = 0;
  let u = 0;
  let v = 0;
  for (let i = 0; i < count; i++) {
    const weight = (halfTangents[(i - 1 + count) % count] + halfTangents[i]) / lengths[i];
    total += weight;
    u += loops[i].uv.u * weight;
    v += loops[i].uv.v * weight;
  }
  if (!Number.isFinite(total) || Math.abs(total) < 1e-12) return { ...loops[0].uv };
  return { u: u / total, v: v / total };
}
