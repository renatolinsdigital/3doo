import { type Vec3, vec3 } from '../math';

import type { FeatureIndex } from './features';

import {
  type SurfaceIndex,
  type SurfaceTriangle,
  closestOnTriangle,
  blendNormal,
  surfaceBounds,
} from './surface';

/**
 * Empty voxels kept around the model on every side.
 *
 * Three, so the outermost layer of grid points is guaranteed to sit outside the
 * narrow band: the flood fill that decides inside from outside starts there and
 * would leak straight into the model if the band reached the border.
 */
const PADDING = 3;

/** Half-width of the exact band, in voxels. */
const BAND = 2;

/**
 * How near the surface a grid point has to be to count as lying on it.
 *
 * Nine orders of magnitude below a voxel: far above the 1e-16 of noise that a
 * point on the surface actually measures, and far below anything a model means.
 */
const ON_SURFACE_FRACTION = 1e-9;

export interface VoxelGrid {
  /** Signed distance at every grid corner; negative inside. */
  field: Float32Array;
  nx: number;
  ny: number;
  nz: number;
  origin: Vec3;
  voxelSize: number;
}

export interface VoxelFieldOptions {
  voxelSize: number;
  /** Corners the grid may not exceed; the voxel size grows until it fits. */
  maxCorners: number;
}

/**
 * Samples the surface into a signed distance grid.
 *
 * Two passes. The first rasterises each triangle into the grid points within
 * `BAND` voxels of it, keeping the nearest hit and signing it against the
 * blended normal there. The second floods the untouched points inward from the
 * grid border: anything the flood cannot reach is enclosed, so it is inside.
 * That is what lets an open mesh remesh at all — holes narrower than a voxel
 * are simply closed over rather than leaking.
 */
export function buildVoxelField(
  triangles: readonly SurfaceTriangle[],
  options: VoxelFieldOptions,
): VoxelGrid {
  const bounds = surfaceBounds(triangles);
  let voxelSize = Math.max(options.voxelSize, 1e-6);

  const cornersFor = (size: number) => {
    const nx = Math.ceil((bounds.max.x - bounds.min.x) / size) + 2 * PADDING + 1;
    const ny = Math.ceil((bounds.max.y - bounds.min.y) / size) + 2 * PADDING + 1;
    const nz = Math.ceil((bounds.max.z - bounds.min.z) / size) + 2 * PADDING + 1;
    return { nx, ny, nz, total: nx * ny * nz };
  };

  // Coarsen until the grid fits the budget rather than refusing the job: the
  // caller reports the size actually used, so the number in the panel is the
  // number the mesh was built at.
  let dims = cornersFor(voxelSize);
  while (dims.total > options.maxCorners) {
    voxelSize *= Math.cbrt(dims.total / options.maxCorners) * 1.02;
    dims = cornersFor(voxelSize);
  }

  const { nx, ny, nz } = dims;
  const origin = vec3(
    bounds.min.x - voxelSize * PADDING,
    bounds.min.y - voxelSize * PADDING,
    bounds.min.z - voxelSize * PADDING,
  );

  const field = new Float32Array(nx * ny * nz);
  const known = new Uint8Array(nx * ny * nz);
  const band = BAND * voxelSize;
  const onSurface = voxelSize * ON_SURFACE_FRACTION;
  const index = (i: number, j: number, k: number) => (i * ny + j) * nz + k;

  for (const triangle of triangles) {
    const lo = {
      x: Math.min(triangle.a.x, triangle.b.x, triangle.c.x) - band,
      y: Math.min(triangle.a.y, triangle.b.y, triangle.c.y) - band,
      z: Math.min(triangle.a.z, triangle.b.z, triangle.c.z) - band,
    };
    const hi = {
      x: Math.max(triangle.a.x, triangle.b.x, triangle.c.x) + band,
      y: Math.max(triangle.a.y, triangle.b.y, triangle.c.y) + band,
      z: Math.max(triangle.a.z, triangle.b.z, triangle.c.z) + band,
    };

    const i0 = Math.max(0, Math.ceil((lo.x - origin.x) / voxelSize));
    const i1 = Math.min(nx - 1, Math.floor((hi.x - origin.x) / voxelSize));
    const j0 = Math.max(0, Math.ceil((lo.y - origin.y) / voxelSize));
    const j1 = Math.min(ny - 1, Math.floor((hi.y - origin.y) / voxelSize));
    const k0 = Math.max(0, Math.ceil((lo.z - origin.z) / voxelSize));
    const k1 = Math.min(nz - 1, Math.floor((hi.z - origin.z) / voxelSize));

    for (let i = i0; i <= i1; i++) {
      const px = origin.x + i * voxelSize;
      for (let j = j0; j <= j1; j++) {
        const py = origin.y + j * voxelSize;
        for (let k = k0; k <= k1; k++) {
          const cell = index(i, j, k);
          const point = { x: px, y: py, z: origin.z + k * voxelSize };
          const hit = closestOnTriangle(point, triangle.a, triangle.b, triangle.c);
          const dx = point.x - hit.point.x;
          const dy = point.y - hit.point.y;
          const dz = point.z - hit.point.z;
          const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (distance > band) continue;
          if (known[cell] && distance >= Math.abs(field[cell])) continue;

          const normal = blendNormal(triangle, hit.u, hit.v, hit.w);
          // A grid point sitting *on* the surface has no direction to read a
          // side off: the vector to its own closest point is rounding error, so
          // the dot product below is a coin toss. It is not a rare case either
          // — the grid is laid from the model's own bounding box, so an
          // axis-aligned face on the minimum side lands exactly on a grid
          // plane, and a plain box puts several hundred points there. Signed at
          // random, that plane comes out of the contour shredded into rosettes
          // of pentagons while the other three sides stay clean.
          //
          // The surface belongs to the solid, so anything on it is inside, and
          // strictly so: negative zero fails `< 0` and would put the coin back
          // in the air.
          const inward = distance <= onSurface || dx * normal.x + dy * normal.y + dz * normal.z < 0;
          field[cell] = inward ? -Math.max(distance, onSurface) : distance;
          known[cell] = 1;
        }
      }
    }
  }

  floodExterior(field, known, nx, ny, nz, band + voxelSize);
  return { field, nx, ny, nz, origin, voxelSize };
}

/**
 * Signs every point the band never reached.
 *
 * Any grid edge that crosses the surface has an endpoint within half a voxel of
 * it, so that endpoint is already in the band — which makes the band an
 * unbroken wall between the untouched points outside and those inside, and a
 * flood from the border able to tell them apart.
 */
function floodExterior(
  field: Float32Array,
  known: Uint8Array,
  nx: number,
  ny: number,
  nz: number,
  far: number,
): void {
  const outside = new Uint8Array(field.length);
  const queue: number[] = [];
  const index = (i: number, j: number, k: number) => (i * ny + j) * nz + k;

  const seed = (cell: number) => {
    if (known[cell] || outside[cell]) return;
    outside[cell] = 1;
    queue.push(cell);
  };

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      seed(index(i, j, 0));
      seed(index(i, j, nz - 1));
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      seed(index(i, 0, k));
      seed(index(i, ny - 1, k));
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nz; k++) {
      seed(index(0, j, k));
      seed(index(nx - 1, j, k));
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    const k = cell % nz;
    const j = Math.floor(cell / nz) % ny;
    const i = Math.floor(cell / (nz * ny));

    if (i > 0) seed(index(i - 1, j, k));
    if (i < nx - 1) seed(index(i + 1, j, k));
    if (j > 0) seed(index(i, j - 1, k));
    if (j < ny - 1) seed(index(i, j + 1, k));
    if (k > 0) seed(index(i, j, k - 1));
    if (k < nz - 1) seed(index(i, j, k + 1));
  }

  for (let cell = 0; cell < field.length; cell++) {
    if (known[cell]) continue;
    field[cell] = outside[cell] ? far : -far;
  }
}

export interface SurfaceNetOptions {
  /** Put every vertex at its cell centre, for the blocky look. */
  blocky: boolean;
}

export interface SurfaceNet {
  positions: Vec3[];
  /** Four vertex indices per face, wound so the normal points out. */
  quads: number[][];
}

/**
 * Dual contouring of the sign changes, in its simplest form: naive surface
 * nets.
 *
 * One vertex per cell the surface passes through, one quad per grid edge it
 * crosses — which is why the output is all quads and watertight, and why it is
 * the right starting point for a retopology pass rather than the marching-cubes
 * triangle soup the same field would give.
 */
export function surfaceNets(grid: VoxelGrid, options: SurfaceNetOptions): SurfaceNet {
  const { field, nx, ny, nz, origin, voxelSize } = grid;
  const index = (i: number, j: number, k: number) => (i * ny + j) * nz + k;

  const cx = nx - 1;
  const cy = ny - 1;
  const cz = nz - 1;
  const cellVertex = new Int32Array(cx * cy * cz).fill(-1);
  const cellIndex = (i: number, j: number, k: number) => (i * cy + j) * cz + k;

  const positions: Vec3[] = [];

  // The 12 edges of a cell, as pairs of corner offsets.
  const corners: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ];
  const edges: [number, number][] = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];

  const values = new Float64Array(8);

  for (let i = 0; i < cx; i++) {
    for (let j = 0; j < cy; j++) {
      for (let k = 0; k < cz; k++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          const offset = corners[c];
          const value = field[index(i + offset[0], j + offset[1], k + offset[2])];
          values[c] = value;
          if (value < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;

        if (options.blocky) {
          positions.push(
            vec3(
              origin.x + (i + 0.5) * voxelSize,
              origin.y + (j + 0.5) * voxelSize,
              origin.z + (k + 0.5) * voxelSize,
            ),
          );
          cellVertex[cellIndex(i, j, k)] = positions.length - 1;
          continue;
        }

        let sx = 0;
        let sy = 0;
        let sz = 0;
        let crossings = 0;
        for (const [from, to] of edges) {
          const a = values[from];
          const b = values[to];
          if (a < 0 === b < 0) continue;

          const t = a / (a - b);
          const p0 = corners[from];
          const p1 = corners[to];
          sx += p0[0] + (p1[0] - p0[0]) * t;
          sy += p0[1] + (p1[1] - p0[1]) * t;
          sz += p0[2] + (p1[2] - p0[2]) * t;
          crossings++;
        }

        const inv = crossings > 0 ? 1 / crossings : 0;
        positions.push(
          vec3(
            origin.x + (i + (crossings > 0 ? sx * inv : 0.5)) * voxelSize,
            origin.y + (j + (crossings > 0 ? sy * inv : 0.5)) * voxelSize,
            origin.z + (k + (crossings > 0 ? sz * inv : 0.5)) * voxelSize,
          ),
        );
        cellVertex[cellIndex(i, j, k)] = positions.length - 1;
      }
    }
  }

  const quads: number[][] = [];
  const emit = (ring: number[], flip: boolean) => {
    if (ring.some((vertex) => vertex < 0)) return;
    quads.push(flip ? [ring[3], ring[2], ring[1], ring[0]] : ring);
  };

  // The four cells around a crossed grid edge are the quad. Wound so the
  // normal runs from the inside corner to the outside one; the padding
  // guarantees the ranges below never walk off a cell that does not exist.
  for (let i = 0; i < nx - 1; i++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let k = 1; k < nz - 1; k++) {
        const a = field[index(i, j, k)] < 0;
        const b = field[index(i + 1, j, k)] < 0;
        if (a === b) continue;
        emit(
          [
            cellVertex[cellIndex(i, j - 1, k - 1)],
            cellVertex[cellIndex(i, j, k - 1)],
            cellVertex[cellIndex(i, j, k)],
            cellVertex[cellIndex(i, j - 1, k)],
          ],
          !a,
        );
      }
    }
  }

  for (let i = 1; i < nx - 1; i++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let k = 1; k < nz - 1; k++) {
        const a = field[index(i, j, k)] < 0;
        const b = field[index(i, j + 1, k)] < 0;
        if (a === b) continue;
        emit(
          [
            cellVertex[cellIndex(i - 1, j, k - 1)],
            cellVertex[cellIndex(i - 1, j, k)],
            cellVertex[cellIndex(i, j, k)],
            cellVertex[cellIndex(i, j, k - 1)],
          ],
          !a,
        );
      }
    }
  }

  for (let i = 1; i < nx - 1; i++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let k = 0; k < nz - 1; k++) {
        const a = field[index(i, j, k)] < 0;
        const b = field[index(i, j, k + 1)] < 0;
        if (a === b) continue;
        emit(
          [
            cellVertex[cellIndex(i - 1, j - 1, k)],
            cellVertex[cellIndex(i, j - 1, k)],
            cellVertex[cellIndex(i, j, k)],
            cellVertex[cellIndex(i - 1, j, k)],
          ],
          !a,
        );
      }
    }
  }

  return { positions, quads };
}

export interface RelaxOptions {
  /** Relaxation passes over the new surface. */
  smoothing: number;
  /** How far a vertex is pulled back onto the original surface, 0 to 1. */
  projection: number;
  /** Creases to hold the new surface to, or null to let it round them off. */
  features: FeatureIndex | null;
  /** How near a crease a vertex has to land before it is pulled onto it. */
  featureRadius: number;
  /**
   * The same for a corner, and wider.
   *
   * A crease is a line the contour crosses head-on, so the vertex it puts there
   * is about half a voxel off it. A corner is a single point, and the nearest
   * vertex the grid has to offer can be most of a cell diagonal away — held to
   * the crease radius, every corner of a cube goes unclaimed.
   */
  cornerRadius: number;
}

export interface RelaxReport {
  /** Vertices pinned to a hard corner of the source. */
  corners: number;
  /** Vertices held on a crease line. */
  creases: number;
}

/** How far a vertex travels towards where the forces below want it, per pass. */
const RELAX_RATE = 0.6;

/** Split of the move between evening out the staircase and setting the spacing. */
const SMOOTH_WEIGHT = 0.5;
const SPRING_WEIGHT = 0.5;

/**
 * The retopology loop: relax the net, hold it to the model's creases, then pull
 * it back onto the surface.
 *
 * The relaxation is tangential — the component of the move along the surface
 * normal is thrown away — which is what separates it from the Laplacian pass
 * this used to run. A Laplacian evens out the staircase the grid leaves behind
 * by shrinking the model into itself, and needs the re-projection to undo its
 * own damage; sliding along the surface instead means the projection only has
 * the grid's error left to correct, and the quads come out both rounder and in
 * the right place.
 */
export function relaxSurfaceNet(
  net: SurfaceNet,
  index: SurfaceIndex,
  options: RelaxOptions,
): RelaxReport {
  const count = net.positions.length;
  if (count === 0) return { corners: 0, creases: 0 };

  const neighbours: number[][] = Array.from({ length: count }, () => []);
  for (const quad of net.quads) {
    for (let i = 0; i < quad.length; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % quad.length];
      if (!neighbours[a].includes(b)) neighbours[a].push(b);
      if (!neighbours[b].includes(a)) neighbours[b].push(a);
    }
  }

  const features = options.features?.empty ? null : options.features;
  const pinned: (Vec3 | null)[] = new Array(count).fill(null);
  const onCrease = new Uint8Array(count);
  let corners = 0;
  let creases = 0;

  if (features) {
    // One vertex per corner, and the nearest one wins it: pinning every vertex
    // that came within reach would fold the whole cell ring onto a point.
    const claims = new Map<number, { vertex: number; distance: number }>();
    for (let i = 0; i < count; i++) {
      const hit = features.nearestCorner(net.positions[i], options.cornerRadius);
      if (!hit) continue;
      const held = claims.get(hit.index);
      if (!held || hit.distance < held.distance) {
        claims.set(hit.index, { vertex: i, distance: hit.distance });
      }
    }
    for (const [cornerIndex, held] of claims) {
      const corner = features.corners[cornerIndex];
      pinned[held.vertex] = corner;
      net.positions[held.vertex] = { ...corner };
      corners++;
    }

    // And one vertex per point of a crease, on the same rule and for the same
    // reason. Along an edge where both faces meet the grid squarely the contour
    // has two or three cells to offer per step, and every one of them projects
    // onto the very same point of the line — landing them on top of each other,
    // which is a zero-length edge and a collapsed quad behind it. Nearest first,
    // and the ones that lose stay where the contour put them.
    const claimed = new PointClaims(options.featureRadius);
    for (const held of claims.values()) claimed.take(net.positions[held.vertex]);

    const candidates: { vertex: number; point: Vec3; distance: number }[] = [];
    for (let i = 0; i < count; i++) {
      if (pinned[i]) continue;
      const hit = features.nearestOnSegment(net.positions[i], options.featureRadius);
      if (hit) candidates.push({ vertex: i, point: hit.point, distance: hit.distance });
    }
    candidates.sort((one, other) => one.distance - other.distance);

    for (const candidate of candidates) {
      if (claimed.taken(candidate.point)) {
        // Put it on the face beside the crease rather than leaving it hovering
        // where the contour dropped it: it came within a crease radius of the
        // edge, so it is the projection that has the furthest to drag it back,
        // and a partial one leaves the silhouette lumpy along every edge.
        const hit = index.closest(net.positions[candidate.vertex]);
        if (hit) net.positions[candidate.vertex] = { ...hit.point };
        continue;
      }
      claimed.take(candidate.point);
      onCrease[candidate.vertex] = 1;
      net.positions[candidate.vertex] = candidate.point;
      creases++;
    }
  }

  const normals: Vec3[] = new Array(count).fill(vec3(0, 1, 0));
  const refreshNormal = (i: number): void => {
    const hit = index.closest(net.positions[i]);
    if (hit) normals[i] = hit.normal;
  };
  for (let i = 0; i < count; i++) refreshNormal(i);

  // The length an edge is aiming for at average density; the springs below are
  // stated relative to it, so the mesh keeps the scale it was contoured at.
  let restLength = 0;
  let restCount = 0;
  for (let i = 0; i < count; i++) {
    for (const other of neighbours[i]) {
      if (other <= i) continue;
      restLength += distanceBetween(net.positions[i], net.positions[other]);
      restCount++;
    }
  }
  restLength = restCount > 0 ? restLength / restCount : 0;

  const step = (): void => {
    const moved: Vec3[] = new Array(count);

    for (let i = 0; i < count; i++) {
      const ring = neighbours[i];
      const position = net.positions[i];
      if (pinned[i] || ring.length === 0) {
        moved[i] = position;
        continue;
      }

      // Two forces, both tangential. The centroid evens out the staircase the
      // grid leaves behind; the springs pull every edge towards one length, so
      // a row that the contour left stretched over a slope gets its spacing
      // back rather than only being straightened.
      let centroidX = 0;
      let centroidY = 0;
      let centroidZ = 0;
      let springX = 0;
      let springY = 0;
      let springZ = 0;

      for (const other of ring) {
        const neighbour = net.positions[other];
        centroidX += neighbour.x;
        centroidY += neighbour.y;
        centroidZ += neighbour.z;

        const edgeX = position.x - neighbour.x;
        const edgeY = position.y - neighbour.y;
        const edgeZ = position.z - neighbour.z;
        const length = Math.sqrt(edgeX * edgeX + edgeY * edgeY + edgeZ * edgeZ);
        if (length < 1e-12) continue;

        const push = (restLength - length) / length;
        springX += edgeX * push;
        springY += edgeY * push;
        springZ += edgeZ * push;
      }

      const inverse = 1 / ring.length;
      const deltaX =
        (centroidX * inverse - position.x) * SMOOTH_WEIGHT + springX * inverse * SPRING_WEIGHT;
      const deltaY =
        (centroidY * inverse - position.y) * SMOOTH_WEIGHT + springY * inverse * SPRING_WEIGHT;
      const deltaZ =
        (centroidZ * inverse - position.z) * SMOOTH_WEIGHT + springZ * inverse * SPRING_WEIGHT;

      const normal = normals[i];
      const off = deltaX * normal.x + deltaY * normal.y + deltaZ * normal.z;

      moved[i] = vec3(
        position.x + (deltaX - normal.x * off) * RELAX_RATE,
        position.y + (deltaY - normal.y * off) * RELAX_RATE,
        position.z + (deltaZ - normal.z * off) * RELAX_RATE,
      );
    }

    net.positions = moved;
  };

  /** Puts every vertex back where it is allowed to be after a relaxation pass. */
  const settle = (strength: number): void => {
    for (let i = 0; i < count; i++) {
      const pin = pinned[i];
      if (pin) {
        net.positions[i] = { ...pin };
        continue;
      }

      if (onCrease[i] && features) {
        // Re-found rather than remembered, so a vertex that slid past the end
        // of one segment carries on along the next one of the same crease.
        const hit = features.nearestOnSegment(net.positions[i], options.featureRadius * 2);
        if (hit) {
          net.positions[i] = hit.point;
          continue;
        }
      }

      if (strength <= 0) continue;
      const hit = index.closest(net.positions[i]);
      if (!hit) continue;
      const position = net.positions[i];
      net.positions[i] = vec3(
        position.x + (hit.point.x - position.x) * strength,
        position.y + (hit.point.y - position.y) * strength,
        position.z + (hit.point.z - position.z) * strength,
      );
      normals[i] = hit.normal;
    }
  };

  const passes = Math.max(0, Math.round(options.smoothing));
  for (let pass = 0; pass < passes; pass++) {
    step();
    settle(options.projection);
  }

  // Projection on its own is still worth a pass: it is what snaps the raw
  // staircase back onto a flat wall the grid cut diagonally.
  if (passes === 0) settle(options.projection);

  return { corners, creases };
}

/**
 * Points already spoken for, and whether another lands too near one.
 *
 * Hashed into cells the width of the exclusion radius, so a candidate is only
 * measured against the twenty-seven cells around it rather than against every
 * point taken so far.
 */
class PointClaims {
  private readonly cells = new Map<string, Vec3[]>();
  private readonly radius: number;

  constructor(radius: number) {
    this.radius = Math.max(radius, 1e-9);
  }

  taken(point: Vec3): boolean {
    const limit = this.radius * this.radius;
    const ix = Math.floor(point.x / this.radius);
    const iy = Math.floor(point.y / this.radius);
    const iz = Math.floor(point.z / this.radius);

    for (let x = ix - 1; x <= ix + 1; x++) {
      for (let y = iy - 1; y <= iy + 1; y++) {
        for (let z = iz - 1; z <= iz + 1; z++) {
          for (const other of this.cells.get(`${x},${y},${z}`) ?? []) {
            const dx = other.x - point.x;
            const dy = other.y - point.y;
            const dz = other.z - point.z;
            if (dx * dx + dy * dy + dz * dz < limit) return true;
          }
        }
      }
    }
    return false;
  }

  take(point: Vec3): void {
    const key = `${Math.floor(point.x / this.radius)},${Math.floor(point.y / this.radius)},${Math.floor(point.z / this.radius)}`;
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(point);
    else this.cells.set(key, [point]);
  }
}

function distanceBetween(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
