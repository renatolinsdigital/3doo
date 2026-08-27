import { type Vec3, vec3 } from '../math';

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
          const outward = dx * normal.x + dy * normal.y + dz * normal.z >= 0;
          field[cell] = outward ? distance : -distance;
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
  /** Taubin passes; each is one shrinking and one unshrinking step. */
  smoothing: number;
  /** How far a vertex is pulled back onto the original surface, 0 to 1. */
  projection: number;
}

const TAUBIN_LAMBDA = 0.5;
const TAUBIN_MU = -0.53;

/**
 * The retopology loop: relax the net, then pull it back onto the model.
 *
 * Relaxing alone evens out the staircase the grid leaves behind but rounds off
 * everything else with it; re-projecting after each pass is what puts the
 * detail back, and is the difference between a voxel remesh and a blob.
 */
export function relaxSurfaceNet(net: SurfaceNet, index: SurfaceIndex, options: RelaxOptions): void {
  const count = net.positions.length;
  if (count === 0) return;

  const neighbours: number[][] = Array.from({ length: count }, () => []);
  for (const quad of net.quads) {
    for (let i = 0; i < quad.length; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % quad.length];
      if (!neighbours[a].includes(b)) neighbours[a].push(b);
      if (!neighbours[b].includes(a)) neighbours[b].push(a);
    }
  }

  const step = (factor: number) => {
    const moved: Vec3[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const ring = neighbours[i];
      const position = net.positions[i];
      if (ring.length === 0) {
        moved[i] = position;
        continue;
      }
      let x = 0;
      let y = 0;
      let z = 0;
      for (const other of ring) {
        x += net.positions[other].x;
        y += net.positions[other].y;
        z += net.positions[other].z;
      }
      const inv = 1 / ring.length;
      moved[i] = vec3(
        position.x + (x * inv - position.x) * factor,
        position.y + (y * inv - position.y) * factor,
        position.z + (z * inv - position.z) * factor,
      );
    }
    net.positions = moved;
  };

  const project = (strength: number) => {
    if (strength <= 0) return;
    for (let i = 0; i < count; i++) {
      const hit = index.closest(net.positions[i]);
      if (!hit) continue;
      const position = net.positions[i];
      net.positions[i] = vec3(
        position.x + (hit.point.x - position.x) * strength,
        position.y + (hit.point.y - position.y) * strength,
        position.z + (hit.point.z - position.z) * strength,
      );
    }
  };

  const passes = Math.max(0, Math.round(options.smoothing));
  for (let pass = 0; pass < passes; pass++) {
    step(TAUBIN_LAMBDA);
    step(TAUBIN_MU);
    project(options.projection);
  }

  // Projection on its own is still worth a pass: it is what snaps the raw
  // staircase back onto a flat wall the grid cut diagonally.
  if (passes === 0) project(options.projection);
}
