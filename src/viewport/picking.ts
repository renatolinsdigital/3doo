import * as THREE from 'three';

import type { BMesh, SelectMode, Vec3 } from '@kernel/index';
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
 * What the camera can actually see of a mesh.
 *
 * Vertices and edges are picked in screen space, which has no idea whether one
 * is round the back — so on a dense mesh the element nearest the pointer in
 * pixels is regularly one hidden behind the model, and a click lands on the far
 * side of the shape being aimed at. Filtering the candidates through this is
 * what makes the pick agree with what is on screen.
 *
 * An element on the silhouette borders a front face and a back one, so it stays
 * pickable. Wire edges and loose vertices have no face to turn away and stay
 * pickable too.
 *
 * Self-occlusion — a front-facing surface hidden behind another part of the
 * same model — is not caught here; answering that needs a depth buffer. The far
 * side of the object is the half that makes a dense mesh unusable.
 */
export function facingElements(
  mesh: BMesh,
  matrix: THREE.Matrix4,
  camera: THREE.Camera,
): FacingElements {
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

  const verts = new Set<number>();
  const edges = new Set<number>();
  const faces = new Set<number>();
  const facedVerts = new Set<number>();
  const facedEdges = new Set<number>();

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
      facedEdges.add(loop.edge.id);
      if (front) {
        verts.add(loop.vert.id);
        edges.add(loop.edge.id);
      }
    }
  }

  for (const vert of mesh.verts.values()) if (!facedVerts.has(vert.id)) verts.add(vert.id);
  for (const edge of mesh.edges.values()) if (!facedEdges.has(edge.id)) edges.add(edge.id);

  return { verts, edges, faces };
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

/**
 * Picks a vertex or edge in screen space rather than by raycast.
 *
 * Vertices and edges have no area to hit, so distance-in-pixels is both more
 * forgiving and closer to what the user sees than a 3D intersection test.
 *
 * `facing` narrows the candidates to what the camera can see; null picks
 * through the model, which is what x-ray and wireframe shading are for.
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
): PickResult | null {
  const matrix = view.group.matrix;

  if (mode === 'vertex') {
    let best: PickResult | null = null;
    let bestDistance = PICK_RADIUS_PIXELS;

    for (let i = 0; i < view.vertIds.length; i++) {
      if (facing && !facing.verts.has(view.vertIds[i])) continue;

      const position = new THREE.Vector3(
        view.vertPositions[i * 3],
        view.vertPositions[i * 3 + 1],
        view.vertPositions[i * 3 + 2],
      );
      const screen = project(position, matrix, camera, size.width, size.height);
      if (!screen) continue;

      const distance = screen.distanceTo(pointer);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { kind: 'vertex', elementId: view.vertIds[i] };
      }
    }
    return best;
  }

  if (mode === 'edge') {
    let best: PickResult | null = null;
    let bestDistance = PICK_RADIUS_PIXELS;

    for (let i = 0; i < view.edgeIds.length; i++) {
      if (facing && !facing.edges.has(view.edgeIds[i])) continue;

      const a = project(
        new THREE.Vector3(
          view.edgePositions[i * 6],
          view.edgePositions[i * 6 + 1],
          view.edgePositions[i * 6 + 2],
        ),
        matrix,
        camera,
        size.width,
        size.height,
      );
      const b = project(
        new THREE.Vector3(
          view.edgePositions[i * 6 + 3],
          view.edgePositions[i * 6 + 4],
          view.edgePositions[i * 6 + 5],
        ),
        matrix,
        camera,
        size.width,
        size.height,
      );
      if (!a || !b) continue;

      const distance = distanceToSegment(pointer, a, b);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { kind: 'edge', elementId: view.edgeIds[i] };
      }
    }
    return best;
  }

  const hits = raycaster.intersectObject(view.pickTarget, false);
  const hit = hits[0];
  if (!hit || hit.faceIndex == null) return null;

  const faceId = view.triangleFaceIds[hit.faceIndex];
  if (faceId === undefined || !mesh.faces.has(faceId)) return null;

  const local = hit.point.clone().applyMatrix4(new THREE.Matrix4().copy(matrix).invert());
  return { kind: 'face', elementId: faceId, point: { x: local.x, y: local.y, z: local.z } };
}

function distanceToSegment(point: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const segment = b.clone().sub(a);
  const lengthSq = segment.lengthSq();
  if (lengthSq < 1e-6) return point.distanceTo(a);

  const t = THREE.MathUtils.clamp(point.clone().sub(a).dot(segment) / lengthSq, 0, 1);
  return point.distanceTo(a.clone().addScaledVector(segment, t));
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
 * without holding either end of it — answered exactly rather than by sampling
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

export function circleRegion(centre: THREE.Vector2, radius: number): Region {
  const radiusSq = radius * radius;
  return {
    contains: (screen) => screen.distanceToSquared(centre) <= radiusSq,
    crosses: (a, b) => distanceToSegment(centre, a, b) <= radius,
  };
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
  | { kind: 'circle'; cx: number; cy: number; radius: number }
  | { kind: 'lasso'; points: readonly THREE.Vector2[] };

/**
 * The shape a drag draws, alongside `regionForShape` for the one it picks with.
 *
 * Both read the same pair of points on purpose: a circle sweeps out from where
 * the drag began rather than filling the drag's own bounding box, and working
 * that out twice is how what is drawn and what is picked drift apart.
 */
export function marqueeShape(
  shape: SelectShape,
  start: THREE.Vector2,
  current: THREE.Vector2,
  path: readonly THREE.Vector2[],
): Marquee {
  if (shape === 'circle') {
    return { kind: 'circle', cx: start.x, cy: start.y, radius: start.distanceTo(current) };
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
): Region {
  if (shape === 'circle') return circleRegion(start, start.distanceTo(end));
  if (shape === 'lasso') return lassoRegion(path);

  const box = marqueeShape('box', start, end, path);
  if (box.kind !== 'box') return lassoRegion([]);
  return rectangleRegion({
    minX: box.left,
    minY: box.top,
    maxX: box.left + box.width,
    maxY: box.top + box.height,
  });
}

/** The screen box a marquee covers: what an object has to overlap to be worth testing. */
export function marqueeBounds(marquee: Marquee): BoxSelectRect {
  if (marquee.kind === 'circle') {
    return {
      minX: marquee.cx - marquee.radius,
      minY: marquee.cy - marquee.radius,
      maxX: marquee.cx + marquee.radius,
      maxY: marquee.cy + marquee.radius,
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
 * inside a single face touches neither — the caller's ray covers that.
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
    const matrix = entry.view.group.matrix;
    let touched = false;

    // One pass over the vertices does double duty: the exact test for most
    // drags, and the object's own screen box for rejecting the edge walk.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < entry.view.vertIds.length; i++) {
      const point = project(
        new THREE.Vector3(
          entry.view.vertPositions[i * 3],
          entry.view.vertPositions[i * 3 + 1],
          entry.view.vertPositions[i * 3 + 2],
        ),
        matrix,
        camera,
        size.width,
        size.height,
      );
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

    if (anyEdgeCrosses(entry.view, matrix, region, camera, size)) hits.push(entry.id);
  }

  return hits;
}

function anyEdgeCrosses(
  view: ObjectView,
  matrix: THREE.Matrix4,
  region: Region,
  camera: THREE.Camera,
  size: { width: number; height: number },
): boolean {
  for (let i = 0; i < view.edgeIds.length; i++) {
    const a = project(
      new THREE.Vector3(
        view.edgePositions[i * 6],
        view.edgePositions[i * 6 + 1],
        view.edgePositions[i * 6 + 2],
      ),
      matrix,
      camera,
      size.width,
      size.height,
    );
    const b = project(
      new THREE.Vector3(
        view.edgePositions[i * 6 + 3],
        view.edgePositions[i * 6 + 4],
        view.edgePositions[i * 6 + 5],
      ),
      matrix,
      camera,
      size.width,
      size.height,
    );
    if (!a || !b) continue;

    if (region.crosses(a, b)) return true;
  }

  return false;
}

/**
 * Collects every element whose screen position falls inside the swept region.
 *
 * `facing` means the same here as it does for a click: null sweeps through the
 * model the way x-ray shading draws it, and anything else takes only what the
 * camera can see. A drag over a dense sphere otherwise takes the far side of it
 * along with the near one.
 */
export function pickInRegion(
  view: ObjectView,
  mode: SelectMode,
  region: Region,
  camera: THREE.Camera,
  size: { width: number; height: number },
  mesh: BMesh,
  facing: FacingElements | null,
): number[] {
  const matrix = view.group.matrix;
  const inside = (screen: THREE.Vector2 | null) => screen !== null && region.contains(screen);

  if (mode === 'vertex') {
    const hits: number[] = [];
    for (let i = 0; i < view.vertIds.length; i++) {
      if (facing && !facing.verts.has(view.vertIds[i])) continue;

      const screen = project(
        new THREE.Vector3(
          view.vertPositions[i * 3],
          view.vertPositions[i * 3 + 1],
          view.vertPositions[i * 3 + 2],
        ),
        matrix,
        camera,
        size.width,
        size.height,
      );
      if (inside(screen)) hits.push(view.vertIds[i]);
    }
    return hits;
  }

  if (mode === 'edge') {
    const hits: number[] = [];
    for (const edge of mesh.edges.values()) {
      if (facing && !facing.edges.has(edge.id)) continue;

      const center = mesh.edgeCenter(edge);
      const screen = project(
        new THREE.Vector3(center.x, center.y, center.z),
        matrix,
        camera,
        size.width,
        size.height,
      );
      if (inside(screen)) hits.push(edge.id);
    }
    return hits;
  }

  const hits: number[] = [];
  for (const face of mesh.faces.values()) {
    if (facing && !facing.faces.has(face.id)) continue;

    const center = mesh.faceCenter(face);
    const screen = project(
      new THREE.Vector3(center.x, center.y, center.z),
      matrix,
      camera,
      size.width,
      size.height,
    );
    if (inside(screen)) hits.push(face.id);
  }
  return hits;
}
