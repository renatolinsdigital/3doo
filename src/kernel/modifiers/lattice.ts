import {
  type Mat4,
  type Vec3,
  add,
  clamp,
  distanceSq,
  lengthSq,
  mul,
  sub,
  transformDirection,
  transformPoint,
  vec3,
} from '../math';
import { BMesh } from '../mesh';

/** How many points a cage holds along each of its own axes. */
export interface LatticeResolution {
  x: number;
  y: number;
  z: number;
}

export const MIN_LATTICE_RESOLUTION = 2;
export const MAX_LATTICE_RESOLUTION = 10;
export const DEFAULT_LATTICE_RESOLUTION: Readonly<LatticeResolution> = { x: 3, y: 3, z: 3 };

/**
 * How the pull of the points is spread between them. LINEAR carries each cell
 * straight across from corner to corner, so a point moved drags exactly its
 * own corner along. SMOOTH runs a B-spline through the points, so the shape
 * flows from one cell into the next without a crease where they meet.
 */
export type LatticeInterpolation = 'linear' | 'smooth';

export function clampLatticeResolution(resolution: LatticeResolution): LatticeResolution {
  const fit = (count: number) =>
    clamp(
      Math.round(count) || MIN_LATTICE_RESOLUTION,
      MIN_LATTICE_RESOLUTION,
      MAX_LATTICE_RESOLUTION,
    );
  return { x: fit(resolution.x), y: fit(resolution.y), z: fit(resolution.z) };
}

export function latticePointCount(resolution: LatticeResolution): number {
  return resolution.x * resolution.y * resolution.z;
}

/**
 * Where each point of a cage sits before anything has moved it: an even grid
 * filling the unit cube about the cage's origin, X fastest, then Y, then Z.
 *
 * The cube is the cage's own space. Its object scale is what stretches it
 * around the mesh it shapes, so the grid always reads the same way however big
 * the cage is drawn.
 */
export function latticeRestPoints(resolution: LatticeResolution): Vec3[] {
  const along = (index: number, count: number) => index / (count - 1) - 0.5;
  const points: Vec3[] = [];
  for (let k = 0; k < resolution.z; k++) {
    for (let j = 0; j < resolution.y; j++) {
      for (let i = 0; i < resolution.x; i++) {
        points.push(vec3(along(i, resolution.x), along(j, resolution.y), along(k, resolution.z)));
      }
    }
  }
  return points;
}

/**
 * A cage as a mesh: one vertex per point, in grid order, each joined to its
 * neighbours along X, Y and Z by a wire edge. No faces, so nothing of it hides
 * the mesh inside.
 */
export function createLatticeMesh(
  resolution: LatticeResolution,
  points: readonly Vec3[] = latticeRestPoints(resolution),
): BMesh {
  const mesh = new BMesh();
  const verts = points.map((point) => mesh.addVert({ ...point }));
  const at = (i: number, j: number, k: number) => verts[i + resolution.x * (j + resolution.y * k)];

  for (let k = 0; k < resolution.z; k++) {
    for (let j = 0; j < resolution.y; j++) {
      for (let i = 0; i < resolution.x; i++) {
        if (i + 1 < resolution.x) mesh.addEdge(at(i, j, k), at(i + 1, j, k));
        if (j + 1 < resolution.y) mesh.addEdge(at(i, j, k), at(i, j + 1, k));
        if (k + 1 < resolution.z) mesh.addEdge(at(i, j, k), at(i, j, k + 1));
      }
    }
  }
  return mesh;
}

/**
 * A cage's points, in grid order, or null when its mesh no longer holds the
 * grid it was built as.
 *
 * The grid is read off the order the vertices were made in, which every copy,
 * save and undo keeps. Edit mode only lets a cage's points move, so a count
 * that has drifted means a mesh that is no longer a cage, and reading it as
 * one would put each point's pull in the wrong place.
 */
export function latticePoints(mesh: BMesh, resolution: LatticeResolution): Vec3[] | null {
  if (mesh.verts.size !== latticePointCount(resolution)) return null;
  return [...mesh.verts.values()].map((vert) => vert.co);
}

/** Which points along one axis pull on a coordinate, and how hard. */
interface AxisWeights {
  indices: number[];
  weights: number[];
}

/**
 * The weights along one axis for a coordinate of the cage's own space.
 *
 * Past the cage's sides the pull fades out over one cell's width rather than
 * stopping dead or carrying on for ever, so a cage around part of a mesh
 * shapes that part and lets the rest go smoothly.
 *
 * SMOOTH is a uniform cubic B-spline, which reaches one point beyond each end
 * of the grid. Those are made up by carrying the last step on in a straight
 * line, which is what lets the ends land exactly on the end points: without it
 * the outermost points only pull part of the way, and a cage would never
 * quite take the corners of its mesh with it.
 */
function axisWeights(
  coordinate: number,
  count: number,
  interpolation: LatticeInterpolation,
): AxisWeights {
  const beyond = (Math.abs(coordinate) - 0.5) * (count - 1);
  const fade = beyond > 0 ? Math.max(0, 1 - beyond) : 1;
  if (fade === 0) return { indices: [], weights: [] };

  const u = (clamp(coordinate, -0.5, 0.5) + 0.5) * (count - 1);
  const cell = Math.min(Math.floor(u), count - 2);
  const t = u - cell;

  if (interpolation === 'linear') {
    return { indices: [cell, cell + 1], weights: [(1 - t) * fade, t * fade] };
  }

  const t2 = t * t;
  const t3 = t2 * t;
  const basis = [
    (1 - t) ** 3 / 6,
    (3 * t3 - 6 * t2 + 4) / 6,
    (-3 * t3 + 3 * t2 + 3 * t + 1) / 6,
    t3 / 6,
  ];

  const indices: number[] = [];
  const weights: number[] = [];
  for (let n = 0; n < 4; n++) {
    const index = cell - 1 + n;
    const weight = basis[n] * fade;
    if (index < 0) {
      indices.push(0, 1);
      weights.push(2 * weight, -weight);
    } else if (index >= count) {
      indices.push(count - 1, count - 2);
      weights.push(2 * weight, -weight);
    } else {
      indices.push(index);
      weights.push(weight);
    }
  }
  return { indices, weights };
}

/**
 * How far the cage carries a point of its own space: the offsets of the
 * points around it from where they rest, weighted by how near it lies to each.
 *
 * Offsets rather than positions, so a cage nobody has shaped moves nothing,
 * whatever its interpolation and wherever it stands.
 */
export function latticeOffset(
  point: Vec3,
  resolution: LatticeResolution,
  offsets: readonly Vec3[],
  interpolation: LatticeInterpolation,
): Vec3 {
  const wx = axisWeights(point.x, resolution.x, interpolation);
  const wy = axisWeights(point.y, resolution.y, interpolation);
  const wz = axisWeights(point.z, resolution.z, interpolation);

  let x = 0;
  let y = 0;
  let z = 0;
  for (let c = 0; c < wz.indices.length; c++) {
    const layer = wz.indices[c] * resolution.y;
    for (let b = 0; b < wy.indices.length; b++) {
      const row = (layer + wy.indices[b]) * resolution.x;
      const weightYZ = wz.weights[c] * wy.weights[b];
      for (let a = 0; a < wx.indices.length; a++) {
        const weight = weightYZ * wx.weights[a];
        const offset = offsets[row + wx.indices[a]];
        x += weight * offset.x;
        y += weight * offset.y;
        z += weight * offset.z;
      }
    }
  }
  return vec3(x, y, z);
}

/**
 * A cage as a lattice modifier reads it: its points in its own space, and the
 * way there and back from the space of the object it shapes.
 */
export interface LatticeCage {
  resolution: LatticeResolution;
  /** In the cage's own space, in grid order. */
  points: readonly Vec3[];
  /** From the shaped object's space into the cage's. */
  toCage: Mat4;
  /** From the cage's space back into the shaped object's. */
  fromCage: Mat4;
}

/**
 * Moves every vertex of `mesh` by the pull of the cage around it, scaled by
 * `strength`. Returns whether anything moved.
 *
 * The pull is read in the cage's space and carried back as a displacement, so a
 * vertex nothing pulls on comes back exactly where it was rather than through
 * two matrices and a rounding error.
 */
export function deformByLattice(
  mesh: BMesh,
  cage: LatticeCage,
  interpolation: LatticeInterpolation,
  strength: number,
): boolean {
  if (cage.points.length !== latticePointCount(cage.resolution)) return false;

  const rest = latticeRestPoints(cage.resolution);
  const offsets = cage.points.map((point, index) => sub(point, rest[index]));
  if (offsets.every((offset) => lengthSq(offset) < 1e-18)) return false;

  let moved = false;
  for (const vert of mesh.verts.values()) {
    const local = transformPoint(cage.toCage, vert.co);
    const offset = latticeOffset(local, cage.resolution, offsets, interpolation);
    if (lengthSq(offset) < 1e-18) continue;
    vert.co = add(vert.co, transformDirection(cage.fromCage, mul(offset, strength)));
    moved = true;
  }
  return moved;
}

/**
 * The points of a cage rebuilt at another resolution, each placed where the
 * old grid had carried that spot, so the shape it was given survives the
 * change as closely as the new grid can hold it. At its own resolution a grid
 * comes back exactly as it was.
 */
export function resampleLattice(
  resolution: LatticeResolution,
  points: readonly Vec3[],
  next: LatticeResolution,
): Vec3[] {
  if (resolution.x === next.x && resolution.y === next.y && resolution.z === next.z) {
    return points.map((point) => ({ ...point }));
  }
  const rest = latticeRestPoints(resolution);
  const offsets = points.map((point, index) => sub(point, rest[index]));
  return latticeRestPoints(next).map((point) =>
    add(point, latticeOffset(point, resolution, offsets, 'linear')),
  );
}

/** A grid a cage was shaped on by hand: its resolution and where its points stood. */
export interface LatticeShape {
  resolution: LatticeResolution;
  points: Vec3[];
}

/**
 * The shape a change of resolution rebuilds a cage from, or undefined when
 * there is none to keep and the new grid starts at rest.
 *
 * That is the shape the cage remembers, while its points still stand where
 * resampling that shape put them. A point moved by hand since makes the grid
 * as it stands the shape instead. Rebuilding from the shape rather than from
 * whatever the last change left is what lets a pass through a coarser grid and
 * back give the shape back, where resampling each grid from the one before
 * wears it away a little every step, and a 2 point axis drops it entirely.
 */
export function latticeShape(
  resolution: LatticeResolution,
  points: readonly Vec3[],
  remembered: LatticeShape | undefined,
): LatticeShape | undefined {
  if (remembered) {
    const expected = resampleLattice(remembered.resolution, remembered.points, resolution);
    if (expected.every((point, index) => distanceSq(point, points[index]) < 1e-18)) {
      return remembered;
    }
  }

  const rest = latticeRestPoints(resolution);
  if (points.every((point, index) => distanceSq(point, rest[index]) < 1e-18)) return undefined;
  return { resolution: { ...resolution }, points: points.map((point) => ({ ...point })) };
}
