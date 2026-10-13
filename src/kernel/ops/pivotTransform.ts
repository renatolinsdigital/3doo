import {
  type Mat4,
  type Vec3,
  add,
  composeMatrix,
  length,
  mulVec,
  rotationMatrix,
  sub,
  transformDirection,
  vec3,
} from '../math';

export type PivotTool = 'move' | 'rotate' | 'scale';

export interface PivotDelta {
  /** World-space translation since the drag started (move tool). */
  translation: Vec3;
  /** Rotation axis and angle (radians) since the drag started (rotate tool). */
  rotationAxis: Vec3;
  rotationAngle: number;
  /** Componentwise scale factor since the drag started (scale tool). */
  scaleRatio: Vec3;
  /**
   * Euler XYZ of the axes `scaleRatio` runs along: the handles' own turn,
   * which is the object's for a lone object and the world's for a group.
   */
  scaleFrame: Vec3;
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

  return add(scaleAlong(delta.scaleFrame, delta.scaleRatio, offset), pivot);
}

/** The turn a Euler XYZ names, with no position or scale left on it. */
function eulerMatrix(rotation: Vec3): Mat4 {
  return composeMatrix({ position: vec3(), rotation, scale: vec3(1, 1, 1) });
}

/**
 * `direction` turned by the inverse of `m`.
 *
 * For a pure rotation that is its transpose: the columns are orthonormal, so
 * dotting the direction against each one reads off what the turn put there.
 */
function unrotate(m: Mat4, direction: Vec3): Vec3 {
  return vec3(
    m[0] * direction.x + m[1] * direction.y + m[2] * direction.z,
    m[4] * direction.x + m[5] * direction.y + m[6] * direction.z,
    m[8] * direction.x + m[9] * direction.y + m[10] * direction.z,
  );
}

/**
 * Where a point that started at `basePosition` lands when the orientation it
 * belongs to is set outright, from Euler `from` to Euler `to`, about `pivot`.
 *
 * The companion to `pivotPosition` for a turn that is typed rather than
 * dragged: a field names the orientation it wants instead of the turn that
 * reaches it, so the turn is recovered by undoing the old one before applying
 * the new. About the object's own origin the offset is zero and it turns where
 * it stands; about the 3D cursor the origin swings round it, which is what a
 * gizmo turn about the cursor already does.
 */
export function pivotReorient(basePosition: Vec3, pivot: Vec3, from: Vec3, to: Vec3): Vec3 {
  const offset = sub(basePosition, pivot);
  return add(transformDirection(eulerMatrix(to), unrotate(eulerMatrix(from), offset)), pivot);
}

/** `direction` stretched by `ratio` along the axes of the Euler XYZ `frame`. */
function scaleAlong(frame: Vec3, ratio: Vec3, direction: Vec3): Vec3 {
  const turn = eulerMatrix(frame);
  return transformDirection(turn, mulVec(unrotate(turn, direction), ratio));
}

/**
 * An object's own scale after a scale of `ratio` along the axes of `frame`.
 *
 * The object's scale runs along its own axes, which need not be the frame's: a
 * group's handles are world-aligned while each object in it is turned its own
 * way. Multiplying the ratio straight onto the scale stretched a turned object
 * along whichever of its axes shared the name, sideways or upward on screen.
 *
 * Each of the object's axes instead takes on however much the scale lengthens
 * it. That is exact whenever the object's axes lie along the frame's, as they
 * do for a lone object and for one turned in quarter turns. At any other angle
 * the true answer is a shear, which a position, rotation and scale cannot
 * hold, so the turn stays and each axis keeps the length the scale gave it.
 */
export function pivotScale(baseScale: Vec3, rotation: Vec3, frame: Vec3, ratio: Vec3): Vec3 {
  const turn = eulerMatrix(rotation);
  const stretch = (column: number) =>
    length(
      scaleAlong(frame, ratio, vec3(turn[column * 4], turn[column * 4 + 1], turn[column * 4 + 2])),
    );
  return mulVec(baseScale, vec3(stretch(0), stretch(1), stretch(2)));
}
