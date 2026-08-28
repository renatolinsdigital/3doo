import {
  type Vec3,
  add,
  basisFromNormal,
  centroid,
  clamp,
  cross,
  distanceSq,
  dot,
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
import type { Edge, Face, Vert } from '../mesh/types';

export interface SubdivideOptions {
  cuts?: number;
  /** 0 keeps the cage, 1 pulls new points onto the Catmull-Clark limit points. */
  smooth?: number;
}

/**
 * Catmull-Clark style subdivision of the selected faces.
 *
 * Each selected face becomes one quad per corner. Faces bordering the selection
 * keep their shape but gain the new edge points, so the mesh stays watertight.
 */
export function subdivideFaces(
  mesh: BMesh,
  faces: readonly Face[],
  options: SubdivideOptions = {},
): Face[] {
  const cuts = Math.max(1, Math.floor(options.cuts ?? 1));
  const smooth = clamp(options.smooth ?? 0, 0, 1);

  let current = [...faces];
  for (let pass = 0; pass < cuts; pass++) {
    current = subdividePass(mesh, current, smooth);
    if (current.length === 0) break;
  }
  return current;
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
 * see every edge of it — when every triangle from the point out to an edge
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
 * dragged into the hole — off the surface altogether. Weighting by area follows
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
 * the first one that fits — which is all a triangulation for drawing needs —
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
 * the two pieces either side of one make a convex piece together — Hertel and
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
 * fortieth as square, and subdividing those folds the wall into fins — worse
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

function subdividePass(mesh: BMesh, faces: readonly Face[], smooth: number): Face[] {
  const live = faces.filter((face) => mesh.faces.has(face.id));
  if (live.length === 0) return [];

  // A face no point in it can see the whole of is cut into convex pieces before
  // anything else happens, because the fan below only tiles a face its centre
  // can see. The ring a boolean leaves around a hole is the case that matters,
  // and left whole it comes back as a starburst across the hole.
  const selected: Face[] = [];
  for (const face of live) {
    const points = mesh.facePoints(face);
    if (fansCleanly(points, facePointOf(mesh, face))) selected.push(face);
    else selected.push(...openFace(mesh, face));
  }

  const selectedIds = new Set(selected.map((face) => face.id));

  // Read once per face and shared by all three rules below, so the edge points,
  // the relaxed corners and the centre a face is fanned from all agree.
  const points = new Map<number, Vec3>();
  const facePoint = (face: Face) => {
    const held = points.get(face.id);
    if (held) return held;
    const found = facePointOf(mesh, face);
    points.set(face.id, found);
    return found;
  };

  const splitEdges = new Map<number, Edge>();
  for (const face of selected) {
    for (const edge of mesh.faceEdges(face)) splitEdges.set(edge.id, edge);
  }

  const edgePoint = new Map<number, Vert>();
  for (const edge of splitEdges.values()) {
    const midpoint = mul(add(edge.v0.co, edge.v1.co), 0.5);
    const adjacent = mesh.edgeFaces(edge);
    const limit =
      adjacent.length === 2
        ? centroid([edge.v0.co, edge.v1.co, ...adjacent.map(facePoint)])
        : midpoint;
    edgePoint.set(edge.id, mesh.addVert(smooth > 0 ? lerp(midpoint, limit, smooth) : midpoint));
  }

  const neighbours = new Map<number, Face>();
  for (const edge of splitEdges.values()) {
    for (const face of mesh.edgeFaces(edge)) {
      if (!selectedIds.has(face.id)) neighbours.set(face.id, face);
    }
  }

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

  interface FaceSpec {
    ring: Vert[];
    materialIndex: number;
    smooth: boolean;
    fromSelection: boolean;
  }
  const created: FaceSpec[] = [];

  /** The face's own ring with the new edge points spliced into it. */
  const widened = (face: Face) => {
    const ring: Vert[] = [];
    for (const loop of mesh.faceLoops(face)) {
      ring.push(loop.vert);
      const point = edgePoint.get(loop.edge.id);
      if (point) ring.push(point);
    }
    return ring;
  };

  for (const face of selected) {
    const middle = facePoint(face);

    // A face no point can see the whole of keeps its ring instead of being
    // fanned. It still takes the new edge points, so the mesh stays watertight
    // and its corners still relax with everything else; it simply is not carved
    // up, because the only way to carve it is into quads that miss it.
    if (!fansCleanly(mesh.facePoints(face), middle)) {
      created.push({
        ring: widened(face),
        materialIndex: face.materialIndex,
        smooth: face.smooth,
        fromSelection: true,
      });
      continue;
    }

    const center = mesh.addVert(middle);
    for (const loop of mesh.faceLoops(face)) {
      const incoming = edgePoint.get(loop.prev.edge.id);
      const outgoing = edgePoint.get(loop.edge.id);
      if (!incoming || !outgoing) continue;
      created.push({
        ring: [loop.vert, outgoing, center, incoming],
        materialIndex: face.materialIndex,
        smooth: face.smooth,
        fromSelection: true,
      });
    }
  }

  for (const face of neighbours.values()) {
    created.push({
      ring: widened(face),
      materialIndex: face.materialIndex,
      smooth: face.smooth,
      fromSelection: false,
    });
  }

  const staleEdges = new Set<Edge>();
  for (const face of [...selected, ...neighbours.values()]) {
    for (const edge of mesh.faceEdges(face)) staleEdges.add(edge);
    mesh.removeFace(face);
  }

  const result: Face[] = [];
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
