import { centroid } from '../math';
import { BMesh, cloneMesh } from '../mesh';
import { triangulateFaces, trisToQuads } from '../ops/subdivide';

import { type FeatureSegment, type FeatureSet, FeatureIndex, detectFeatures } from './features';
import { type DecimateOptions, type DecimateResult, decimateMesh } from './simplify';
import {
  type Bounds,
  type SurfaceHit,
  type SurfaceTriangle,
  SurfaceIndex,
  buildSurface,
  crossingArea,
  surfaceArea,
  surfaceBounds,
} from './surface';
import {
  type RelaxReport,
  type SurfaceNet,
  type VoxelGrid,
  buildVoxelField,
  relaxSurfaceNet,
  surfaceNets,
} from './voxel';

export {
  buildSurface,
  buildVoxelField,
  crossingArea,
  detectFeatures,
  FeatureIndex,
  decimateMesh,
  relaxSurfaceNet,
  surfaceArea,
  surfaceBounds,
  surfaceNets,
  SurfaceIndex,
};
export type {
  Bounds,
  DecimateOptions,
  DecimateResult,
  FeatureSegment,
  FeatureSet,
  RelaxReport,
  SurfaceHit,
  SurfaceNet,
  SurfaceTriangle,
  VoxelGrid,
};

/**
 * How the topology is rebuilt.
 *
 * `voxel` and `blocks` share one pipeline (sample the model into a signed
 * distance grid, then contour it), and differ only in whether the contour may
 * leave the middle of its cell. `decimate` never rebuilds anything: it
 * collapses the edges that cost the least to lose.
 */
export type RemeshMethod = 'voxel' | 'blocks' | 'decimate';

export type RemeshTopology = 'quads' | 'triangles';

export interface RemeshSettings {
  method: RemeshMethod;
  /** Edge length of one voxel, in object units: the finest detail the grid holds. */
  voxelSize: number;
  /**
   * Aim for `targetFaces` instead of setting the density by hand.
   *
   * The voxel methods solve the face count back into a voxel size, the
   * decimator into a collapse budget: one control, whichever way the topology
   * is being rebuilt.
   */
  adaptive: boolean;
  targetFaces: number;
  /** Relaxation passes over the new surface. Voxel only; blocks are meant to be blocky. */
  smoothing: number;
  /** How far each relaxed vertex is pulled back onto the original surface, 0 to 1. */
  projection: number;
  /**
   * Dihedral angle, in degrees, above which an edge of the source is a crease
   * the result has to keep. Zero lets the grid round every edge off.
   */
  sharpAngle: number;
  /** Fraction of the triangles the decimator keeps when it is not given a target. */
  ratio: number;
  /** Refuse to move the open border of a non-closed mesh. */
  preserveBoundary: boolean;
  topology: RemeshTopology;
  smoothShading: boolean;
}

export const MIN_VOXEL_SIZE = 0.002;
export const MAX_VOXEL_SIZE = 10;
export const MIN_TARGET_FACES = 20;
export const MAX_TARGET_FACES = 200_000;
export const MAX_SMOOTHING = 20;
export const MAX_SHARP_ANGLE = 180;

/**
 * How near a crease a new vertex has to land before it is pulled onto it, as a
 * fraction of the voxel size.
 *
 * Three quarters of a voxel: the cells the crease passes through put their
 * vertex within about half a voxel of it, and anything looser starts dragging
 * the row of quads behind the crease onto it as well, which flattens the
 * surface either side into a ridge.
 */
export const FEATURE_SNAP_RADIUS = 0.75;

/**
 * The same for a corner, in voxels.
 *
 * A corner is one point rather than a line, and the nearest vertex the contour
 * has to offer it can be most of a cell diagonal away: half of a cube would go
 * unpinned at the crease radius.
 */
export const CORNER_SNAP_RADIUS = 1.5;

/**
 * Grid points the sampler may allocate.
 *
 * Roughly a 126³ grid. Past this the wait stops being worth the detail in a
 * browser tab, and the voxel size is raised to fit rather than the job refused.
 */
export const MAX_GRID_CORNERS = 2_000_000;

export const DEFAULT_REMESH_SETTINGS: RemeshSettings = {
  method: 'voxel',
  voxelSize: 0.1,
  adaptive: true,
  targetFaces: 2000,
  smoothing: 2,
  projection: 0.6,
  sharpAngle: 30,
  ratio: 0.5,
  preserveBoundary: true,
  topology: 'quads',
  smoothShading: false,
};

export interface RemeshResult {
  mesh: BMesh;
  /** The voxel size the grid actually ran at; coarser than asked means it was capped. */
  voxelSize: number;
  resolution: { x: number; y: number; z: number };
  /** Creases and corners of the source the result was held to. */
  sharp: RelaxReport;
  warnings: string[];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Keeps every field inside the range the solver can actually work in. */
function normalizeRemeshSettings(settings: RemeshSettings): RemeshSettings {
  return {
    ...settings,
    voxelSize: clamp(settings.voxelSize, MIN_VOXEL_SIZE, MAX_VOXEL_SIZE),
    targetFaces: Math.round(clamp(settings.targetFaces, MIN_TARGET_FACES, MAX_TARGET_FACES)),
    smoothing: Math.round(clamp(settings.smoothing, 0, MAX_SMOOTHING)),
    projection: clamp(settings.projection, 0, 1),
    sharpAngle: clamp(settings.sharpAngle, 0, MAX_SHARP_ANGLE),
    ratio: clamp(settings.ratio, 0.01, 1),
  };
}

/**
 * The voxel size that lands near a face count.
 *
 * Surface nets put one quad on every grid edge that pierces the surface, so the
 * count is the crossing-weighted area divided by the area of one voxel face,
 * which inverts to a closed form rather than a search.
 */
export function voxelSizeForFaces(crossing: number, faces: number): number {
  if (crossing <= 0 || faces <= 0) return DEFAULT_REMESH_SETTINGS.voxelSize;
  return clamp(Math.sqrt(crossing / faces), MIN_VOXEL_SIZE, MAX_VOXEL_SIZE);
}

export interface FaceKinds {
  tris: number;
  quads: number;
  ngons: number;
}

/** How the faces break down by corner count: what "quad-dominant" is measured on. */
export function faceKinds(mesh: BMesh): FaceKinds {
  const kinds: FaceKinds = { tris: 0, quads: 0, ngons: 0 };
  for (const face of mesh.faces.values()) {
    const corners = mesh.faceLoops(face).length;
    if (corners === 3) kinds.tris++;
    else if (corners === 4) kinds.quads++;
    else kinds.ngons++;
  }
  return kinds;
}

/**
 * Rebuilds a mesh's topology.
 *
 * Always returns a new mesh: the caller decides whether it replaces the one it
 * came from, which is what lets the module preview a result before committing
 * to it.
 */
export function remeshMesh(mesh: BMesh, raw: RemeshSettings): RemeshResult {
  const settings = normalizeRemeshSettings(raw);
  const warnings: string[] = [];

  if (mesh.faces.size === 0) throw new Error('the mesh has no faces to rebuild');

  if (settings.method === 'decimate') {
    return decimate(mesh, settings, warnings);
  }

  const triangles = buildSurface(mesh);
  if (triangles.length === 0) throw new Error('the mesh has no faces to rebuild');

  const requested = settings.adaptive
    ? voxelSizeForFaces(crossingArea(triangles), settings.targetFaces)
    : settings.voxelSize;

  const grid = buildVoxelField(triangles, {
    voxelSize: requested,
    maxCorners: MAX_GRID_CORNERS,
  });
  if (grid.voxelSize > requested * 1.01) {
    warnings.push(
      `Voxel size raised to ${grid.voxelSize.toFixed(4)} m to keep the grid under ${(
        MAX_GRID_CORNERS / 1e6
      ).toFixed(1)}M points`,
    );
  }

  const net = surfaceNets(grid, { blocky: settings.method === 'blocks' });
  if (net.positions.length === 0) {
    throw new Error('nothing was enclosed at this voxel size, try a finer one');
  }

  const index = new SurfaceIndex(triangles);
  let kept: RelaxReport = { corners: 0, creases: 0 };

  if (settings.method === 'voxel') {
    // Blocks deliberately skips all of this: its whole look is the grid, and a
    // crease it snapped to would be the one thing not on the lattice.
    const detected = detectFeatures(mesh, settings.sharpAngle);
    const features =
      detected.segments.length > 0 ? new FeatureIndex(detected, grid.voxelSize) : null;

    kept = relaxSurfaceNet(net, index, {
      smoothing: settings.smoothing,
      projection: settings.projection,
      features,
      featureRadius: grid.voxelSize * FEATURE_SNAP_RADIUS,
      cornerRadius: grid.voxelSize * CORNER_SNAP_RADIUS,
    });

    if (detected.corners.length > kept.corners) {
      warnings.push(
        `${detected.corners.length - kept.corners} of ${detected.corners.length} sharp corner(s) were finer than one voxel and rounded off; raise the density to hold them`,
      );
    }
  }

  const result = new BMesh();
  const verts = net.positions.map((position) => result.addVert(position));
  for (const quad of net.quads) {
    const ring = quad.map((vertex) => verts[vertex]);
    if (new Set(ring).size !== ring.length) continue;
    result.addFace(ring, { smooth: settings.smoothShading });
  }
  result.removeLooseVerts();

  transferMaterials(result, triangles, index);
  if (settings.topology === 'triangles') triangulateFaces(result, [...result.faces.values()]);
  result.computeNormals();

  const open = countBoundaryEdges(mesh);
  if (open > 0) {
    warnings.push(
      `${open} open edge(s) were closed over: a voxel remesh only ever produces a solid`,
    );
  }

  return {
    mesh: result,
    voxelSize: grid.voxelSize,
    resolution: { x: grid.nx - 1, y: grid.ny - 1, z: grid.nz - 1 },
    sharp: kept,
    warnings,
  };
}

function decimate(mesh: BMesh, settings: RemeshSettings, warnings: string[]): RemeshResult {
  const sourceTris = mesh.stats().tris;
  const targetTriangles = settings.adaptive
    ? settings.targetFaces * (settings.topology === 'quads' ? 2 : 1)
    : Math.round(sourceTris * settings.ratio);

  // Left exactly as it was rather than triangulated and re-paired into quads:
  // a run that collapses nothing has no business rewriting the topology, and
  // the shuffled face count that came back read as if it had done something.
  if (targetTriangles >= sourceTris) {
    // Stated in faces rather than in the triangles the collapse actually counts
    // in: the control that set it is labelled in faces, and answering in the
    // other unit reads as a different measurement having gone wrong.
    warnings.push(
      settings.adaptive
        ? `Nothing to collapse: this mesh is already down to ${mesh.faces.size.toLocaleString()} faces, below the target of ${settings.targetFaces.toLocaleString()}. Lower the target, or turn TARGET FACE COUNT off and keep a fraction instead.`
        : 'Nothing to collapse: a KEEP of 1 keeps every face. Lower it below 1 to reduce anything.',
    );
    return {
      mesh: cloneMesh(mesh),
      voxelSize: 0,
      resolution: { x: 0, y: 0, z: 0 },
      sharp: { corners: 0, creases: 0 },
      warnings,
    };
  }

  const { mesh: decimated, collapsed } = decimateMesh(mesh, {
    targetTriangles,
    preserveBoundary: settings.preserveBoundary,
  });

  if (decimated.faces.size === 0) throw new Error('every face collapsed; raise the target');
  if (collapsed === 0 && targetTriangles < sourceTris) {
    warnings.push('No collapse was legal: the mesh may be non-manifold or already minimal');
  }

  if (settings.topology === 'quads') trisToQuads(decimated, [...decimated.faces.values()]);
  for (const face of decimated.faces.values()) face.smooth = settings.smoothShading;
  decimated.computeNormals();

  return {
    mesh: decimated,
    voxelSize: 0,
    resolution: { x: 0, y: 0, z: 0 },
    sharp: { corners: 0, creases: 0 },
    warnings,
  };
}

/**
 * Paints the new faces with the slot of whatever they were built over.
 *
 * Skipped entirely on the single-material meshes that are the common case: it
 * costs one nearest-surface query per face, and there is nothing to decide when
 * every face would land on slot zero anyway.
 */
function transferMaterials(
  result: BMesh,
  triangles: readonly SurfaceTriangle[],
  index: SurfaceIndex,
): void {
  const slots = new Set(triangles.map((triangle) => triangle.materialIndex));
  if (slots.size < 2) return;

  for (const face of result.faces.values()) {
    const hit = index.closest(centroid(result.facePoints(face)));
    if (hit) face.materialIndex = hit.materialIndex;
  }
}

function countBoundaryEdges(mesh: BMesh): number {
  let open = 0;
  for (const edge of mesh.edges.values()) if (edge.loops.length === 1) open++;
  return open;
}
