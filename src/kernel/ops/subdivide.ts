import { type Vec3, add, centroid, clamp, dot, lerp, mul } from '../math';
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

function subdividePass(mesh: BMesh, faces: readonly Face[], smooth: number): Face[] {
  const selected = faces.filter((face) => mesh.faces.has(face.id));
  if (selected.length === 0) return [];

  const selectedIds = new Set(selected.map((face) => face.id));
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
        ? centroid([edge.v0.co, edge.v1.co, ...adjacent.map((face) => mesh.faceCenter(face))])
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

        const faceAverage = centroid(fan.map((candidate) => mesh.faceCenter(candidate)));
        const edgeAverage = centroid(
          vert.edges.map((edge) => mul(add(edge.v0.co, edge.v1.co), 0.5)),
        );
        const limit = mul(
          add(
            add(faceAverage, mul(edgeAverage, 2)),
            mul(vert.co, valence - 3),
          ),
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

  for (const face of selected) {
    const center = mesh.addVert(mesh.faceCenter(face));
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
    const ring: Vert[] = [];
    for (const loop of mesh.faceLoops(face)) {
      ring.push(loop.vert);
      const point = edgePoint.get(loop.edge.id);
      if (point) ring.push(point);
    }
    created.push({
      ring,
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
