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

export type PivotMode = 'median' | 'cursor' | 'individual' | 'active';

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

