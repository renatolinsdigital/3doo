import { type Axis, AXES, type Vec3, axisVector, cross, dot, vec3 } from '../math';
import { BMesh } from '../mesh';
import type { Edge, Vert } from '../mesh/types';
// Straight from the file rather than the ops barrel, which reaches back into
// this folder through the transforms.
import { bevelEdges } from '../ops/bevel';

/** A point on a plane, written `[across, up]`. */
export type Point2 = readonly [number, number];

const SAME_POINT = 1e-9;

/** The points without repeats, so no edge of the result has zero length. */
function distinct(points: readonly Point2[], closed: boolean): Point2[] {
  const kept: Point2[] = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (
      last &&
      Math.abs(last[0] - point[0]) < SAME_POINT &&
      Math.abs(last[1] - point[1]) < SAME_POINT
    )
      continue;
    kept.push(point);
  }
  if (closed && kept.length > 1) {
    const [first, last] = [kept[0], kept[kept.length - 1]];
    if (Math.abs(first[0] - last[0]) < SAME_POINT && Math.abs(first[1] - last[1]) < SAME_POINT) {
      kept.pop();
    }
  }
  return kept;
}

/** Twice the area a loop of points encloses: positive when it runs anticlockwise. */
function signedArea(points: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    area += ax * by - bx * ay;
  }
  return area;
}

export interface LatheOptions {
  /** Points round the axis, 3 or more. Default 24. */
  segments?: number;
  /** The profile is a loop, as for a ring, rather than a line from one end to the other. */
  closed?: boolean;
  /** Fill an open end that stops short of the axis. Default true. */
  caps?: boolean;
}

/**
 * A profile turned round the Y axis, as on a lathe.
 *
 * Each point is `[radius, y]`. An end on the axis, at radius 0, closes to a
 * single vertex, which is how a bottle gets a bottom with no seam. The profile
 * may be written in either direction: the faces are wound so that their
 * normals face away from the axis side of it.
 */
export function createLathe(profile: readonly Point2[], options: LatheOptions = {}): BMesh {
  const segments = Math.max(3, Math.floor(options.segments ?? 24));
  const closed = options.closed ?? false;
  let points = distinct(profile, closed);
  if (points.length < (closed ? 3 : 2)) {
    throw new Error(`A lathe needs ${closed ? 'three' : 'two'} or more distinct points.`);
  }

  // The faces face away from the region the profile closes off: for a line,
  // the region between it and the axis. Anticlockwise in (radius, y) is the
  // winding that faces out.
  const outline: Point2[] = closed
    ? points
    : [...points, [0, points[points.length - 1][1]], [0, points[0][1]]];
  if (signedArea(outline) < 0) points = [...points].reverse();

  const mesh = new BMesh();
  const rings: (Vert | Vert[])[] = points.map(([radius, y]) => {
    if (radius <= SAME_POINT) return mesh.addVert(vec3(0, y, 0));
    const ring: Vert[] = [];
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      ring.push(mesh.addVert(vec3(Math.cos(angle) * radius, y, Math.sin(angle) * radius)));
    }
    return ring;
  });

  const spans = closed ? points.length : points.length - 1;
  for (let span = 0; span < spans; span++) {
    const a = rings[span];
    const b = rings[(span + 1) % rings.length];
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      if (Array.isArray(a) && Array.isArray(b)) mesh.addFace([a[i], b[i], b[next], a[next]]);
      else if (Array.isArray(b)) mesh.addFace([a as Vert, b[i], b[next]]);
      else if (Array.isArray(a)) mesh.addFace([a[i], b, a[next]]);
    }
  }

  if (!closed && (options.caps ?? true)) {
    const first = rings[0];
    const last = rings[rings.length - 1];
    // With the profile wound outward, the start is always the lower end of the
    // region it closes off and the finish the upper one.
    if (Array.isArray(first)) mesh.addFace(first);
    if (Array.isArray(last)) mesh.addFace([...last].reverse());
  }

  mesh.computeNormals();
  return mesh;
}

export interface OutlineOptions {
  /**
   * The world axes the points are written in, across and then up: `['x', 'y']`
   * for an outline seen from the front. The outline is pushed out along the
   * third axis.
   */
  plane: readonly [Axis, Axis];
  /** How thick the solid is, centred on the plane through the origin. */
  depth: number;
  /** Rounds off the edges round both faces by this much. Default 0. */
  bevel?: number;
  /** Faces across that bevel, 1 or more. Default 1. */
  bevelSegments?: number;
}

/**
 * A flat outline made solid: the shape a blade, a sign or a cut-out profile
 * has. Each face of it is the outline itself, a single face however concave,
 * which the renderer and the exporters triangulate by ear clipping.
 */
export function createOutlinePrism(points: readonly Point2[], options: OutlineOptions): BMesh {
  const [across, up] = options.plane;
  const through = AXES.find((axis) => axis !== across && axis !== up);
  if (!through || across === up) throw new Error('An outline plane takes two different axes.');

  let loop = distinct(points, true);
  if (loop.length < 3) throw new Error('An outline needs three or more distinct points.');
  const area = signedArea(loop);
  if (Math.abs(area) < SAME_POINT) throw new Error('The outline encloses no area.');

  // Anticlockwise in (across, up) faces along across × up, which is the third
  // axis for x and y but its opposite for z and y, or x and z. The face on the
  // positive side has to face that way.
  const handed = dot(cross(axisVector(across), axisVector(up)), axisVector(through));
  if (area * handed < 0) loop = [...loop].reverse();

  const half = Math.max(options.depth, SAME_POINT) / 2;
  const at = ([a, b]: Point2, depth: number): Vec3 => {
    const point = vec3();
    point[across] = a;
    point[up] = b;
    point[through] = depth;
    return point;
  };

  const mesh = new BMesh();
  const front = loop.map((point) => mesh.addVert(at(point, half)));
  const back = loop.map((point) => mesh.addVert(at(point, -half)));
  mesh.addFace(front);
  mesh.addFace([...back].reverse());
  for (let i = 0; i < loop.length; i++) {
    const next = (i + 1) % loop.length;
    mesh.addFace([front[i], back[i], back[next], front[next]]);
  }

  if (options.bevel !== undefined && options.bevel > 0) {
    const rims: Edge[] = [];
    for (const ring of [front, back]) {
      for (let i = 0; i < ring.length; i++) {
        const edge = mesh.findEdge(ring[i], ring[(i + 1) % ring.length]);
        if (edge) rims.push(edge);
      }
    }
    bevelEdges(mesh, rims, {
      width: options.bevel,
      segments: options.bevelSegments ?? 1,
      clampOverlap: true,
    });
  }

  mesh.computeNormals();
  return mesh;
}
