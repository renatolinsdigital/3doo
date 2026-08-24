import { type Vec3, vec3 } from '../math';
import { BMesh } from '../mesh';
import type { Vert } from '../mesh/types';

export type PrimitiveKind =
  | 'box'
  | 'plane'
  | 'circle'
  | 'grid'
  | 'uvSphere'
  | 'icoSphere'
  | 'cylinder'
  | 'cone'
  | 'capsule'
  | 'torus';

export interface PrimitiveParams {
  size: number;
  radius: number;
  radius2: number;
  height: number;
  segments: number;
  rings: number;
  subdivisions: number;
  capFill: boolean;
}

/** Counts, not measurements: these can never hold a fraction. */
export const INTEGER_PARAMS = new Set<keyof PrimitiveParams>(['segments', 'rings', 'subdivisions']);

export const DEFAULT_PRIMITIVE_PARAMS: PrimitiveParams = {
  size: 2,
  radius: 1,
  radius2: 0.4,
  height: 2,
  segments: 24,
  rings: 12,
  subdivisions: 2,
  capFill: true,
};

/**
 * Kinds whose sensible starting shape differs from the shared defaults.
 *
 * A capsule at the default height of 2 would be exactly a sphere, since its
 * height spans the rounded caps too.
 */
export const PRIMITIVE_DEFAULT_OVERRIDES: Partial<Record<PrimitiveKind, Partial<PrimitiveParams>>> =
  {
    capsule: { height: 4 },
  };

/** Rounds the count params so the properties panel never shows "10.286" segments. */
export function normalizePrimitiveParams(params: PrimitiveParams): PrimitiveParams {
  return {
    ...params,
    segments: Math.round(params.segments),
    rings: Math.round(params.rings),
    subdivisions: Math.round(params.subdivisions),
  };
}

/** Parameters each primitive actually consumes, used to drive the live panel. */
export const PRIMITIVE_FIELDS: Record<PrimitiveKind, (keyof PrimitiveParams)[]> = {
  box: ['size'],
  plane: ['size'],
  circle: ['radius', 'segments', 'capFill'],
  grid: ['size', 'segments'],
  uvSphere: ['radius', 'segments', 'rings'],
  icoSphere: ['radius', 'subdivisions'],
  cylinder: ['radius', 'height', 'segments', 'capFill'],
  cone: ['radius', 'height', 'segments', 'capFill'],
  capsule: ['radius', 'height', 'segments', 'rings'],
  torus: ['radius', 'radius2', 'segments', 'rings'],
};

export const PRIMITIVE_LABELS: Record<PrimitiveKind, string> = {
  box: 'BOX',
  plane: 'PLANE',
  circle: 'CIRCLE',
  grid: 'GRID',
  uvSphere: 'UV SPHERE',
  icoSphere: 'ICO SPHERE',
  cylinder: 'CYLINDER',
  cone: 'CONE',
  capsule: 'CAPSULE',
  torus: 'TORUS',
};

export function createPrimitive(kind: PrimitiveKind, params: PrimitiveParams): BMesh {
  switch (kind) {
    case 'box':
      return createBox(params.size);
    case 'plane':
      return createPlane(params.size);
    case 'circle':
      return createCircle(params.radius, params.segments, params.capFill);
    case 'grid':
      return createGrid(params.size, params.segments);
    case 'uvSphere':
      return createUVSphere(params.radius, params.segments, params.rings);
    case 'icoSphere':
      return createIcoSphere(params.radius, params.subdivisions);
    case 'cylinder':
      return createCylinder(params.radius, params.height, params.segments, params.capFill);
    case 'cone':
      return createCone(params.radius, params.height, params.segments, params.capFill);
    case 'capsule':
      return createCapsule(params.radius, params.height, params.segments, params.rings);
    case 'torus':
      return createTorus(params.radius, params.radius2, params.segments, params.rings);
  }
}

export function createBox(size = 2): BMesh {
  const mesh = new BMesh();
  const h = size / 2;
  const v = [
    mesh.addVert(vec3(-h, -h, -h)),
    mesh.addVert(vec3(h, -h, -h)),
    mesh.addVert(vec3(h, -h, h)),
    mesh.addVert(vec3(-h, -h, h)),
    mesh.addVert(vec3(-h, h, -h)),
    mesh.addVert(vec3(h, h, -h)),
    mesh.addVert(vec3(h, h, h)),
    mesh.addVert(vec3(-h, h, h)),
  ];

  mesh.addFace([v[0], v[1], v[2], v[3]]); // -y
  mesh.addFace([v[7], v[6], v[5], v[4]]); // +y
  mesh.addFace([v[1], v[0], v[4], v[5]]); // -z
  mesh.addFace([v[3], v[2], v[6], v[7]]); // +z
  mesh.addFace([v[2], v[1], v[5], v[6]]); // +x
  mesh.addFace([v[0], v[3], v[7], v[4]]); // -x

  mesh.computeNormals();
  return mesh;
}

export function createPlane(size = 2): BMesh {
  const mesh = new BMesh();
  const h = size / 2;
  const verts = [
    mesh.addVert(vec3(-h, 0, h)),
    mesh.addVert(vec3(h, 0, h)),
    mesh.addVert(vec3(h, 0, -h)),
    mesh.addVert(vec3(-h, 0, -h)),
  ];
  mesh.addFace(verts);
  mesh.computeNormals();
  return mesh;
}

export function createGrid(size = 2, segments = 8): BMesh {
  const mesh = new BMesh();
  const divisions = Math.max(1, Math.floor(segments));
  const step = size / divisions;
  const start = -size / 2;

  const rows: Vert[][] = [];
  for (let z = 0; z <= divisions; z++) {
    const row: Vert[] = [];
    for (let x = 0; x <= divisions; x++) {
      row.push(mesh.addVert(vec3(start + x * step, 0, start + z * step)));
    }
    rows.push(row);
  }

  for (let z = 0; z < divisions; z++) {
    for (let x = 0; x < divisions; x++) {
      mesh.addFace([rows[z][x], rows[z + 1][x], rows[z + 1][x + 1], rows[z][x + 1]]);
    }
  }

  mesh.computeNormals();
  return mesh;
}

export function createCircle(radius = 1, segments = 24, fill = true): BMesh {
  const mesh = new BMesh();
  const count = Math.max(3, Math.floor(segments));
  const ring: Vert[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    ring.push(mesh.addVert(vec3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)));
  }

  if (fill) {
    mesh.addFace([...ring].reverse());
  } else {
    for (let i = 0; i < count; i++) mesh.addEdge(ring[i], ring[(i + 1) % count]);
  }

  mesh.computeNormals();
  return mesh;
}

export function createCylinder(radius = 1, height = 2, segments = 24, caps = true): BMesh {
  const mesh = new BMesh();
  const count = Math.max(3, Math.floor(segments));
  const h = height / 2;
  const bottom: Vert[] = [];
  const top: Vert[] = [];

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    bottom.push(mesh.addVert(vec3(x, -h, z)));
    top.push(mesh.addVert(vec3(x, h, z)));
  }

  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    mesh.addFace([bottom[i], top[i], top[next], bottom[next]]);
  }

  if (caps) {
    mesh.addFace(bottom);
    mesh.addFace([...top].reverse());
  }

  mesh.computeNormals();
  return mesh;
}

export function createCone(radius = 1, height = 2, segments = 24, cap = true): BMesh {
  const mesh = new BMesh();
  const count = Math.max(3, Math.floor(segments));
  const h = height / 2;
  const ring: Vert[] = [];

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    ring.push(mesh.addVert(vec3(Math.cos(angle) * radius, -h, Math.sin(angle) * radius)));
  }
  const apex = mesh.addVert(vec3(0, h, 0));

  for (let i = 0; i < count; i++) {
    mesh.addFace([ring[(i + 1) % count], ring[i], apex]);
  }
  if (cap) mesh.addFace(ring);

  mesh.computeNormals();
  return mesh;
}

/**
 * Cylinder with hemispherical caps.
 *
 * `height` is the full extent along Y, caps included, so the straight section
 * collapses to nothing once the height drops to the diameter and the result is
 * a plain sphere.
 */
export function createCapsule(radius = 1, height = 4, segments = 24, rings = 12): BMesh {
  const mesh = new BMesh();
  const columns = Math.max(3, Math.floor(segments));
  const capRows = Math.max(1, Math.floor(Math.max(2, Math.floor(rings)) / 2));
  const straightHalf = Math.max(0, height / 2 - radius);

  const addRing = (y: number, ringRadius: number): Vert[] => {
    const ring: Vert[] = [];
    for (let column = 0; column < columns; column++) {
      const theta = (column / columns) * Math.PI * 2;
      ring.push(mesh.addVert(vec3(Math.cos(theta) * ringRadius, y, Math.sin(theta) * ringRadius)));
    }
    return ring;
  };

  const top = mesh.addVert(vec3(0, straightHalf + radius, 0));
  const bottom = mesh.addVert(vec3(0, -straightHalf - radius, 0));
  const grid: Vert[][] = [];

  for (let row = 1; row <= capRows; row++) {
    const phi = (row / capRows) * (Math.PI / 2);
    grid.push(addRing(straightHalf + Math.cos(phi) * radius, Math.sin(phi) * radius));
  }
  for (let row = capRows; row >= 1; row--) {
    const phi = (row / capRows) * (Math.PI / 2);
    grid.push(addRing(-straightHalf - Math.cos(phi) * radius, Math.sin(phi) * radius));
  }

  for (let column = 0; column < columns; column++) {
    const next = (column + 1) % columns;
    mesh.addFace([top, grid[0][next], grid[0][column]]);
    mesh.addFace([bottom, grid[grid.length - 1][column], grid[grid.length - 1][next]]);
  }

  for (let row = 0; row < grid.length - 1; row++) {
    for (let column = 0; column < columns; column++) {
      const next = (column + 1) % columns;
      mesh.addFace([grid[row][column], grid[row][next], grid[row + 1][next], grid[row + 1][column]]);
    }
  }

  mesh.computeNormals();
  return mesh;
}

export function createUVSphere(radius = 1, segments = 24, rings = 12): BMesh {
  const mesh = new BMesh();
  const columns = Math.max(3, Math.floor(segments));
  const rows = Math.max(2, Math.floor(rings));

  const top = mesh.addVert(vec3(0, radius, 0));
  const bottom = mesh.addVert(vec3(0, -radius, 0));
  const grid: Vert[][] = [];

  for (let row = 1; row < rows; row++) {
    const phi = (row / rows) * Math.PI;
    const y = Math.cos(phi) * radius;
    const ringRadius = Math.sin(phi) * radius;
    const ring: Vert[] = [];
    for (let column = 0; column < columns; column++) {
      const theta = (column / columns) * Math.PI * 2;
      ring.push(
        mesh.addVert(vec3(Math.cos(theta) * ringRadius, y, Math.sin(theta) * ringRadius)),
      );
    }
    grid.push(ring);
  }

  for (let column = 0; column < columns; column++) {
    const next = (column + 1) % columns;
    mesh.addFace([top, grid[0][next], grid[0][column]]);
    mesh.addFace([bottom, grid[grid.length - 1][column], grid[grid.length - 1][next]]);
  }

  for (let row = 0; row < grid.length - 1; row++) {
    for (let column = 0; column < columns; column++) {
      const next = (column + 1) % columns;
      mesh.addFace([grid[row][column], grid[row][next], grid[row + 1][next], grid[row + 1][column]]);
    }
  }

  mesh.computeNormals();
  return mesh;
}

export function createIcoSphere(radius = 1, subdivisions = 2): BMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const basePoints: Vec3[] = [
    vec3(-1, t, 0),
    vec3(1, t, 0),
    vec3(-1, -t, 0),
    vec3(1, -t, 0),
    vec3(0, -1, t),
    vec3(0, 1, t),
    vec3(0, -1, -t),
    vec3(0, 1, -t),
    vec3(t, 0, -1),
    vec3(t, 0, 1),
    vec3(-t, 0, -1),
    vec3(-t, 0, 1),
  ];

  let triangles: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  const points = [...basePoints];
  const levels = Math.max(0, Math.min(4, Math.floor(subdivisions)));

  for (let level = 0; level < levels; level++) {
    const midpoints = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const cached = midpoints.get(key);
      if (cached !== undefined) return cached;
      const pa = points[a];
      const pb = points[b];
      points.push(vec3((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, (pa.z + pb.z) / 2));
      const index = points.length - 1;
      midpoints.set(key, index);
      return index;
    };

    const next: [number, number, number][] = [];
    for (const [a, b, c] of triangles) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    triangles = next;
  }

  const mesh = new BMesh();
  const verts = points.map((point) => {
    const length = Math.hypot(point.x, point.y, point.z) || 1;
    const scale = radius / length;
    return mesh.addVert(vec3(point.x * scale, point.y * scale, point.z * scale));
  });

  for (const [a, b, c] of triangles) mesh.addFace([verts[a], verts[b], verts[c]]);

  mesh.removeLooseVerts();
  mesh.computeNormals();
  return mesh;
}

export function createTorus(radius = 1, tubeRadius = 0.4, segments = 24, rings = 12): BMesh {
  const mesh = new BMesh();
  const major = Math.max(3, Math.floor(segments));
  const minor = Math.max(3, Math.floor(rings));
  const grid: Vert[][] = [];

  for (let i = 0; i < major; i++) {
    const u = (i / major) * Math.PI * 2;
    const ring: Vert[] = [];
    for (let j = 0; j < minor; j++) {
      const v = (j / minor) * Math.PI * 2;
      const distance = radius + tubeRadius * Math.cos(v);
      ring.push(
        mesh.addVert(vec3(Math.cos(u) * distance, tubeRadius * Math.sin(v), Math.sin(u) * distance)),
      );
    }
    grid.push(ring);
  }

  for (let i = 0; i < major; i++) {
    const nextI = (i + 1) % major;
    for (let j = 0; j < minor; j++) {
      const nextJ = (j + 1) % minor;
      mesh.addFace([grid[i][j], grid[i][nextJ], grid[nextI][nextJ], grid[nextI][j]]);
    }
  }

  mesh.computeNormals();
  return mesh;
}
