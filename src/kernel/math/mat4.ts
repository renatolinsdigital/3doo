import { type Vec3, normalize, sub, vec3 } from './vec3';

/** Column-major 4x4 matrix, matching the WebGL/Three.js element order. */
export type Mat4 = readonly number[];

export interface Transform {
  position: Vec3;
  /** Euler XYZ in radians. */
  rotation: Vec3;
  scale: Vec3;
}

export function createTransform(): Transform {
  return { position: vec3(), rotation: vec3(), scale: vec3(1, 1, 1) };
}

export function composeMatrix(transform: Transform): Mat4 {
  const { position, rotation, scale } = transform;
  const cx = Math.cos(rotation.x);
  const sx = Math.sin(rotation.x);
  const cy = Math.cos(rotation.y);
  const sy = Math.sin(rotation.y);
  const cz = Math.cos(rotation.z);
  const sz = Math.sin(rotation.z);

  const m00 = cy * cz;
  const m01 = -cy * sz;
  const m02 = sy;
  const m10 = sx * sy * cz + cx * sz;
  const m11 = -sx * sy * sz + cx * cz;
  const m12 = -sx * cy;
  const m20 = -cx * sy * cz + sx * sz;
  const m21 = cx * sy * sz + sx * cz;
  const m22 = cx * cy;

  return [
    m00 * scale.x,
    m10 * scale.x,
    m20 * scale.x,
    0,
    m01 * scale.y,
    m11 * scale.y,
    m21 * scale.y,
    0,
    m02 * scale.z,
    m12 * scale.z,
    m22 * scale.z,
    0,
    position.x,
    position.y,
    position.z,
    1,
  ];
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
  };
}

/**
 * Maps a world-space displacement into the local space of `transform`.
 *
 * `composeMatrix` builds T·R·S with an orthonormal R, so the inverse is
 * analytic and no general 4x4 inversion is needed: project onto each rotated
 * axis and divide that axis's scale back out. The columns hold
 * `scale · R·axis`, hence the square.
 *
 * The length survives, unlike `inverseTransformDirection`, because a
 * displacement measures a distance travelled. A drag read off the screen comes
 * back through this before it reaches the vertices, or a move along world X
 * lands along the object's own X instead.
 */
export function inverseTransformOffset(transform: Transform, offset: Vec3): Vec3 {
  const m = composeMatrix(transform);
  const along = (column: number, scale: number): number => {
    if (scale === 0) return 0;
    const index = column * 4;
    return (
      (m[index] * offset.x + m[index + 1] * offset.y + m[index + 2] * offset.z) / (scale * scale)
    );
  };
  return vec3(
    along(0, transform.scale.x),
    along(1, transform.scale.y),
    along(2, transform.scale.z),
  );
}

/** Maps a world-space point into the local space of `transform`. */
export function inverseTransformPoint(transform: Transform, point: Vec3): Vec3 {
  return inverseTransformOffset(transform, sub(point, transform.position));
}

/**
 * Rotates a world-space direction into the local frame of `transform`.
 *
 * Scale is divided out once rather than squared, unlike `inverseTransformPoint`:
 * a direction has no position to undo, so this is the transpose of the rotation
 * alone. An axis of rotation must not be stretched by a non-uniform scale.
 */
export function inverseTransformDirection(transform: Transform, direction: Vec3): Vec3 {
  const m = composeMatrix(transform);
  const along = (column: number, scale: number): number => {
    if (scale === 0) return 0;
    const index = column * 4;
    return (
      (m[index] * direction.x + m[index + 1] * direction.y + m[index + 2] * direction.z) / scale
    );
  };
  return normalize(
    vec3(along(0, transform.scale.x), along(1, transform.scale.y), along(2, transform.scale.z)),
  );
}

export function transformDirection(m: Mat4, d: Vec3): Vec3 {
  return {
    x: m[0] * d.x + m[4] * d.y + m[8] * d.z,
    y: m[1] * d.x + m[5] * d.y + m[9] * d.z,
    z: m[2] * d.x + m[6] * d.y + m[10] * d.z,
  };
}

export function rotationMatrix(axis: Vec3, angle: number): Mat4 {
  const a = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * a.x * a.x + c,
    t * a.x * a.y + s * a.z,
    t * a.x * a.z - s * a.y,
    0,
    t * a.x * a.y - s * a.z,
    t * a.y * a.y + c,
    t * a.y * a.z + s * a.x,
    0,
    t * a.x * a.z + s * a.y,
    t * a.y * a.z - s * a.x,
    t * a.z * a.z + c,
    0,
    0,
    0,
    0,
    1,
  ];
}

/**
 * Normal matrix for a transform: the inverse-transpose of the upper 3x3.
 * Only the rotation and scale parts matter, so this inverts the scale directly
 * instead of running a general 4x4 inversion.
 */
export function normalMatrix(transform: Transform): Mat4 {
  const safe = (value: number) => (Math.abs(value) < 1e-12 ? 1e-12 : value);
  const inverseScale = vec3(
    1 / safe(transform.scale.x),
    1 / safe(transform.scale.y),
    1 / safe(transform.scale.z),
  );
  return composeMatrix({
    position: vec3(),
    rotation: transform.rotation,
    scale: inverseScale,
  });
}
