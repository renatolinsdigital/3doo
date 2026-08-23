export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Axis = 'x' | 'y' | 'z';

export const AXES: readonly Axis[] = ['x', 'y', 'z'];

export const EPSILON = 1e-9;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function clone(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function mul(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function mulVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x * b.x, y: a.y * b.y, z: a.z * b.z };
}

export function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Vec3): number {
  return Math.sqrt(lengthSq(a));
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

export function distanceSq(a: Vec3, b: Vec3): number {
  return lengthSq(sub(a, b));
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < EPSILON) return vec3(0, 0, 0);
  return mul(a, 1 / len);
}

export function negate(a: Vec3): Vec3 {
  return { x: -a.x, y: -a.y, z: -a.z };
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

export function equals(a: Vec3, b: Vec3, tolerance = 1e-6): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.z - b.z) <= tolerance
  );
}

export function centroid(points: readonly Vec3[]): Vec3 {
  if (points.length === 0) return vec3();
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
    z += p.z;
  }
  const inv = 1 / points.length;
  return { x: x * inv, y: y * inv, z: z * inv };
}

/**
 * Newell's method. Works for non-planar and concave polygons where a simple
 * edge cross-product would pick a degenerate or inverted normal.
 */
export function polygonNormal(points: readonly Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const current = points[i];
    const next = points[(i + 1) % count];
    nx += (current.y - next.y) * (current.z + next.z);
    ny += (current.z - next.z) * (current.x + next.x);
    nz += (current.x - next.x) * (current.y + next.y);
  }
  return normalize(vec3(nx, ny, nz));
}

export function polygonArea(points: readonly Vec3[]): number {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const current = points[i];
    const next = points[(i + 1) % count];
    nx += current.y * next.z - current.z * next.y;
    ny += current.z * next.x - current.x * next.z;
    nz += current.x * next.y - current.y * next.x;
  }
  return length(vec3(nx, ny, nz)) * 0.5;
}

/** Builds an orthonormal basis around `normal`, used for planar projection. */
export function basisFromNormal(normal: Vec3): { u: Vec3; v: Vec3 } {
  const reference = Math.abs(normal.z) < 0.9 ? vec3(0, 0, 1) : vec3(1, 0, 0);
  const u = normalize(cross(reference, normal));
  const v = cross(normal, u);
  return { u, v };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function radToDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function axisVector(axis: Axis): Vec3 {
  return axis === 'x' ? vec3(1, 0, 0) : axis === 'y' ? vec3(0, 1, 0) : vec3(0, 0, 1);
}
