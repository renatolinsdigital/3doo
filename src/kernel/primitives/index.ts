import { type Vec3, vec3 } from '../math';
import { BMesh } from '../mesh';
import type { Vert } from '../mesh/types';

export type PrimitiveKind =
  | 'cube'
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

/**
 * Params that are a length rather than a count or a flag.
 *
 * One editor unit is one metre, the same metre the export presets mean by
 * "meters" and the ground grid counts in, so these are the fields the UI
 * marks with a unit.
 */
export const METRE_PARAMS = new Set<keyof PrimitiveParams>(['size', 'radius', 'radius2', 'height']);

/**
 * The smallest a length may be set to, in metres, and the floor an object's
 * longest side is held above.
 *
 * A tenth of a millimetre. It sits under the smallest thing anyone builds as
 * real geometry: fine sand runs 0.06 to 0.2 mm across, a human hair 0.02 to
 * 0.18 mm, and a blade of grass 2 to 5 mm wide, so a game's foliage, its
 * particle cards and its smallest hard-surface details all clear it by a wide
 * margin. Below the floor is dust and pollen, which ship as sprites and
 * shaders rather than as meshes.
 *
 * What fixes the floor is the viewport rather than the mesh. Positions reach
 * the GPU as float32 and the near clip plane has to stand well in front of
 * whatever it is looking at, so a shape much finer than this cannot be drawn
 * whole however close the camera gets: it thins, tears open along the near
 * plane, and goes. The camera meets the floor from its own side by drawing
 * the near plane in as the orbit closes, which is what keeps an object this
 * small in one piece on screen.
 */
export const MIN_OBJECT_SIZE = 0.0001;

export const DEFAULT_PRIMITIVE_PARAMS: PrimitiveParams = {
  size: 1,
  radius: 0.5,
  radius2: 0.2,
  height: 1,
  segments: 24,
  rings: 12,
  subdivisions: 2,
  capFill: true,
};

/**
 * Kinds whose sensible starting shape differs from the shared defaults.
 *
 * A capsule at the default height of 1 would be exactly a sphere, since its
 * height spans the rounded caps too, so it gets twice the height instead,
 * which is the one primitive that cannot come in at 1 m all round.
 */
export const PRIMITIVE_DEFAULT_OVERRIDES: Partial<Record<PrimitiveKind, Partial<PrimitiveParams>>> =
  {
    capsule: { height: 2 },
  };

/**
 * Rounds the count params so the properties panel never shows "10.286"
 * segments, and holds every length at or above `MIN_OBJECT_SIZE`.
 */
export function normalizePrimitiveParams(params: PrimitiveParams): PrimitiveParams {
  return {
    ...params,
    size: Math.max(MIN_OBJECT_SIZE, params.size),
    radius: Math.max(MIN_OBJECT_SIZE, params.radius),
    radius2: Math.max(MIN_OBJECT_SIZE, params.radius2),
    height: Math.max(MIN_OBJECT_SIZE, params.height),
    segments: Math.round(params.segments),
    rings: Math.round(params.rings),
    subdivisions: Math.round(params.subdivisions),
  };
}

/** Parameters each primitive actually consumes, used to drive the live panel. */
export const PRIMITIVE_FIELDS: Record<PrimitiveKind, (keyof PrimitiveParams)[]> = {
  cube: ['size'],
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
  cube: 'CUBE',
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
    case 'cube':
      // `createBox` takes one size for all three axes, so the box it builds is
      // a cube. The panel calls it what it is; the mesh factory keeps the
      // general name because nothing else about it is cube-specific.
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

export function createBox(size = 1): BMesh {
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

export function createPlane(size = 1): BMesh {
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

/**
 * The world size an imported image arrives at: its own proportions, with the
 * longer side one metre, which is the size every other primitive starts at.
 *
 * Pixels are not metres and nothing in the file says what the picture is of, so
 * the only honest choices are a fixed size and the right shape. A blueprint
 * scaled to the model it is a reference for is a drag away.
 */
export function imagePlaneSize(
  pixelWidth: number,
  pixelHeight: number,
  longestSide = 1,
): { width: number; height: number } {
  const width = Math.max(1, Math.round(pixelWidth));
  const height = Math.max(1, Math.round(pixelHeight));
  const longest = Math.max(width, height);
  return {
    width: (width / longest) * longestSide,
    height: (height / longest) * longestSide,
  };
}

/**
 * The quad an imported image is drawn on: upright in XY, facing +Z, with the
 * UVs the picture needs to land on it the right way up.
 *
 * Upright rather than flat like `createPlane`, because a reference image is
 * something you model against and a photograph lying face-up on the floor is
 * not. It is an ordinary mesh either way: rotate it flat if that is what the
 * drawing is.
 */
export function createImagePlane(width = 1, height = 1): BMesh {
  const mesh = new BMesh();
  const halfWidth = Math.max(MIN_OBJECT_SIZE, width) / 2;
  const halfHeight = Math.max(MIN_OBJECT_SIZE, height) / 2;

  const verts = [
    mesh.addVert(vec3(-halfWidth, -halfHeight, 0)),
    mesh.addVert(vec3(halfWidth, -halfHeight, 0)),
    mesh.addVert(vec3(halfWidth, halfHeight, 0)),
    mesh.addVert(vec3(-halfWidth, halfHeight, 0)),
  ];
  const face = mesh.addFace(verts);

  // Corner by corner rather than through a projection: this is the one mesh in
  // the app whose UVs have to be exact, since the picture is the point of it.
  const corners = [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 1, v: 1 },
    { u: 0, v: 1 },
  ];
  let index = 0;
  for (const loop of mesh.faceLoops(face)) {
    loop.uv = { ...corners[index] };
    index += 1;
  }

  mesh.computeNormals();
  return mesh;
}

export function createGrid(size = 1, segments = 8): BMesh {
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

/** A horizontal ring of `columns` vertices at height `y`, starting on +X. */
function addRing(mesh: BMesh, columns: number, y: number, radius: number): Vert[] {
  const ring: Vert[] = [];
  for (let column = 0; column < columns; column++) {
    const theta = (column / columns) * Math.PI * 2;
    ring.push(mesh.addVert(vec3(Math.cos(theta) * radius, y, Math.sin(theta) * radius)));
  }
  return ring;
}

/**
 * Closes a stack of rings, top to bottom, into a surface: a fan of triangles
 * to each pole and a band of quads between neighbouring rings.
 */
function skinRings(mesh: BMesh, top: Vert, rings: readonly Vert[][], bottom: Vert): void {
  const columns = rings[0].length;
  const last = rings[rings.length - 1];

  for (let column = 0; column < columns; column++) {
    const next = (column + 1) % columns;
    mesh.addFace([top, rings[0][next], rings[0][column]]);
    mesh.addFace([bottom, last[column], last[next]]);
  }

  for (let row = 0; row < rings.length - 1; row++) {
    for (let column = 0; column < columns; column++) {
      const next = (column + 1) % columns;
      mesh.addFace([
        rings[row][column],
        rings[row][next],
        rings[row + 1][next],
        rings[row + 1][column],
      ]);
    }
  }
}

export function createCircle(radius = 0.5, segments = 24, fill = true): BMesh {
  const mesh = new BMesh();
  const count = Math.max(3, Math.floor(segments));
  const ring = addRing(mesh, count, 0, radius);

  if (fill) {
    mesh.addFace([...ring].reverse());
  } else {
    for (let i = 0; i < count; i++) mesh.addEdge(ring[i], ring[(i + 1) % count]);
  }

  mesh.computeNormals();
  return mesh;
}

export function createCylinder(radius = 0.5, height = 1, segments = 24, caps = true): BMesh {
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

export function createCone(radius = 0.5, height = 1, segments = 24, cap = true): BMesh {
  const mesh = new BMesh();
  const count = Math.max(3, Math.floor(segments));
  const h = height / 2;
  const ring = addRing(mesh, count, -h, radius);
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
export function createCapsule(radius = 0.5, height = 2, segments = 24, rings = 12): BMesh {
  const mesh = new BMesh();
  const columns = Math.max(3, Math.floor(segments));
  const capRows = Math.max(1, Math.floor(Math.max(2, Math.floor(rings)) / 2));
  const straightHalf = Math.max(0, height / 2 - radius);

  const top = mesh.addVert(vec3(0, straightHalf + radius, 0));
  const bottom = mesh.addVert(vec3(0, -straightHalf - radius, 0));
  const grid: Vert[][] = [];

  for (let row = 1; row <= capRows; row++) {
    const phi = (row / capRows) * (Math.PI / 2);
    grid.push(
      addRing(mesh, columns, straightHalf + Math.cos(phi) * radius, Math.sin(phi) * radius),
    );
  }
  for (let row = capRows; row >= 1; row--) {
    const phi = (row / capRows) * (Math.PI / 2);
    grid.push(
      addRing(mesh, columns, -straightHalf - Math.cos(phi) * radius, Math.sin(phi) * radius),
    );
  }

  skinRings(mesh, top, grid, bottom);
  mesh.computeNormals();
  return mesh;
}

export function createUVSphere(radius = 0.5, segments = 24, rings = 12): BMesh {
  const mesh = new BMesh();
  const columns = Math.max(3, Math.floor(segments));
  const rows = Math.max(2, Math.floor(rings));

  const top = mesh.addVert(vec3(0, radius, 0));
  const bottom = mesh.addVert(vec3(0, -radius, 0));
  const grid: Vert[][] = [];

  for (let row = 1; row < rows; row++) {
    const phi = (row / rows) * Math.PI;
    grid.push(addRing(mesh, columns, Math.cos(phi) * radius, Math.sin(phi) * radius));
  }

  skinRings(mesh, top, grid, bottom);
  mesh.computeNormals();
  return mesh;
}

export function createIcoSphere(radius = 0.5, subdivisions = 2): BMesh {
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
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
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

export function createTorus(radius = 0.5, tubeRadius = 0.2, segments = 24, rings = 12): BMesh {
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
        mesh.addVert(
          vec3(Math.cos(u) * distance, tubeRadius * Math.sin(v), Math.sin(u) * distance),
        ),
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
