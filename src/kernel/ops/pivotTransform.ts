import { type Vec3, add, mulVec, rotationMatrix, sub, transformDirection } from '../math';

export type PivotTool = 'move' | 'rotate' | 'scale';

export interface PivotDelta {
  /** World-space translation since the drag started (move tool). */
  translation: Vec3;
  /** Rotation axis and angle (radians) since the drag started (rotate tool). */
  rotationAxis: Vec3;
  rotationAngle: number;
  /** Componentwise scale factor since the drag started (scale tool). */
  scaleRatio: Vec3;
}

/**
 * Moves a point that started at `basePosition`, as part of a group pivoted at
 * `pivot`, by the group's accumulated delta since the drag started.
 *
 * Rotate and scale act on the point's offset from the pivot, so it orbits or
 * spreads from the pivot rather than staying put, then add the pivot back.
 * This is what lets a multi-object selection rotate or scale together around
 * their shared centre instead of each object spinning in place.
 *
 * For a single selected object the pivot is defined as that object's own base
 * position, so the offset is zero: rotate/scale leave the position unchanged
 * and only the object's own rotation/scale (handled by the caller) changes,
 * exactly how a lone object already behaved before a group pivot existed.
 */
export function pivotPosition(
  basePosition: Vec3,
  pivot: Vec3,
  tool: PivotTool,
  delta: PivotDelta,
): Vec3 {
  if (tool === 'move') return add(basePosition, delta.translation);

  const offset = sub(basePosition, pivot);

  if (tool === 'rotate') {
    const matrix = rotationMatrix(delta.rotationAxis, delta.rotationAngle);
    return add(transformDirection(matrix, offset), pivot);
  }

  return add(mulVec(offset, delta.scaleRatio), pivot);
}
