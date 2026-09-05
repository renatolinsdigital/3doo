import {
  type Vec3,
  add,
  centroid,
  clamp,
  mulVec,
  rotationMatrix,
  sub,
  transformPoint,
  vec3,
} from '../math';
import type { BMesh } from '../mesh';
import type { Vert } from '../mesh/types';
import { MIN_OBJECT_SIZE } from '../primitives';

export type PivotMode = 'origin' | 'median' | 'cursor';

export type FalloffCurve = 'smooth' | 'sphere' | 'root' | 'linear' | 'sharp' | 'constant';

export interface ProportionalOptions {
  enabled: boolean;
  radius: number;
  falloff: FalloffCurve;
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
  proportional?: ProportionalOptions,
): void {
  const selectedIds = new Set(verts.map((vert) => vert.id));
  // Falloff has to measure from where the selection started, so capture the
  // origins before anything moves.
  const origins = verts.map((vert) => vert.co);

  for (const vert of verts) vert.co = displace(vert, 1);

  if (proportional?.enabled && proportional.radius > 0) {
    for (const candidate of mesh.verts.values()) {
      if (selectedIds.has(candidate.id)) continue;

      let nearest = Infinity;
      for (const origin of origins) {
        const distance = Math.hypot(
          candidate.co.x - origin.x,
          candidate.co.y - origin.y,
          candidate.co.z - origin.z,
        );
        if (distance < nearest) nearest = distance;
      }
      if (nearest >= proportional.radius) continue;

      const influence = falloff(1 - nearest / proportional.radius, proportional.falloff);
      if (influence <= 0) continue;
      candidate.co = displace(candidate, influence);
    }
  }

  mesh.computeNormals();
}

export function translateVerts(
  mesh: BMesh,
  verts: readonly Vert[],
  offset: Vec3,
  proportional?: ProportionalOptions,
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
  proportional?: ProportionalOptions,
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

export function scaleVerts(
  mesh: BMesh,
  verts: readonly Vert[],
  scale: Vec3,
  pivot: Vec3,
  proportional?: ProportionalOptions,
): void {
  applyDisplacement(
    mesh,
    verts,
    (vert, influence) => {
      const blended = vec3(
        1 + (scale.x - 1) * influence,
        1 + (scale.y - 1) * influence,
        1 + (scale.z - 1) * influence,
      );
      return add(mulVec(sub(vert.co, pivot), blended), pivot);
    },
    proportional,
  );
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

