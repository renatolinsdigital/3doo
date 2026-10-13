import {
  type Transform,
  type Vec3,
  EPSILON,
  add,
  centroid,
  clamp,
  composeMatrix,
  dot,
  length,
  mul,
  mulVec,
  rotationMatrix,
  sub,
  transformPoint,
  vec3,
} from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Vert } from '../mesh/types';
import { MIN_OBJECT_SIZE } from '../primitives';

export type FalloffCurve = 'smooth' | 'sphere' | 'root' | 'linear' | 'sharp' | 'constant';

export const FALLOFF_CURVES: readonly FalloffCurve[] = [
  'smooth',
  'sphere',
  'root',
  'linear',
  'sharp',
  'constant',
];

export interface ProportionalOptions {
  enabled: boolean;
  radius: number;
  falloff: FalloffCurve;
}

/**
 * Which unselected vertices a proportional edit carries, and how far each one
 * goes with it.
 *
 * Worked out once and then handed to every step of a drag, for two reasons.
 * The cheap one is that finding it means measuring every vertex in the mesh
 * against every selected one, which on a 98k-vertex mesh cost a third of a
 * second on each pointer move. The one that matters more is that the answer is
 * supposed to be fixed: the falloff is measured from where the selection stood
 * when the drag began, and recomputing it from the vertices as they move lets
 * the circle of influence crawl across the mesh as you drag.
 */
export interface ProportionalInfluence {
  reached: readonly { vert: Vert; influence: number }[];
}

function isInfluence(
  value: ProportionalOptions | ProportionalInfluence | undefined,
): value is ProportionalInfluence {
  return value !== undefined && 'reached' in value;
}

/**
 * The vertices within the falloff radius of a selection, with their weights.
 *
 * Measured from where the selection is when this is called, which for a drag
 * means where it stood at the start (see `ProportionalInfluence`).
 */
export function proportionalInfluence(
  mesh: BMesh,
  verts: readonly Vert[],
  options: ProportionalOptions,
): ProportionalInfluence {
  const reached: { vert: Vert; influence: number }[] = [];
  if (!options.enabled || options.radius <= 0) return { reached };

  const selected = new Set(verts.map((vert) => vert.id));
  const origins = verts.map((vert) => vert.co);
  const radius = options.radius;

  for (const candidate of mesh.verts.values()) {
    if (selected.has(candidate.id)) continue;

    let nearestSquared = Infinity;
    for (const origin of origins) {
      const dx = candidate.co.x - origin.x;
      const dy = candidate.co.y - origin.y;
      const dz = candidate.co.z - origin.z;
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared < nearestSquared) nearestSquared = squared;
      // Nothing nearer than touching, so stop measuring the rest.
      if (nearestSquared === 0) break;
    }
    if (nearestSquared >= radius * radius) continue;

    const influence = falloff(1 - Math.sqrt(nearestSquared) / radius, options.falloff);
    if (influence > 0) reached.push({ vert: candidate, influence });
  }

  return { reached };
}

export function medianPoint(verts: readonly Vert[]): Vec3 {
  return centroid(verts.map((vert) => vert.co));
}

/**
 * Applies a per-vertex displacement, optionally spreading it to nearby
 * unselected geometry through a falloff curve (proportional editing).
 */
function applyDisplacement(
  mesh: BMesh,
  verts: readonly Vert[],
  displace: (vert: Vert, influence: number) => Vec3,
  proportional?: ProportionalOptions | ProportionalInfluence,
): void {
  // Worked out before anything moves: the falloff measures from where the
  // selection started, and a set handed in was measured at the start of a drag
  // for the same reason.
  const spread = isInfluence(proportional)
    ? proportional
    : proportional?.enabled && proportional.radius > 0
      ? proportionalInfluence(mesh, verts, proportional)
      : null;

  const moved: Vert[] = [...verts];
  for (const vert of verts) vert.co = displace(vert, 1);

  if (spread) {
    for (const { vert, influence } of spread.reached) {
      vert.co = displace(vert, influence);
      moved.push(vert);
    }
  }

  // Only the faces around what moved can have turned, and on a dense mesh that
  // is the difference between a pointer move costing a couple of milliseconds
  // and costing the best part of a second.
  mesh.computeNormals(moved);
}

export function translateVerts(
  mesh: BMesh,
  verts: readonly Vert[],
  offset: Vec3,
  proportional?: ProportionalOptions | ProportionalInfluence,
): void {
  applyDisplacement(
    mesh,
    verts,
    (vert, influence) =>
      add(vert.co, { x: offset.x * influence, y: offset.y * influence, z: offset.z * influence }),
    proportional,
  );
}

export function rotateVerts(
  mesh: BMesh,
  verts: readonly Vert[],
  axis: Vec3,
  angle: number,
  pivot: Vec3,
  proportional?: ProportionalOptions | ProportionalInfluence,
): void {
  applyDisplacement(
    mesh,
    verts,
    (vert, influence) => {
      const matrix = rotationMatrix(axis, angle * influence);
      return add(transformPoint(matrix, sub(vert.co, pivot)), pivot);
    },
    proportional,
  );
}

/**
 * Scales `verts` about `pivot` by `scale` along the mesh's own axes or, given
 * the object's transform as `frame`, along the world's.
 */
export function scaleVerts(
  mesh: BMesh,
  verts: readonly Vert[],
  scale: Vec3,
  pivot: Vec3,
  proportional?: ProportionalOptions | ProportionalInfluence,
  frame?: Transform,
): void {
  const rows = frame ? worldScaleRows(frame, scale) : null;
  const along = rows ? alongOwnAxes(rows) : scale;

  applyDisplacement(
    mesh,
    verts,
    (vert, influence) => {
      const offset = sub(vert.co, pivot);
      if (rows && !along) {
        // The stretch is linear in the factor and none at a factor of one, so
        // a partial influence takes the same share of the whole displacement.
        const stretched = vec3(dot(rows[0], offset), dot(rows[1], offset), dot(rows[2], offset));
        return add(add(offset, mul(sub(stretched, offset), influence)), pivot);
      }
      const factor = along ?? scale;
      const blended = vec3(
        1 + (factor.x - 1) * influence,
        1 + (factor.y - 1) * influence,
        1 + (factor.z - 1) * influence,
      );
      return add(mulVec(offset, blended), pivot);
    },
    proportional,
  );
}

/**
 * A scale of `factor` along the world's axes as the object placed by `frame`
 * sees it: the rows of the matrix it applies to an offset in its own space.
 *
 * The edit-mode handles stand world-aligned while the mesh is stored in the
 * object's own space. Handing the factor straight to the mesh stretched a
 * turned object along whichever of its own axes shared the name: on a plane
 * stood upright, the vertical handle pushed its edges back and forth in depth.
 *
 * Entry (i, j) is how much of own axis j, stretched out in the world, lands
 * back along own axis i, rescaled by the object's size along each: an axis
 * drawn twice as long needs half the coordinate to cover the same distance.
 */
function worldScaleRows(frame: Transform, factor: Vec3): [Vec3, Vec3, Vec3] {
  const turn = composeMatrix({ position: vec3(), rotation: frame.rotation, scale: vec3(1, 1, 1) });
  const axes = [0, 1, 2].map((column) =>
    vec3(turn[column * 4], turn[column * 4 + 1], turn[column * 4 + 2]),
  );
  const sizes = [frame.scale.x, frame.scale.y, frame.scale.z];

  const row = (i: number) => {
    const entry = (j: number) => {
      const share = dot(axes[i], mulVec(axes[j], factor));
      if (i === j) return share;
      // An axis flattened to nothing has no length in the world for the
      // others to land along, so its coordinates keep only their own share.
      return Math.abs(sizes[i]) < EPSILON ? 0 : (share * sizes[j]) / sizes[i];
    };
    return vec3(entry(0), entry(1), entry(2));
  };
  return [row(0), row(1), row(2)];
}

/** The factor along each own axis when `rows` stretch along those alone, else null. */
function alongOwnAxes(rows: readonly [Vec3, Vec3, Vec3]): Vec3 | null {
  const largest = Math.max(
    ...rows.flatMap(({ x, y, z }) => [Math.abs(x), Math.abs(y), Math.abs(z)]),
  );
  const across = [rows[0].y, rows[0].z, rows[1].x, rows[1].z, rows[2].x, rows[2].y];
  if (across.some((value) => Math.abs(value) > largest * 1e-9)) return null;
  return vec3(rows[0].x, rows[1].y, rows[2].z);
}

/**
 * The factor along the object's own axes that does what a scale of `factor`
 * along the world's does, or null when none can.
 *
 * There is one whenever the world's axes the factor differs along lie along
 * the object's own: no turn, a turn in quarter turns, or a factor the same in
 * every direction. Otherwise the scale also leans each own axis toward the
 * others, which a factor per axis cannot say.
 */
export function ownAxesScale(frame: Transform, factor: Vec3): Vec3 | null {
  return alongOwnAxes(worldScaleRows(frame, factor));
}

/**
 * How long an edge measures out in the world, in metres.
 *
 * The object's scale is applied, because that is the size on screen and the
 * size an export writes out, while the mesh underneath is stored in the
 * object's own space. Rotation is left out on purpose: it turns an edge
 * without stretching it, so it cannot change the answer.
 */
export function edgeLength(edge: Edge, scale: Vec3): number {
  return length(mulVec(sub(edge.v1.co, edge.v0.co), scale));
}

/**
 * Stretches each edge to `target` metres, measured out in the world.
 *
 * Both ends travel, equally and in opposite directions, so an edge keeps its
 * midpoint and its direction and only its length changes. Nothing else moves,
 * which means the faces around each edge are reshaped to follow it.
 *
 * The caller is expected to have checked that no two of these edges share a
 * vertex. Handed a pair that does, the second edge moves a vertex the first one
 * had already placed, and neither ends up the length that was asked for.
 *
 * Returns how many edges were resized. An edge with no length at all is
 * skipped: nothing about it says which way its ends would have to travel.
 */
export function setEdgeLengths(
  mesh: BMesh,
  edges: readonly Edge[],
  target: number,
  scale: Vec3,
): number {
  const moved: Vert[] = [];

  for (const edge of edges) {
    const current = edgeLength(edge, scale);
    if (current < EPSILON) continue;

    // Half the change to each end, which is what leaves the midpoint where it is.
    const half = mul(sub(edge.v1.co, edge.v0.co), (target / current - 1) / 2);
    edge.v0.co = sub(edge.v0.co, half);
    edge.v1.co = add(edge.v1.co, half);
    moved.push(edge.v0, edge.v1);
  }

  mesh.computeNormals(moved);
  return moved.length / 2;
}

/**
 * `scale` held back so the object still measures `MIN_OBJECT_SIZE` or more
 * across its longest side.
 *
 * Object scale is the one dial that reaches a size nothing can draw. A drag
 * carries it down by a ratio per tick, so it passes a hundredth and a
 * millionth at the same speed, and what is left is a shape the near clip plane
 * saws through before it disappears entirely. The floor is on the size the
 * object ends up at rather than on the number in the field, because a scale of
 * 0.01 means one thing on a 2 m box and quite another on a 2 mm screw head.
 *
 * Edit mode is deliberately not held to this. Flattening a selection to
 * nothing is how a sharp edge gets made, and that is geometry someone typed
 * rather than a viewport running out of room.
 */
export function clampObjectScale(mesh: BMesh, scale: Vec3): Vec3 {
  const largest = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
  // At unit scale or above, the only way under the floor is a mesh built that
  // fine to begin with, which the check below leaves alone anyway. Returning
  // here keeps the bounding box off the hot path of every ordinary drag.
  if (largest >= 1) return scale;

  const box = mesh.boundingBox();
  const extent = sub(box.max, box.min);

  const widest = Math.max(
    extent.x * Math.abs(scale.x),
    extent.y * Math.abs(scale.y),
    extent.z * Math.abs(scale.z),
  );
  if (widest >= MIN_OBJECT_SIZE) return scale;

  const unit = Math.max(extent.x, extent.y, extent.z);
  // Nothing here to hold up: a mesh with no size at all, or one already built
  // finer than the floor, which was somebody's modelling and not this dial.
  if (unit < MIN_OBJECT_SIZE) return scale;

  // Scaled flat to nothing there is no proportion left to keep, so it comes
  // back uniform and a drag has something above zero to pull on again.
  if (largest === 0) {
    const floor = MIN_OBJECT_SIZE / unit;
    return vec3(floor, floor, floor);
  }

  // One factor across the whole vector: the proportions hold, and an axis
  // scaled negative keeps the sign that mirrors the mesh. Capped at unit
  // scale so an axis the mesh is flat along, which carries no size to
  // measure, cannot drag the other two up with it.
  const factor = Math.min(MIN_OBJECT_SIZE / widest, 1 / largest);
  return vec3(scale.x * factor, scale.y * factor, scale.z * factor);
}

export function falloff(t: number, curve: FalloffCurve): number {
  const x = clamp(t, 0, 1);
  switch (curve) {
    case 'smooth':
      return x * x * (3 - 2 * x);
    case 'sphere':
      return Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x)));
    case 'root':
      return Math.sqrt(x);
    case 'linear':
      return x;
    case 'sharp':
      return x * x;
    case 'constant':
      return x > 0 ? 1 : 0;
  }
}
