import { type Vec3, cross, dot, length, normalize, sub, vec3 } from '../math';
import { BMesh, triangulatePolygon } from '../mesh';

export interface DecimateOptions {
  /** Triangles to stop at. Clamped to what a closed surface can actually hold. */
  targetTriangles: number;
  /** Refuse any collapse that would move an open edge of the mesh. */
  preserveBoundary: boolean;
}

export interface DecimateResult {
  mesh: BMesh;
  /** Edge collapses performed; short of the target means it ran out of legal ones. */
  collapsed: number;
}

/**
 * How much a boundary edge resists being moved when it is not locked outright.
 *
 * A plane through the edge, perpendicular to its triangle, added to both
 * endpoints: the silhouette of an open mesh then costs something to give up,
 * rather than being the cheapest thing in the mesh to collapse.
 */
const BOUNDARY_WEIGHT = 12;

/** Below this the collapse folds a triangle over on itself. */
const FLIP_LIMIT = 0.02;

/**
 * Quadric error decimation: Garland and Heckbert's edge collapse.
 *
 * The other half of retopology: where a voxel remesh throws the topology away
 * and rebuilds it uniform, this keeps every vertex it does not remove, so a
 * flat wall stays two triangles and the detail budget is spent where the
 * curvature actually is. It is also the only mode that carries material slots
 * across, since it never invents a face.
 */
export function decimateMesh(mesh: BMesh, options: DecimateOptions): DecimateResult {
  const positions: Vec3[] = [];
  const vertexOf = new Map<number, number>();
  for (const vert of mesh.verts.values()) {
    if (vert.edges.length === 0) continue;
    vertexOf.set(vert.id, positions.length);
    positions.push({ ...vert.co });
  }

  const triangles: number[][] = [];
  const triangleMaterial: number[] = [];
  for (const face of mesh.faces.values()) {
    const ring = mesh.faceVerts(face);
    if (ring.length < 3) continue;
    const indices =
      ring.length === 3
        ? [0, 1, 2]
        : triangulatePolygon(
            ring.map((vert) => vert.co),
            face.normal,
          );

    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = vertexOf.get(ring[indices[i]].id);
      const b = vertexOf.get(ring[indices[i + 1]].id);
      const c = vertexOf.get(ring[indices[i + 2]].id);
      if (a === undefined || b === undefined || c === undefined) continue;
      if (a === b || b === c || a === c) continue;
      triangles.push([a, b, c]);
      triangleMaterial.push(face.materialIndex);
    }
  }

  const vertexCount = positions.length;
  const alive = new Uint8Array(vertexCount).fill(1);
  const version = new Int32Array(vertexCount);
  const quadrics = new Float64Array(vertexCount * 10);
  const vertTris: Set<number>[] = Array.from({ length: vertexCount }, () => new Set());
  const neighbours: Set<number>[] = Array.from({ length: vertexCount }, () => new Set());
  const triAlive = new Uint8Array(triangles.length).fill(1);

  const addPlane = (vertex: number, normal: Vec3, d: number, weight: number) => {
    const base = vertex * 10;
    const { x, y, z } = normal;
    quadrics[base] += x * x * weight;
    quadrics[base + 1] += x * y * weight;
    quadrics[base + 2] += x * z * weight;
    quadrics[base + 3] += x * d * weight;
    quadrics[base + 4] += y * y * weight;
    quadrics[base + 5] += y * z * weight;
    quadrics[base + 6] += y * d * weight;
    quadrics[base + 7] += z * z * weight;
    quadrics[base + 8] += z * d * weight;
    quadrics[base + 9] += d * d * weight;
  };

  const edgeUse = new Map<number, number>();
  const edgeKey = (a: number, b: number) => (a < b ? a * vertexCount + b : b * vertexCount + a);

  for (let t = 0; t < triangles.length; t++) {
    const [a, b, c] = triangles[t];
    const normal = normalize(
      cross(sub(positions[b], positions[a]), sub(positions[c], positions[a])),
    );
    const d = -dot(normal, positions[a]);
    for (const vertex of triangles[t]) {
      addPlane(vertex, normal, d, 1);
      vertTris[vertex].add(t);
    }
    neighbours[a].add(b).add(c);
    neighbours[b].add(a).add(c);
    neighbours[c].add(a).add(b);

    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = edgeKey(u, v);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }

  const boundary = new Uint8Array(vertexCount);
  for (const [key, uses] of edgeUse) {
    if (uses !== 1) continue;
    const a = Math.floor(key / vertexCount);
    const b = key % vertexCount;
    boundary[a] = 1;
    boundary[b] = 1;

    if (options.preserveBoundary) continue;

    // A plane standing on the open edge, so sliding along the border is cheap
    // but pulling away from it is not.
    const along = sub(positions[b], positions[a]);
    const triangle = [...vertTris[a]].find((t) => vertTris[b].has(t));
    if (triangle === undefined) continue;
    const [ta, tb, tc] = triangles[triangle];
    const faceNormal = cross(sub(positions[tb], positions[ta]), sub(positions[tc], positions[ta]));
    const normal = normalize(cross(along, faceNormal));
    if (length(normal) === 0) continue;
    const d = -dot(normal, positions[a]);
    addPlane(a, normal, d, BOUNDARY_WEIGHT);
    addPlane(b, normal, d, BOUNDARY_WEIGHT);
  }

  /** The point that minimises the two quadrics together, or the best midpoint. */
  const bestTarget = (u: number, v: number): { point: Vec3; cost: number } => {
    const q = new Float64Array(10);
    for (let i = 0; i < 10; i++) q[i] = quadrics[u * 10 + i] + quadrics[v * 10 + i];

    const cost = (point: Vec3): number => {
      const { x, y, z } = point;
      return (
        q[0] * x * x +
        2 * q[1] * x * y +
        2 * q[2] * x * z +
        2 * q[3] * x +
        q[4] * y * y +
        2 * q[5] * y * z +
        2 * q[6] * y +
        q[7] * z * z +
        2 * q[8] * z +
        q[9]
      );
    };

    const det =
      q[0] * (q[4] * q[7] - q[5] * q[5]) -
      q[1] * (q[1] * q[7] - q[5] * q[2]) +
      q[2] * (q[1] * q[5] - q[4] * q[2]);

    if (Math.abs(det) > 1e-12) {
      const inv = 1 / det;
      const point = vec3(
        -inv *
          (q[3] * (q[4] * q[7] - q[5] * q[5]) -
            q[6] * (q[1] * q[7] - q[2] * q[5]) +
            q[8] * (q[1] * q[5] - q[2] * q[4])),
        -inv *
          (-q[3] * (q[1] * q[7] - q[5] * q[2]) +
            q[6] * (q[0] * q[7] - q[2] * q[2]) -
            q[8] * (q[0] * q[5] - q[2] * q[1])),
        -inv *
          (q[3] * (q[1] * q[5] - q[4] * q[2]) -
            q[6] * (q[0] * q[5] - q[1] * q[2]) +
            q[8] * (q[0] * q[4] - q[1] * q[1])),
      );
      if (Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)) {
        return { point, cost: Math.max(0, cost(point)) };
      }
    }

    const candidates = [
      positions[u],
      positions[v],
      vec3(
        (positions[u].x + positions[v].x) * 0.5,
        (positions[u].y + positions[v].y) * 0.5,
        (positions[u].z + positions[v].z) * 0.5,
      ),
    ];
    let best = candidates[0];
    let bestCost = Infinity;
    for (const candidate of candidates) {
      const value = cost(candidate);
      if (value >= bestCost) continue;
      bestCost = value;
      best = candidate;
    }
    return { point: { ...best }, cost: Math.max(0, bestCost) };
  };

  interface Candidate {
    u: number;
    v: number;
    cost: number;
    point: Vec3;
    stampU: number;
    stampV: number;
  }

  const heap: Candidate[] = [];
  const push = (entry: Candidate) => {
    heap.push(entry);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (heap[parent].cost <= heap[child].cost) break;
      [heap[parent], heap[child]] = [heap[child], heap[parent]];
      child = parent;
    }
  };
  const pop = (): Candidate | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < heap.length && heap[left].cost < heap[smallest].cost) smallest = left;
        if (right < heap.length && heap[right].cost < heap[smallest].cost) smallest = right;
        if (smallest === parent) break;
        [heap[parent], heap[smallest]] = [heap[smallest], heap[parent]];
        parent = smallest;
      }
    }
    return top;
  };

  const offer = (u: number, v: number) => {
    if (!alive[u] || !alive[v]) return;
    if (options.preserveBoundary && (boundary[u] || boundary[v])) return;
    const { point, cost } = bestTarget(u, v);
    push({ u, v, cost, point, stampU: version[u], stampV: version[v] });
  };

  for (const key of edgeUse.keys()) {
    offer(Math.floor(key / vertexCount), key % vertexCount);
  }

  const normalOf = (triangle: number[], replace: number | null, replaceWith: Vec3): Vec3 | null => {
    const points = triangle.map((vertex) => (vertex === replace ? replaceWith : positions[vertex]));
    const normal = cross(sub(points[1], points[0]), sub(points[2], points[0]));
    return length(normal) < 1e-16 ? null : normalize(normal);
  };

  let liveTriangles = triangles.length;
  const target = Math.max(4, Math.floor(options.targetTriangles));
  let collapsed = 0;

  while (liveTriangles > target) {
    const candidate = pop();
    if (!candidate) break;

    const { u, v, point } = candidate;
    if (!alive[u] || !alive[v]) continue;
    if (candidate.stampU !== version[u] || candidate.stampV !== version[v]) continue;

    const shared = [...vertTris[u]].filter((t) => vertTris[v].has(t));
    if (shared.length === 0 || shared.length > 2) continue;

    // Link condition: the only vertices u and v may share are the tips of the
    // triangles between them. Anything more and the collapse pinches the
    // surface into a non-manifold seam.
    let common = 0;
    for (const w of neighbours[u]) if (neighbours[v].has(w)) common++;
    if (common !== shared.length) continue;

    let folds = false;
    for (const [moved, other] of [
      [u, v],
      [v, u],
    ]) {
      for (const t of vertTris[moved]) {
        if (shared.includes(t)) continue;
        if (triangles[t].includes(other)) continue;
        const before = normalOf(triangles[t], null, point);
        const after = normalOf(triangles[t], moved, point);
        if (!after || (before && dot(before, after) < FLIP_LIMIT)) {
          folds = true;
          break;
        }
      }
      if (folds) break;
    }
    if (folds) continue;

    for (const t of shared) {
      triAlive[t] = 0;
      for (const vertex of triangles[t]) vertTris[vertex].delete(t);
      liveTriangles--;
    }

    positions[u] = point;
    for (let i = 0; i < 10; i++) quadrics[u * 10 + i] += quadrics[v * 10 + i];

    for (const t of vertTris[v]) {
      triangles[t] = triangles[t].map((vertex) => (vertex === v ? u : vertex));
      vertTris[u].add(t);
    }
    vertTris[v].clear();

    for (const w of neighbours[v]) {
      if (w === u) continue;
      neighbours[w].delete(v);
      neighbours[w].add(u);
      neighbours[u].add(w);
    }
    neighbours[u].delete(v);
    neighbours[v].clear();

    alive[v] = 0;
    if (boundary[v]) boundary[u] = 1;
    version[u]++;
    for (const w of neighbours[u]) version[w]++;
    collapsed++;

    for (const w of neighbours[u]) offer(u, w);
  }

  const result = new BMesh();
  const created = new Map<number, ReturnType<BMesh['addVert']>>();
  for (let t = 0; t < triangles.length; t++) {
    if (!triAlive[t]) continue;
    const ring = triangles[t].map((vertex) => {
      const existing = created.get(vertex);
      if (existing) return existing;
      const vert = result.addVert(positions[vertex]);
      created.set(vertex, vert);
      return vert;
    });
    if (new Set(ring).size !== 3) continue;
    result.addFace(ring, { materialIndex: triangleMaterial[t] });
  }
  result.computeNormals();

  return { mesh: result, collapsed };
}
