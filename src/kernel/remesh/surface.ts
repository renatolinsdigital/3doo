import { type Vec3, cross, dot, length, normalize, sub, vec3 } from '../math';
import { type BMesh, triangulatePolygon } from '../mesh';

/**
 * One triangle of the surface being remeshed, carrying the vertex normals of
 * the mesh it came from.
 *
 * The normals are what let a query answer "inside or outside" near a crease:
 * the face normal of the nearest triangle flips sign across one, while the
 * area-weighted vertex normals blend across it — the same trick a pseudonormal
 * signed-distance field uses.
 */
export interface SurfaceTriangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  na: Vec3;
  nb: Vec3;
  nc: Vec3;
  /** Material slot of the face this triangle was cut from. */
  materialIndex: number;
}

export interface SurfaceHit {
  /** The closest point itself, on the triangle. */
  point: Vec3;
  distance: number;
  /** Interpolated surface normal there, pointing out of the solid. */
  normal: Vec3;
  materialIndex: number;
}

/** Barycentric closest point on a triangle, after Ericson. */
export function closestOnTriangle(
  p: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): { point: Vec3; u: number; v: number; w: number } {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);

  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { point: a, u: 1, v: 0, w: 0 };

  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { point: b, u: 0, v: 1, w: 0 };

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return {
      point: { x: a.x + ab.x * v, y: a.y + ab.y * v, z: a.z + ab.z * v },
      u: 1 - v,
      v,
      w: 0,
    };
  }

  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { point: c, u: 0, v: 0, w: 1 };

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return {
      point: { x: a.x + ac.x * w, y: a.y + ac.y * w, z: a.z + ac.z * w },
      u: 1 - w,
      v: 0,
      w,
    };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return {
      point: { x: b.x + (c.x - b.x) * w, y: b.y + (c.y - b.y) * w, z: b.z + (c.z - b.z) * w },
      u: 0,
      v: 1 - w,
      w,
    };
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return {
    point: {
      x: a.x + ab.x * v + ac.x * w,
      y: a.y + ab.y * v + ac.y * w,
      z: a.z + ab.z * v + ac.z * w,
    },
    u: 1 - v - w,
    v,
    w,
  };
}

export function blendNormal(triangle: SurfaceTriangle, u: number, v: number, w: number): Vec3 {
  const blended = normalize({
    x: triangle.na.x * u + triangle.nb.x * v + triangle.nc.x * w,
    y: triangle.na.y * u + triangle.nb.y * v + triangle.nc.y * w,
    z: triangle.na.z * u + triangle.nb.z * v + triangle.nc.z * w,
  });
  if (blended.x !== 0 || blended.y !== 0 || blended.z !== 0) return blended;
  return normalize(cross(sub(triangle.b, triangle.a), sub(triangle.c, triangle.a)));
}

/**
 * The mesh as a triangle soup with blended vertex normals.
 *
 * N-gons go through the same ear clipper the exporters use, so a remesh reads
 * exactly the surface the viewport draws.
 */
export function buildSurface(mesh: BMesh): SurfaceTriangle[] {
  const normals = new Map<number, Vec3>();
  const raw: {
    verts: [number, number, number];
    points: [Vec3, Vec3, Vec3];
    materialIndex: number;
  }[] = [];

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
      const v0 = ring[indices[i]];
      const v1 = ring[indices[i + 1]];
      const v2 = ring[indices[i + 2]];
      if (!v0 || !v1 || !v2) continue;

      // Area weighting, the rule `BMesh.computeNormals` uses, so a dense corner
      // of slivers does not out-vote the broad face beside it.
      const weighted = cross(sub(v1.co, v0.co), sub(v2.co, v0.co));
      for (const vert of [v0, v1, v2]) {
        const sum = normals.get(vert.id) ?? vec3();
        normals.set(vert.id, {
          x: sum.x + weighted.x,
          y: sum.y + weighted.y,
          z: sum.z + weighted.z,
        });
      }

      raw.push({
        verts: [v0.id, v1.id, v2.id],
        points: [v0.co, v1.co, v2.co],
        materialIndex: face.materialIndex,
      });
    }
  }

  const normalOf = (id: number): Vec3 => {
    const sum = normals.get(id);
    if (!sum) return vec3(0, 1, 0);
    const unit = normalize(sum);
    return unit.x === 0 && unit.y === 0 && unit.z === 0 ? vec3(0, 1, 0) : unit;
  };

  return raw.map((triangle) => ({
    a: triangle.points[0],
    b: triangle.points[1],
    c: triangle.points[2],
    na: normalOf(triangle.verts[0]),
    nb: normalOf(triangle.verts[1]),
    nc: normalOf(triangle.verts[2]),
    materialIndex: triangle.materialIndex,
  }));
}

export function surfaceArea(triangles: readonly SurfaceTriangle[]): number {
  let area = 0;
  for (const triangle of triangles) {
    area += length(cross(sub(triangle.b, triangle.a), sub(triangle.c, triangle.a))) * 0.5;
  }
  return area;
}

/**
 * Area weighted by how many grid axes the surface faces at once.
 *
 * Surface nets emit one quad per grid edge the surface crosses, and a patch
 * tilted to the grid crosses edges on all three axes rather than one — which is
 * why a sphere comes out half again as dense as a box of the same area at the
 * same voxel size. This is the quantity that actually predicts the face count.
 */
export function crossingArea(triangles: readonly SurfaceTriangle[]): number {
  let total = 0;
  for (const triangle of triangles) {
    const weighted = cross(sub(triangle.b, triangle.a), sub(triangle.c, triangle.a));
    const area = length(weighted) * 0.5;
    if (area === 0) continue;
    const normal = normalize(weighted);
    total += area * (Math.abs(normal.x) + Math.abs(normal.y) + Math.abs(normal.z));
  }
  return total;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export function surfaceBounds(triangles: readonly SurfaceTriangle[]): Bounds {
  const min = vec3(Infinity, Infinity, Infinity);
  const max = vec3(-Infinity, -Infinity, -Infinity);

  for (const triangle of triangles) {
    for (const point of [triangle.a, triangle.b, triangle.c]) {
      min.x = Math.min(min.x, point.x);
      min.y = Math.min(min.y, point.y);
      min.z = Math.min(min.z, point.z);
      max.x = Math.max(max.x, point.x);
      max.y = Math.max(max.y, point.y);
      max.z = Math.max(max.z, point.z);
    }
  }

  if (!Number.isFinite(min.x)) return { min: vec3(), max: vec3() };
  return { min, max };
}

/**
 * Uniform grid over the triangle soup, for nearest-surface queries.
 *
 * A BVH would win on a pathological model, but every query a remesh makes
 * starts within a voxel or two of the surface, where a grid answers from the
 * first shell it looks at and costs nothing to build.
 */
export class SurfaceIndex {
  readonly triangles: readonly SurfaceTriangle[];

  private readonly buckets: number[][];
  private readonly origin: Vec3;
  private readonly cell: number;
  private readonly dims: { x: number; y: number; z: number };
  /** Query stamps, so one query never tests the same triangle twice. */
  private readonly visited: Int32Array;
  private queryId = 0;

  constructor(triangles: readonly SurfaceTriangle[]) {
    this.triangles = triangles;
    this.visited = new Int32Array(triangles.length);

    const bounds = surfaceBounds(triangles);
    const size = sub(bounds.max, bounds.min);
    const extent = Math.max(size.x, size.y, size.z);
    const divisions = Math.min(64, Math.max(1, Math.round(Math.cbrt(triangles.length || 1))));

    this.cell = extent > 0 ? extent / divisions : 1;
    this.origin = bounds.min;
    this.dims = {
      x: Math.max(1, Math.ceil(size.x / this.cell)),
      y: Math.max(1, Math.ceil(size.y / this.cell)),
      z: Math.max(1, Math.ceil(size.z / this.cell)),
    };

    this.buckets = Array.from({ length: this.dims.x * this.dims.y * this.dims.z }, () => []);
    for (let index = 0; index < triangles.length; index++) {
      const triangle = triangles[index];
      const lo = this.cellOf({
        x: Math.min(triangle.a.x, triangle.b.x, triangle.c.x),
        y: Math.min(triangle.a.y, triangle.b.y, triangle.c.y),
        z: Math.min(triangle.a.z, triangle.b.z, triangle.c.z),
      });
      const hi = this.cellOf({
        x: Math.max(triangle.a.x, triangle.b.x, triangle.c.x),
        y: Math.max(triangle.a.y, triangle.b.y, triangle.c.y),
        z: Math.max(triangle.a.z, triangle.b.z, triangle.c.z),
      });

      for (let x = lo.x; x <= hi.x; x++) {
        for (let y = lo.y; y <= hi.y; y++) {
          for (let z = lo.z; z <= hi.z; z++) {
            this.buckets[(x * this.dims.y + y) * this.dims.z + z].push(index);
          }
        }
      }
    }
  }

  closest(point: Vec3): SurfaceHit | null {
    if (this.triangles.length === 0) return null;

    const base = this.cellOf(point);
    const stamp = ++this.queryId;
    const reach = Math.max(this.dims.x, this.dims.y, this.dims.z);
    let best: SurfaceHit | null = null;

    for (let radius = 0; radius <= reach; radius++) {
      // Nothing in a farther shell can be nearer than this, so once the best
      // hit beats it the search is over.
      if (best && (radius - 1) * this.cell > best.distance) break;

      for (let x = base.x - radius; x <= base.x + radius; x++) {
        if (x < 0 || x >= this.dims.x) continue;
        for (let y = base.y - radius; y <= base.y + radius; y++) {
          if (y < 0 || y >= this.dims.y) continue;
          for (let z = base.z - radius; z <= base.z + radius; z++) {
            if (z < 0 || z >= this.dims.z) continue;
            const shell = Math.max(
              Math.abs(x - base.x),
              Math.abs(y - base.y),
              Math.abs(z - base.z),
            );
            if (shell < radius) continue;

            for (const index of this.buckets[(x * this.dims.y + y) * this.dims.z + z]) {
              if (this.visited[index] === stamp) continue;
              this.visited[index] = stamp;

              const triangle = this.triangles[index];
              const hit = closestOnTriangle(point, triangle.a, triangle.b, triangle.c);
              const distance = length(sub(point, hit.point));
              if (best && distance >= best.distance) continue;

              best = {
                point: hit.point,
                distance,
                normal: blendNormal(triangle, hit.u, hit.v, hit.w),
                materialIndex: triangle.materialIndex,
              };
            }
          }
        }
      }
    }

    return best;
  }

  /** Negative inside the solid, positive outside — the sign an SDF wants. */
  signedDistance(point: Vec3): number {
    const hit = this.closest(point);
    if (!hit) return Infinity;
    return dot(sub(point, hit.point), hit.normal) >= 0 ? hit.distance : -hit.distance;
  }

  private cellOf(point: Vec3): { x: number; y: number; z: number } {
    return {
      x: clampIndex((point.x - this.origin.x) / this.cell, this.dims.x),
      y: clampIndex((point.y - this.origin.y) / this.cell, this.dims.y),
      z: clampIndex((point.z - this.origin.z) / this.cell, this.dims.z),
    };
  }
}

function clampIndex(value: number, limit: number): number {
  return Math.min(limit - 1, Math.max(0, Math.floor(value)));
}
