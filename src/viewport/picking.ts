import * as THREE from 'three';

import type { BMesh, SelectMode, Vec3, Vert } from '@kernel/index';
import type { SelectShape } from '@store/types';
import type { ObjectView } from '@bridge/index';

export interface PickResult {
  kind: SelectMode;
  elementId: number;
  /** Object-space point a face pick landed on: which of the loops through it the click names. */
  point?: Vec3;
}

const PICK_RADIUS_PIXELS = 12;

/**
 * How far past edge-on a face has to turn before it counts as facing you.
 *
 * A cosine, so the same number means the same angle at every scale. It is not
 * only there to absorb rounding: the four side faces of a cube seen head-on are
 * exactly edge-on, and whether they land a hair either side of zero decides
 * whether the four corners behind the cube are selectable. Edge-on has to
 * resolve to "not facing", every time.
 */
const FACING_EPSILON = 1e-6;

/** Kernel ids lying on a surface turned towards the camera. */
export interface FacingElements {
  verts: Set<number>;
  edges: Set<number>;
  faces: Set<number>;
}

/**
 * Whether the mesh's own surface is what stands between the camera and its far
 * side, which is the one thing the front-facing test rests on.
 *
 * Only a closed surface, seen from outside it, promises that much. Delete a
 * face and the camera looks in through the hole at the inside of the walls,
 * where every face it can see is turned away: the filter would then refuse the
 * elements the user is aiming at. The wireframe keeps those edges for the same
 * reason (see `frontEdgePositions`), and a pick that cannot reach what is drawn
 * is the bug.
 *
 * The bounding box answers for a camera standing in among the geometry. It is
 * cheap and errs towards leaving everything pickable, which is the safe way to
 * be wrong.
 */
function hidesItsFarSide(mesh: BMesh, eye: THREE.Vector3): boolean {
  if (mesh.faces.size === 0) return false;
  for (const edge of mesh.edges.values()) if (edge.loops.length !== 2) return false;

  const { min, max } = mesh.boundingBox();
  return (
    eye.x < min.x ||
    eye.x > max.x ||
    eye.y < min.y ||
    eye.y > max.y ||
    eye.z < min.z ||
    eye.z > max.z
  );
}

/**
 * What the camera can actually see of a mesh, or null when it can see all of it.
 *
 * Vertices and edges are picked in screen space, which has no idea whether one
 * is round the back, so on a dense mesh the element nearest the pointer in
 * pixels is regularly one hidden behind the model, and a click lands on the far
 * side of the shape being aimed at. Filtering the candidates through this is
 * what makes the pick agree with what is on screen.
 *
 * An element on the silhouette borders a front face and a back one, so it stays
 * pickable. Loose vertices have no face to turn away and stay pickable too, and
 * an open mesh drops the filter altogether (see `hidesItsFarSide`).
 *
 * Self-occlusion (a front-facing surface hidden behind another part of the
 * same model) is not caught here; answering that needs a depth buffer. The far
 * side of the object is the half that makes a dense mesh unusable.
 */
export function facingElements(
  mesh: BMesh,
  matrix: THREE.Matrix4,
  camera: THREE.Camera,
): FacingElements | null {
  const inverse = new THREE.Matrix4().copy(matrix).invert();
  const perspective = camera instanceof THREE.PerspectiveCamera;

  // Both tests run in object space, so nothing is transformed per face. The
  // eye position is exact under any transform; the parallel direction an
  // orthographic camera needs is only approximate under non-uniform scale.
  const eye = camera.position.clone().applyMatrix4(inverse);
  const forward = camera
    .getWorldDirection(new THREE.Vector3())
    .transformDirection(inverse)
    .normalize();

  if (!hidesItsFarSide(mesh, eye)) return null;

  const verts = new Set<number>();
  const edges = new Set<number>();
  const faces = new Set<number>();
  const facedVerts = new Set<number>();

  for (const face of mesh.faces.values()) {
    const loops = mesh.faceLoops(face);
    // Any point on the face does for the plane test, so the centroid is not
    // worth computing over every face of a dense mesh.
    const anchor = loops[0].vert.co;
    const normal = face.normal;

    // Normalised to a cosine either way, so one epsilon covers both cameras and
    // every scale a model might be at.
    let towards: number;
    if (perspective) {
      const dx = eye.x - anchor.x;
      const dy = eye.y - anchor.y;
      const dz = eye.z - anchor.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      towards = distance > 0 ? (normal.x * dx + normal.y * dy + normal.z * dz) / distance : 0;
    } else {
      towards = -(normal.x * forward.x + normal.y * forward.y + normal.z * forward.z);
    }

    const front = towards > FACING_EPSILON;
    if (front) faces.add(face.id);
    for (const loop of loops) {
      facedVerts.add(loop.vert.id);
      if (front) {
        verts.add(loop.vert.id);
        edges.add(loop.edge.id);
      }
    }
  }

  for (const vert of mesh.verts.values()) if (!facedVerts.has(vert.id)) verts.add(vert.id);

  return { verts, edges, faces };
}

/**
 * A point as `SurfaceDepth` compares it: where it lands on the canvas, and how
 * near the camera it is. Nearness is 1 / depth under perspective and the view
 * z under an orthographic camera, both of which run straight across the
 * screen over a triangle and along a line, and both of which grow towards the
 * camera.
 */
export interface Placed {
  screen: THREE.Vector2;
  near: number;
}

/**
 * The surfaces drawn over a patch of the canvas, for asking whether a point is
 * hidden behind them.
 *
 * `facingElements` only knows which side of the model a face is on. A front
 * face hidden behind another part of the model, or behind another object, or
 * seen through a hole in an open mesh, passed it, and a click in solid shading
 * took an edge the surface was drawn over.
 */
export interface SurfaceDepth {
  place(world: THREE.Vector3): Placed | null;
  /** Whether a surface stands in front of a point `near` deep at `screen`. */
  hides(screen: THREE.Vector2, near: number): boolean;
}

/**
 * How much nearer than a point a surface has to be to hide it: a share of the
 * depth under perspective, and of the view's height under an orthographic
 * camera. The surface is evaluated exactly where the point lands, so this only
 * has to absorb the float32 the drawn geometry is stored in.
 */
const HIDDEN_MARGIN = 1e-4;

interface ProjectedVerts {
  geometry: THREE.BufferGeometry;
  version: number;
  matrix: THREE.Matrix4;
  /** Screen x, screen y and nearness per vertex; x is NaN where it cannot be placed. */
  data: Float64Array;
}

/**
 * Projected vertices by mesh. Hovering asks for the surfaces on every pointer
 * move, and with the camera still the projection does not change between them.
 */
const projectedVerts = new WeakMap<THREE.Mesh, ProjectedVerts>();

function placeInto(
  out: Float64Array,
  at: number,
  point: THREE.Vector3,
  toView: THREE.Matrix4,
  camera: THREE.Camera,
  size: { width: number; height: number },
): void {
  point.applyMatrix4(toView);
  const perspective = camera instanceof THREE.PerspectiveCamera;
  if (perspective && -point.z <= camera.near) {
    out[at] = NaN;
    return;
  }
  const near = perspective ? -1 / point.z : point.z;
  point.applyMatrix4(camera.projectionMatrix);
  out[at] = ((point.x + 1) / 2) * size.width;
  out[at + 1] = ((1 - point.y) / 2) * size.height;
  out[at + 2] = near;
}

function projectMesh(
  mesh: THREE.Mesh,
  camera: THREE.Camera,
  size: { width: number; height: number },
): Float64Array {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const toView = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
  const key = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, toView);

  const cached = projectedVerts.get(mesh);
  if (
    cached &&
    cached.geometry === geometry &&
    cached.version === position.version &&
    cached.matrix.equals(key) &&
    cached.data.length === position.count * 3
  ) {
    return cached.data;
  }

  const data = new Float64Array(position.count * 3);
  const point = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    placeInto(data, i * 3, point.fromBufferAttribute(position, i), toView, camera, size);
  }
  projectedVerts.set(mesh, { geometry, version: position.version, matrix: key, data });
  return data;
}

/**
 * Draws `occluders` over `rect` of the canvas, keeping the nearest triangle at
 * each pixel, the way the viewport's own depth test does.
 *
 * Each pixel keeps the triangle rather than a depth, and `hides` carries that
 * triangle's plane from the pixel's centre to the very spot it is asked about.
 * A depth read off a pixel centre is up to half a pixel from the point, and on
 * a face seen at a slant that is a long way in depth: a valley between two
 * faces is deeper than every pixel centre round it, and read that way the edge
 * along it was hidden by its own faces.
 *
 * A point is hidden only when all four pixels round it say so, which leaves a
 * point just past the outline of something in front of it pickable.
 *
 * `cullBackFaces` follows the viewport's preference: with it off, the inside of
 * a surface seen through a hole hides what is behind it, as it does on screen.
 */
export function surfaceDepth(
  occluders: readonly THREE.Mesh[],
  camera: THREE.Camera,
  size: { width: number; height: number },
  rect: BoxSelectRect,
  cullBackFaces: boolean,
): SurfaceDepth {
  const left = Math.floor(rect.minX) - 2;
  const top = Math.floor(rect.minY) - 2;
  const width = Math.max(0, Math.ceil(rect.maxX) + 2 - left);
  const height = Math.max(0, Math.ceil(rect.maxY) + 2 - top);

  const owner = new Int32Array(width * height).fill(-1);
  const nearest = new Float64Array(width * height);
  // a, b, c per triangle: its nearness is a * x + b * y + c across the screen.
  const planes: number[] = [];

  for (const mesh of occluders) {
    const placed = projectMesh(mesh, camera, size);
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : placed.length / 3;
    // A mirrored object turns its triangles over on screen.
    const mirrored = mesh.matrixWorld.determinant() < 0;

    for (let t = 0; t + 2 < count; t += 3) {
      const i0 = (index ? index.getX(t) : t) * 3;
      const i1 = (index ? index.getX(t + 1) : t + 1) * 3;
      const i2 = (index ? index.getX(t + 2) : t + 2) * 3;
      const x0 = placed[i0];
      const x1 = placed[i1];
      const x2 = placed[i2];
      // Through the near plane: left out, which errs towards picking.
      if (Number.isNaN(x0) || Number.isNaN(x1) || Number.isNaN(x2)) continue;
      const y0 = placed[i0 + 1];
      const y1 = placed[i1 + 1];
      const y2 = placed[i2 + 1];

      const fromX = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - left - 0.5));
      const toX = Math.min(width - 1, Math.floor(Math.max(x0, x1, x2) - left - 0.5));
      const fromY = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - top - 0.5));
      const toY = Math.min(height - 1, Math.floor(Math.max(y0, y1, y2) - top - 0.5));
      if (fromX > toX || fromY > toY) continue;

      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-12) continue;
      // Screen y runs down, so a front face winds clockwise here.
      if (cullBackFaces && area > 0 !== mirrored) continue;

      const n0 = placed[i0 + 2];
      const dn1 = placed[i1 + 2] - n0;
      const dn2 = placed[i2 + 2] - n0;
      const a = (dn1 * (y2 - y0) - dn2 * (y1 - y0)) / area;
      const b = ((x1 - x0) * dn2 - (x2 - x0) * dn1) / area;
      const c = n0 - a * x0 - b * y0;
      const triangle = planes.length / 3;
      let kept = false;

      for (let py = fromY; py <= toY; py++) {
        const sy = top + py + 0.5;
        for (let px = fromX; px <= toX; px++) {
          const sx = left + px + 0.5;
          const w0 = (x2 - x1) * (sy - y1) - (y2 - y1) * (sx - x1);
          const w1 = (x0 - x2) * (sy - y2) - (y0 - y2) * (sx - x2);
          const w2 = (x1 - x0) * (sy - y0) - (y1 - y0) * (sx - x0);
          const inside = area > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0;
          if (!inside) continue;

          const near = a * sx + b * sy + c;
          const pixel = py * width + px;
          if (owner[pixel] >= 0 && nearest[pixel] >= near) continue;
          owner[pixel] = triangle;
          nearest[pixel] = near;
          kept = true;
        }
      }
      if (kept) planes.push(a, b, c);
    }
  }

  const perspective = camera instanceof THREE.PerspectiveCamera;
  const orthographic = camera instanceof THREE.OrthographicCamera ? camera : null;
  const viewHeight = orthographic
    ? (orthographic.top - orthographic.bottom) / orthographic.zoom
    : 0;

  return {
    place(world) {
      const out = new Float64Array(3);
      const toView = camera.matrixWorldInverse;
      placeInto(out, 0, world.clone(), toView, camera, size);
      if (Number.isNaN(out[0])) return null;
      return { screen: new THREE.Vector2(out[0], out[1]), near: out[2] };
    },

    hides(screen, near) {
      const slack = perspective ? near * HIDDEN_MARGIN : viewHeight * HIDDEN_MARGIN;
      const fromX = Math.floor(screen.x - left - 0.5);
      const fromY = Math.floor(screen.y - top - 0.5);
      for (let py = fromY; py <= fromY + 1; py++) {
        for (let px = fromX; px <= fromX + 1; px++) {
          if (px < 0 || py < 0 || px >= width || py >= height) return false;
          const triangle = owner[py * width + px];
          if (triangle < 0) return false;
          const surface =
            planes[triangle * 3] * screen.x +
            planes[triangle * 3 + 1] * screen.y +
            planes[triangle * 3 + 2];
          if (surface <= near + slack) return false;
        }
      }
      return true;
    },
  };
}

/** The canvas around `pointer` a click there can reach an element in. */
export function pickRect(pointer: THREE.Vector2): BoxSelectRect {
  return {
    minX: pointer.x - PICK_RADIUS_PIXELS,
    minY: pointer.y - PICK_RADIUS_PIXELS,
    maxX: pointer.x + PICK_RADIUS_PIXELS,
    maxY: pointer.y + PICK_RADIUS_PIXELS,
  };
}

/**
 * How far in from either end of an edge, as a share of it, the edge is asked
 * about. Its ends are vertices, which another edge running across the front
 * can share: asked at the vertex, an edge that runs off it round the back of
 * the model answered for the front one.
 */
function edgeEndShare(a: Placed, b: Placed): number {
  const length = a.screen.distanceTo(b.screen);
  return length > 0 ? Math.min(0.5, EDGE_END_PIXELS / length) : 0.5;
}

const EDGE_END_PIXELS = 2;

/** Whether the point `t` of the way along a placed edge is drawn. */
function edgeShowsAt(depth: SurfaceDepth, a: Placed, b: Placed, t: number): boolean {
  const end = edgeEndShare(a, b);
  const at = THREE.MathUtils.clamp(t, end, 1 - end);
  return !depth.hides(a.screen.clone().lerp(b.screen, at), a.near + (b.near - a.near) * at);
}

/**
 * Aims `raycaster` through `ndc` from where the camera's picture begins.
 *
 * three starts an orthographic ray at the camera's own position, but the
 * viewport's orthographic camera draws from a near plane far in front of that
 * (its `near` is negative), and the position is only the orbit radius off the
 * target, which zooming in shrinks. Anything nearer the viewer than that point
 * was drawn but out of the ray's reach: a click went straight through it to
 * whatever stood behind, and a gizmo standing on it could not be grabbed.
 * Starting on the near plane puts everything on screen ahead of the ray.
 *
 * Called on three's own method rather than through the instance, so it can
 * stand in for `setFromCamera` on a raycaster it is patched onto.
 */
export function aimRay(raycaster: THREE.Raycaster, ndc: THREE.Vector2, camera: THREE.Camera): void {
  THREE.Raycaster.prototype.setFromCamera.call(raycaster, ndc, camera);
  if (camera instanceof THREE.OrthographicCamera) {
    raycaster.ray.origin.addScaledVector(raycaster.ray.direction, camera.near);
  }
}

function project(
  point: THREE.Vector3,
  matrix: THREE.Matrix4,
  camera: THREE.Camera,
  width: number,
  height: number,
): THREE.Vector2 | null {
  const world = point.clone().applyMatrix4(matrix);
  const ndc = world.project(camera);
  // Behind the camera, or outside the depth range: not pickable.
  if (ndc.z < -1 || ndc.z > 1) return null;
  return new THREE.Vector2(((ndc.x + 1) / 2) * width, ((1 - ndc.y) / 2) * height);
}

/** Where vertex `i` of a view's pick buffers lands on the canvas, or null when it cannot. */
function projectVert(
  view: ObjectView,
  i: number,
  camera: THREE.Camera,
  size: { width: number; height: number },
): THREE.Vector2 | null {
  const positions = view.vertPositions;
  return project(
    new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]),
    view.group.matrix,
    camera,
    size.width,
    size.height,
  );
}

/** Where both ends of edge `i` of a view's pick buffers land, or null when either cannot. */
function projectEdge(
  view: ObjectView,
  i: number,
  camera: THREE.Camera,
  size: { width: number; height: number },
): [THREE.Vector2, THREE.Vector2] | null {
  const positions = view.edgePositions;
  const end = (at: number) =>
    project(
      new THREE.Vector3(positions[at], positions[at + 1], positions[at + 2]),
      view.group.matrix,
      camera,
      size.width,
      size.height,
    );

  const a = end(i * 6);
  const b = end(i * 6 + 3);
  return a && b ? [a, b] : null;
}

/**
 * Picks a vertex or edge in screen space rather than by raycast.
 *
 * Vertices and edges have no area to hit, so distance-in-pixels is both more
 * forgiving and closer to what the user sees than a 3D intersection test.
 *
 * `facing` narrows the candidates to what the camera can see; null picks
 * through the model, which is what x-ray and wireframe shading are for.
 * `depth` holds them behind the surfaces drawn round the pointer (see
 * `surfaceDepth`), and is null for the same two shadings.
 */
export function pickElement(
  view: ObjectView,
  mesh: BMesh,
  mode: SelectMode,
  pointer: THREE.Vector2,
  camera: THREE.Camera,
  size: { width: number; height: number },
  raycaster: THREE.Raycaster,
  facing: FacingElements | null,
  depth: SurfaceDepth | null = null,
): PickResult | null {
  const toWorld = (positions: Float32Array, at: number) =>
    new THREE.Vector3(positions[at], positions[at + 1], positions[at + 2]).applyMatrix4(
      view.group.matrix,
    );

  if (mode === 'vertex') {
    let best: PickResult | null = null;
    let bestDistance = PICK_RADIUS_PIXELS;

    for (let i = 0; i < view.vertIds.length; i++) {
      if (facing && !facing.verts.has(view.vertIds[i])) continue;

      const screen = projectVert(view, i, camera, size);
      if (!screen) continue;

      const distance = screen.distanceTo(pointer);
      if (distance >= bestDistance) continue;
      if (depth) {
        const placed = depth.place(toWorld(view.vertPositions, i * 3));
        if (!placed || depth.hides(placed.screen, placed.near)) continue;
      }
      bestDistance = distance;
      best = { kind: 'vertex', elementId: view.vertIds[i] };
    }
    return best;
  }

  if (mode === 'edge') {
    let best: PickResult | null = null;
    let bestDistance = PICK_RADIUS_PIXELS;

    for (let i = 0; i < view.edgeIds.length; i++) {
      if (facing && !facing.edges.has(view.edgeIds[i])) continue;

      const ends = projectEdge(view, i, camera, size);
      if (!ends) continue;

      const distance = distanceToSegment(pointer, ends[0], ends[1]);
      if (distance >= bestDistance) continue;
      if (depth) {
        // Asked where the pointer is nearest it: an edge half behind the model
        // is only there to click on the half that shows.
        const a = depth.place(toWorld(view.edgePositions, i * 6));
        const b = depth.place(toWorld(view.edgePositions, i * 6 + 3));
        if (!a || !b || !edgeShowsAt(depth, a, b, segmentShare(pointer, ends[0], ends[1]))) {
          continue;
        }
      }
      bestDistance = distance;
      best = { kind: 'edge', elementId: view.edgeIds[i] };
    }
    return best;
  }

  const hits = raycaster.intersectObject(view.pickTarget, false);
  const hit = hits[0];
  if (!hit || hit.faceIndex == null) return null;
  if (depth) {
    // The ray only meets this object, and another one can stand in front of it.
    const placed = depth.place(hit.point);
    if (!placed || depth.hides(placed.screen, placed.near)) return null;
  }

  const faceId = view.triangleFaceIds[hit.faceIndex];
  if (faceId === undefined || !mesh.faces.has(faceId)) return null;

  const local = hit.point
    .clone()
    .applyMatrix4(new THREE.Matrix4().copy(view.group.matrix).invert());
  return { kind: 'face', elementId: faceId, point: { x: local.x, y: local.y, z: local.z } };
}

/** How far along the segment from `a` to `b` the point on it nearest `point` is, from 0 to 1. */
function segmentShare(point: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const segment = b.clone().sub(a);
  const lengthSq = segment.lengthSq();
  if (lengthSq < 1e-6) return 0;
  return THREE.MathUtils.clamp(point.clone().sub(a).dot(segment) / lengthSq, 0, 1);
}

function distanceToSegment(point: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  return point.distanceTo(a.clone().lerp(b, segmentShare(point, a, b)));
}

export interface BoxSelectRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Whether a point in canvas pixels falls inside the region a drag swept. */
export type RegionTest = (screen: THREE.Vector2) => boolean;

/**
 * The region a drag swept, asked two ways.
 *
 * `contains` is what edit mode picks with: its elements are points on screen,
 * and a point is either in or out. `crosses` is what object mode needs, where
 * an object counts as touched by a region that cuts across one of its edges
 * without holding either end of it, answered exactly rather than by sampling
 * along the edge, which slips through any region thinner than its step.
 */
export interface Region {
  contains: RegionTest;
  crosses: (a: THREE.Vector2, b: THREE.Vector2) => boolean;
}

export function rectangleRegion(rect: BoxSelectRect): Region {
  const contains: RegionTest = (screen) =>
    screen.x >= rect.minX &&
    screen.x <= rect.maxX &&
    screen.y >= rect.minY &&
    screen.y <= rect.maxY;

  const corners = [
    new THREE.Vector2(rect.minX, rect.minY),
    new THREE.Vector2(rect.maxX, rect.minY),
    new THREE.Vector2(rect.maxX, rect.maxY),
    new THREE.Vector2(rect.minX, rect.maxY),
  ];

  return { contains, crosses: (a, b) => contains(a) || contains(b) || crossesEdges(corners, a, b) };
}

/**
 * The oval a drag swept out from its centre.
 *
 * Both questions are answered in the space where the ellipse is a unit circle:
 * dividing each axis by its own radius turns the stretch into a scale, and what
 * is left is the circle test, which a segment can be measured against exactly.
 */
export function ellipseRegion(centre: THREE.Vector2, rx: number, ry: number): Region {
  // A drag along one axis alone sweeps out no area, and scaling by a radius it
  // never gained would put every point an infinite distance from the middle.
  if (rx <= 0 || ry <= 0) return { contains: () => false, crosses: () => false };

  const origin = new THREE.Vector2(0, 0);
  const unit = (point: THREE.Vector2) =>
    new THREE.Vector2((point.x - centre.x) / rx, (point.y - centre.y) / ry);

  return {
    contains: (screen) => unit(screen).lengthSq() <= 1,
    crosses: (a, b) => distanceToSegment(origin, unit(a), unit(b)) <= 1,
  };
}

/** The round case, which is what a drag sweeps while Shift holds both radii equal. */
export function circleRegion(centre: THREE.Vector2, radius: number): Region {
  return ellipseRegion(centre, radius, radius);
}

/**
 * Even-odd crossing test against the path the pointer drew.
 *
 * The lasso is closed by the segment from its last point back to its first,
 * which is the shape the overlay draws, so what the user let go of is what gets
 * tested.
 */
export function lassoRegion(path: readonly THREE.Vector2[]): Region {
  if (path.length < 3) return { contains: () => false, crosses: () => false };

  const contains: RegionTest = (screen) => {
    let inside = false;
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      const a = path[i];
      const b = path[j];
      if (a.y > screen.y === b.y > screen.y) continue;
      if (screen.x < ((b.x - a.x) * (screen.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };

  return { contains, crosses: (a, b) => contains(a) || contains(b) || crossesEdges(path, a, b) };
}

/** Whether the segment a-b crosses any side of the closed path. */
function crossesEdges(path: readonly THREE.Vector2[], a: THREE.Vector2, b: THREE.Vector2): boolean {
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    if (segmentsIntersect(a, b, path[j], path[i])) return true;
  }
  return false;
}

function segmentsIntersect(
  a: THREE.Vector2,
  b: THREE.Vector2,
  c: THREE.Vector2,
  d: THREE.Vector2,
): boolean {
  const side = (p: THREE.Vector2, q: THREE.Vector2, r: THREE.Vector2) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

  return side(c, d, a) > 0 !== side(c, d, b) > 0 && side(a, b, c) > 0 !== side(a, b, d) > 0;
}

/** What the overlay draws for a drag in progress, in canvas pixels. */
export type Marquee =
  | { kind: 'box'; left: number; top: number; width: number; height: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'lasso'; points: readonly THREE.Vector2[] };

/**
 * The shape a drag draws, alongside `regionForShape` for the one it picks with.
 *
 * Both read the same pair of points on purpose: an oval sweeps out from where
 * the drag began rather than filling the drag's own bounding box, and working
 * that out twice is how what is drawn and what is picked drift apart.
 *
 * `uniform` is Shift, held while the drag runs. An oval takes each radius from
 * how far the pointer has gone along that axis, so it follows the pointer into
 * whatever shape the drag asks for; Shift gives both radii the distance to the
 * pointer instead, which is the circle that grows evenly whichever way it goes.
 */
export function marqueeShape(
  shape: SelectShape,
  start: THREE.Vector2,
  current: THREE.Vector2,
  path: readonly THREE.Vector2[],
  uniform: boolean,
): Marquee {
  if (shape === 'circle') {
    const radius = start.distanceTo(current);
    return {
      kind: 'ellipse',
      cx: start.x,
      cy: start.y,
      rx: uniform ? radius : Math.abs(current.x - start.x),
      ry: uniform ? radius : Math.abs(current.y - start.y),
    };
  }
  if (shape === 'lasso') return { kind: 'lasso', points: path };

  return {
    kind: 'box',
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

/** The region a finished drag swept, in whichever shape was armed. */
export function regionForShape(
  shape: SelectShape,
  start: THREE.Vector2,
  end: THREE.Vector2,
  path: readonly THREE.Vector2[],
  uniform: boolean,
): Region {
  const marquee = marqueeShape(shape, start, end, path, uniform);

  if (marquee.kind === 'ellipse') {
    return ellipseRegion(new THREE.Vector2(marquee.cx, marquee.cy), marquee.rx, marquee.ry);
  }
  if (marquee.kind === 'lasso') return lassoRegion(marquee.points);

  return rectangleRegion({
    minX: marquee.left,
    minY: marquee.top,
    maxX: marquee.left + marquee.width,
    maxY: marquee.top + marquee.height,
  });
}

/** The screen box a marquee covers: what an object has to overlap to be worth testing. */
export function marqueeBounds(marquee: Marquee): BoxSelectRect {
  if (marquee.kind === 'ellipse') {
    return {
      minX: marquee.cx - marquee.rx,
      minY: marquee.cy - marquee.ry,
      maxX: marquee.cx + marquee.rx,
      maxY: marquee.cy + marquee.ry,
    };
  }

  if (marquee.kind === 'box') {
    return {
      minX: marquee.left,
      minY: marquee.top,
      maxX: marquee.left + marquee.width,
      maxY: marquee.top + marquee.height,
    };
  }

  const xs = marquee.points.map((point) => point.x);
  const ys = marquee.points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** An object and the view holding the screen geometry it is drawn from. */
export interface ObjectEntry {
  id: string;
  view: ObjectView;
}

/**
 * The objects a region touches, by id.
 *
 * Touching, not enclosing: an object counts the moment any part of it falls
 * inside the region, so clipping one corner picks the whole thing up. Its
 * vertices answer that for most drags, and its edges answer for a region that
 * cuts across one without holding either end. A region small enough to sit
 * inside a single face touches neither: the caller's ray covers that.
 */
export function pickObjectsInRegion(
  entries: readonly ObjectEntry[],
  region: Region,
  bounds: BoxSelectRect,
  camera: THREE.Camera,
  size: { width: number; height: number },
): string[] {
  const hits: string[] = [];

  for (const entry of entries) {
    let touched = false;

    // One pass over the vertices does double duty: the exact test for most
    // drags, and the object's own screen box for rejecting the edge walk.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < entry.view.vertIds.length; i++) {
      const point = projectVert(entry.view, i, camera, size);
      if (!point) continue;

      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
      if (!touched && region.contains(point)) touched = true;
    }

    if (touched) {
      hits.push(entry.id);
      continue;
    }

    const overlaps =
      minX <= bounds.maxX && maxX >= bounds.minX && minY <= bounds.maxY && maxY >= bounds.minY;
    if (!overlaps) continue;

    if (anyEdgeCrosses(entry.view, region, camera, size)) hits.push(entry.id);
  }

  return hits;
}

function anyEdgeCrosses(
  view: ObjectView,
  region: Region,
  camera: THREE.Camera,
  size: { width: number; height: number },
): boolean {
  for (let i = 0; i < view.edgeIds.length; i++) {
    const ends = projectEdge(view, i, camera, size);
    if (ends && region.crosses(ends[0], ends[1])) return true;
  }

  return false;
}

/**
 * Collects every element the swept region touches.
 *
 * Touching, not enclosing, the rule object mode already picks by: a vertex is a
 * point and is either in or out, but an edge counts the moment the region
 * reaches any part of it, and so does a face. Clipping one corner of a face
 * takes the whole face. Testing the centre alone left a drag across half a
 * large n-gon selecting nothing.
 *
 * `facing` means the same here as it does for a click: null sweeps through the
 * model the way x-ray shading draws it, and anything else takes only what the
 * camera can see. A drag over a dense sphere otherwise takes the far side of it
 * along with the near one.
 *
 * `depth` holds the sweep behind the surfaces drawn over it, as it does a
 * click: an element counts only where some part of it shows.
 */
export function pickInRegion(
  view: ObjectView,
  mode: SelectMode,
  region: Region,
  camera: THREE.Camera,
  size: { width: number; height: number },
  mesh: BMesh,
  facing: FacingElements | null,
  depth: SurfaceDepth | null = null,
): number[] {
  const matrix = view.group.matrix;
  const place = (point: Vec3) =>
    depth?.place(new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrix)) ?? null;
  const toScreen = (point: Vec3) =>
    project(new THREE.Vector3(point.x, point.y, point.z), matrix, camera, size.width, size.height);

  if (mode === 'vertex') {
    const hits: number[] = [];
    for (let i = 0; i < view.vertIds.length; i++) {
      if (facing && !facing.verts.has(view.vertIds[i])) continue;

      const screen = projectVert(view, i, camera, size);
      if (!screen || !region.contains(screen)) continue;
      if (depth) {
        const at = i * 3;
        const placed = place({
          x: view.vertPositions[at],
          y: view.vertPositions[at + 1],
          z: view.vertPositions[at + 2],
        });
        if (!placed || depth.hides(placed.screen, placed.near)) continue;
      }
      hits.push(view.vertIds[i]);
    }
    return hits;
  }

  if (mode === 'edge') {
    const hits: number[] = [];
    for (const edge of mesh.edges.values()) {
      if (facing && !facing.edges.has(edge.id)) continue;

      const a = toScreen(edge.v0.co);
      const b = toScreen(edge.v1.co);
      if (!a || !b) continue;

      // `crosses` asks both halves of the question at once: an end held inside
      // the region, or a region cutting across the middle holding neither end.
      if (!region.crosses(a, b)) continue;
      if (depth && !edgeShowsInRegion(depth, region, place(edge.v0.co), place(edge.v1.co)))
        continue;
      hits.push(edge.id);
    }
    return hits;
  }

  // Every vertex of a quad mesh belongs to four faces, and projecting is what
  // a sweep over a dense mesh spends its time on.
  const projected = new Map<number, THREE.Vector2 | null>();
  const vertScreen = (vert: Vert) => {
    let screen = projected.get(vert.id);
    if (screen === undefined) {
      screen = toScreen(vert.co);
      projected.set(vert.id, screen);
    }
    return screen;
  };

  const hits: number[] = [];
  for (const face of mesh.faces.values()) {
    if (facing && !facing.faces.has(face.id)) continue;

    const corners = mesh.faceVerts(face).map(vertScreen);
    let touched = false;
    for (let i = 0, j = corners.length - 1; i < corners.length && !touched; j = i++) {
      const a = corners[j];
      const b = corners[i];
      if (a && b && region.crosses(a, b)) touched = true;
    }

    // A region sitting wholly inside the face reaches no side of it. The centre
    // answers for one drawn across the middle, and the caller's ray answers for
    // the rest.
    if (!touched) {
      const centre = toScreen(mesh.faceCenter(face));
      touched = centre !== null && region.contains(centre);
    }

    if (touched) hits.push(face.id);
  }
  return depth ? facesShowing(view, depth, hits) : hits;
}

/**
 * Whether any part of an edge inside the region shows, asked every couple of
 * pixels along it. A region too thin to hold one of those asks the whole edge.
 */
function edgeShowsInRegion(
  depth: SurfaceDepth,
  region: Region,
  a: Placed | null,
  b: Placed | null,
): boolean {
  if (!a || !b) return false;
  const steps = THREE.MathUtils.clamp(
    Math.ceil(a.screen.distanceTo(b.screen) / EDGE_END_PIXELS),
    1,
    256,
  );
  const shares = Array.from({ length: steps }, (_, k) => (k + 0.5) / steps);
  const inside = shares.filter((t) => region.contains(a.screen.clone().lerp(b.screen, t)));
  return (inside.length > 0 ? inside : shares).some((t) => edgeShowsAt(depth, a, b, t));
}

/**
 * The faces of `faceIds` any part of which shows, asked of the triangles the
 * view picks from: the middle of each, and halfway from there to each corner.
 * Those are the triangles drawn, so the points lie on the surface even where
 * the face does not lie flat.
 */
function facesShowing(view: ObjectView, depth: SurfaceDepth, faceIds: number[]): number[] {
  const geometry = view.pickTarget.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const corner = (k: number) =>
    new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(k) : k);

  const asked = new Set(faceIds);
  const showing = new Set<number>();
  for (let t = 0; t < view.triangleFaceIds.length; t++) {
    const faceId = view.triangleFaceIds[t];
    if (!asked.has(faceId) || showing.has(faceId)) continue;

    const corners = [corner(t * 3), corner(t * 3 + 1), corner(t * 3 + 2)];
    const middle = corners[0].clone().add(corners[1]).add(corners[2]).divideScalar(3);
    const samples = [middle, ...corners.map((point) => point.lerp(middle, 0.5))];
    const shows = samples.some((sample) => {
      const placed = depth.place(sample.applyMatrix4(view.group.matrix));
      return placed !== null && !depth.hides(placed.screen, placed.near);
    });
    if (shows) showing.add(faceId);
  }
  return faceIds.filter((faceId) => showing.has(faceId));
}
