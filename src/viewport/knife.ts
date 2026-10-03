import * as THREE from 'three';

import {
  type BMesh,
  type Face,
  type KnifePoint,
  type Loop,
  type Vec3,
  type Vert,
  basisFromNormal,
  cross,
  dot,
  knifePointFaces,
  lengthSq,
  lerp,
  normalize,
  sub,
  vec3,
} from '@kernel/index';

import { aimRay } from './picking';

/** How far from a vertex the pointer may land and still take it, in pixels: the selection's own reach. */
const VERT_SNAP_PX = 12;

/**
 * How far from an edge the pointer may land and still take it, in pixels.
 *
 * Tighter than a vertex: inside this band a click lands on the edge, and a band
 * as wide as the vertex one would leave no room for a point inside a small face.
 */
const EDGE_SNAP_PX = 8;

/**
 * How near the cut line a vertex may be drawn and the line be taken through it.
 *
 * A line drawn past a vertex half a pixel off is a line through it. Cutting the
 * edges either side instead would leave two slivers nobody could see to fix.
 */
const ON_LINE_PX = 1;

/**
 * How far past the end of a slice the line of sight may pass and still count
 * as meeting it, as a fraction of the slice.
 *
 * Seen square on, a box's far corners sit exactly behind its near ones, and a
 * line of sight to one of them grazes the near face right at its corner.
 * Rounding decides whether that graze lands a hair inside or outside the face,
 * and the corner behind it has to come out hidden every time.
 */
const GRAZE = 1e-9;

/**
 * A direction lined up with no world axis, for planes that must not lie flat
 * against a face: modelled faces are so often square to an axis that a plane
 * built from one regularly coincides with them.
 */
const SKEW = normalize(vec3(1, 2, 3));

/**
 * What the knife needs of the camera, with everything in the object's own space.
 *
 * Handed in rather than read off a camera here, so the arithmetic below can be
 * tested against a camera with no canvas or viewport around it.
 */
export interface KnifeView {
  /** Where an object-space point is drawn on the canvas, or null when it is behind the camera. */
  project: (point: Vec3) => THREE.Vector2 | null;
  /** The line of sight through a canvas pixel, starting where the picture does. */
  sight: (pixel: THREE.Vector2) => { origin: Vec3; direction: Vec3 };
  /**
   * Whether the surface hides what is behind it from the knife. False in x-ray
   * and wireframe, which cut through, the way they select through.
   */
  occlude: boolean;
}

/** A point of a cut and where it sits, in the object's own space. */
export interface KnifeMark {
  point: KnifePoint;
  co: Vec3;
}

/** Where a click landed: on the mesh, or out along the line of sight over empty space. */
export interface KnifeAnchor {
  at: Vec3;
  /** What it landed on, or null for empty space. */
  mark: KnifeMark | null;
}

/** A straight piece of a cut across one face, between two points on it. */
export interface KnifeSection {
  from: KnifeMark;
  to: KnifeMark;
  face: number;
}

/**
 * One click of a cut being drawn, and what the line to it from the click
 * before cut.
 *
 * Each line is worked out as it is drawn, from the view it was drawn in, and
 * kept: turning the camera halfway through a cut to reach round the model does
 * not move the part already drawn.
 */
export interface KnifeStep extends KnifeAnchor {
  /** Whether it starts a line of its own: the first click, or the first after the knife was lifted. */
  starts: boolean;
  /** One piece for every face the line to it crossed. Empty when it starts a line. */
  sections: KnifeSection[];
}

export interface KnifeTargetOptions {
  /** The face under the pointer and where on it, from the viewport's ray. Null over empty space. */
  surface: KnifeMark | null;
  /** The points of the cut so far: a line can close on one of them. */
  marks: readonly KnifeMark[];
  /** The pieces of the cut so far: a line can end on one of them. */
  sections: readonly KnifeSection[];
  /** Whether vertices and edges pull the point onto them. Shift turns it off. */
  snap: boolean;
  /** Whether an edge gives its middle rather than the spot nearest the pointer. Ctrl. */
  midpoint: boolean;
}

/**
 * The knife's view of one object: the camera, brought into its own space.
 *
 * `size` is the canvas in CSS pixels, which is what every pointer position is
 * measured in.
 */
export function knifeViewOf(
  camera: THREE.Camera,
  matrix: THREE.Matrix4,
  size: { width: number; height: number },
  occlude: boolean,
): KnifeView {
  const inverse = matrix.clone().invert();
  const raycaster = new THREE.Raycaster();
  const point = new THREE.Vector3();

  return {
    project: (co) => {
      point.set(co.x, co.y, co.z).applyMatrix4(matrix).project(camera);
      if (point.z < -1 || point.z > 1) return null;
      return new THREE.Vector2(((point.x + 1) / 2) * size.width, ((1 - point.y) / 2) * size.height);
    },
    sight: (pixel) => {
      const ndc = new THREE.Vector2(
        (pixel.x / size.width) * 2 - 1,
        -(pixel.y / size.height) * 2 + 1,
      );
      aimRay(raycaster, ndc, camera);
      const origin = raycaster.ray.origin.clone().applyMatrix4(inverse);
      const direction = raycaster.ray.direction.clone().transformDirection(inverse);
      return {
        origin: vec3(origin.x, origin.y, origin.z),
        direction: vec3(direction.x, direction.y, direction.z),
      };
    },
    occlude,
  };
}

/**
 * Where a click with the knife would land: on a vertex or a point of the cut
 * near the pointer, failing that on an edge or a piece of the cut near it,
 * failing that on the face under it. Null over empty space.
 *
 * Only what the camera can see is in reach, unless the view is see-through.
 */
export function knifeTarget(
  mesh: BMesh,
  pointer: THREE.Vector2,
  view: KnifeView,
  options: KnifeTargetOptions,
): KnifeMark | null {
  if (!options.snap) return options.surface;

  const screen = new Map<number, THREE.Vector2 | null>();
  for (const vert of mesh.verts.values()) screen.set(vert.id, view.project(vert.co));

  const sight = view.sight(pointer);
  const pick = (candidates: Candidate[]) => {
    for (const candidate of candidates) {
      candidate.depth = dot(sub(candidate.mark.co, sight.origin), sight.direction);
    }
    candidates.sort(byReach);
    return candidates.find(({ mark }) => !hidden(mesh, view, mark))?.mark ?? null;
  };

  return (
    pick(nearPoints(mesh, pointer, view, options.marks, screen)) ??
    pick(nearLines(mesh, pointer, view, options, screen)) ??
    options.surface
  );
}

/** Something a click could land on, how far from the pointer it is drawn, and how far off it is. */
interface Candidate {
  mark: KnifeMark;
  distance: number;
  depth: number;
}

/**
 * Nearest the pointer first, and of two drawn in the same spot the one nearer
 * the camera: square on to a box, every far corner sits exactly behind a near
 * one, and the near one is what the pointer is on.
 */
function byReach(first: Candidate, second: Candidate): number {
  const spot = (candidate: Candidate) => Math.round(candidate.distance * 2);
  return spot(first) - spot(second) || first.depth - second.depth;
}

/**
 * What a straight line between two clicks cuts: one piece for every face it
 * crosses, from where it enters the face to where it leaves, or to a click
 * inside it.
 *
 * The line is the one drawn on screen, so the pieces are where the mesh is
 * sliced by the plane holding both lines of sight, which is exact under
 * perspective. A vertex drawn within a pixel of the line is taken as lying on
 * it, and the slices are clipped to the stretch between the two clicks.
 *
 * Every face is sliced on its own, so a see-through view cuts every layer the
 * line passes over without any of them getting in each other's way: a line
 * across a box seen square on goes all the way round it. Otherwise a piece is
 * kept only where the camera can see it.
 *
 * `marks` are the points of the cut so far. A line crossing an edge within a
 * pixel of one goes through it, so a cut closing round a model meets itself.
 */
export function knifeSections(
  mesh: BMesh,
  from: KnifeAnchor,
  to: KnifeAnchor,
  view: KnifeView,
  marks: readonly KnifeMark[] = [],
): KnifeSection[] {
  const a = view.project(from.at);
  const b = view.project(to.at);
  if (!a || !b) return [];

  const along = b.clone().sub(a);
  const length = along.length();
  if (length < 1) return [];

  const normal = normalize(cross(view.sight(a).direction, sub(to.at, from.at)));
  if (lengthSq(normal) === 0) return [];

  // Half a pixel at either end belongs to the clicks themselves.
  const margin = 0.5 / length;
  const param = (pixel: THREE.Vector2) => pixel.clone().sub(a).dot(along) / (length * length);

  const sides = new Map<number, number>();
  const side = (vert: Vert): number => {
    let distance = sides.get(vert.id);
    if (distance !== undefined) return distance;

    distance = dot(sub(vert.co, from.at), normal);
    const pixel = view.project(vert.co);
    if (pixel) {
      const s = param(pixel);
      const off = Math.abs((pixel.x - a.x) * along.y - (pixel.y - a.y) * along.x) / length;
      if (off <= ON_LINE_PX && s >= -margin && s <= 1 + margin) distance = 0;
    }
    sides.set(vert.id, distance);
    return distance;
  };

  const vertMarks = new Map<number, KnifeMark>();
  const edgeMarks = new Map<number, KnifeMark>();
  const markOf = (loop: Loop, t: number): KnifeMark => {
    if (t === 0 || t === 1) {
      const vert = t === 0 ? loop.vert : loop.next.vert;
      let mark = vertMarks.get(vert.id);
      if (!mark) {
        mark = marks.find(
          (known) => known.point.kind === 'vert' && known.point.vert === vert.id,
        ) ?? { point: { kind: 'vert', vert: vert.id }, co: vert.co };
        vertMarks.set(vert.id, mark);
      }
      return mark;
    }

    const { edge } = loop;
    let mark = edgeMarks.get(edge.id);
    if (!mark) {
      const co = lerp(loop.vert.co, loop.next.vert.co, t);
      const pixel = view.project(co);
      mark = marks.find(
        (known) =>
          known.point.kind === 'edge' &&
          known.point.edge === edge.id &&
          pixel !== null &&
          near(view, known.co, pixel),
      ) ?? { point: { kind: 'edge', edge: edge.id, t: edge.v0 === loop.vert ? t : 1 - t }, co };
      edgeMarks.set(edge.id, mark);
    }
    return mark;
  };

  const slices = sliceFaces(mesh, normal, side, markOf);
  const clip = (slice: Slice<KnifeMark>, anchor: KnifeAnchor, pixel: THREE.Vector2): KnifeMark => {
    // A click inside the face is where its piece ends. Anywhere else the piece
    // stops where the click's line of sight passes it, which in a see-through
    // view is the click carried through to the faces behind it.
    if (anchor.mark && knifePointFaces(mesh, anchor.mark.point).includes(slice.face)) {
      return anchor.mark;
    }
    const co = lerp(
      slice.from.co,
      slice.to.co,
      closestAlong(view.sight(pixel), slice.from.co, slice.to.co),
    );
    return { point: { kind: 'face', face: slice.face.id, co }, co };
  };

  const sections: KnifeSection[] = [];
  for (const slice of slices) {
    const first = view.project(slice.from.co);
    const second = view.project(slice.to.co);
    if (!first || !second) continue;

    const forward = param(first) <= param(second);
    let start = forward ? slice.from : slice.to;
    let end = forward ? slice.to : slice.from;
    const sStart = Math.min(param(first), param(second));
    const sEnd = Math.max(param(first), param(second));
    if (sEnd <= margin || sStart >= 1 - margin) continue;

    if (sStart < -margin) start = clip(slice, from, a);
    if (sEnd > 1 + margin) end = clip(slice, to, b);
    if (start === end || lengthSq(sub(start.co, end.co)) === 0) continue;

    if (
      view.occlude &&
      hiddenBehind(slices, normal, view, lerp(start.co, end.co, 0.5), [slice.face])
    ) {
      continue;
    }
    sections.push({ from: start, to: end, face: slice.face.id });
  }
  return sections;
}

/** Every point of the cut so far, each once: its clicks on the mesh and where its pieces end. */
export function knifeMarks(steps: readonly KnifeStep[]): KnifeMark[] {
  const marks = new Set<KnifeMark>();
  for (const step of steps) {
    if (step.mark) marks.add(step.mark);
    for (const section of step.sections) marks.add(section.from).add(section.to);
  }
  return [...marks];
}

/** Every piece of the cut so far. */
export function knifeSectionsOf(steps: readonly KnifeStep[]): KnifeSection[] {
  return steps.flatMap((step) => step.sections);
}

/**
 * The cut as the knife operator takes it: one run per piece.
 *
 * Runs of their own are enough, because the operator joins up pieces that share
 * a point and divides each face along every path they make across it.
 */
export function knifeCutRuns(steps: readonly KnifeStep[]): KnifePoint[][] {
  return knifeSectionsOf(steps).map((section) => [section.from.point, section.to.point]);
}

/** The vertices and points of the cut the pointer is within reach of. */
function nearPoints(
  mesh: BMesh,
  pointer: THREE.Vector2,
  view: KnifeView,
  marks: readonly KnifeMark[],
  screen: ReadonlyMap<number, THREE.Vector2 | null>,
): Candidate[] {
  const candidates: Candidate[] = [];
  const consider = (mark: KnifeMark, pixel: THREE.Vector2 | null | undefined) => {
    const distance = pixel ? pixel.distanceTo(pointer) : Infinity;
    if (distance <= VERT_SNAP_PX) candidates.push({ mark, distance, depth: 0 });
  };

  // The cut's own points first, so a vertex the cut already passes through is
  // taken as the point it already has rather than as a second one.
  for (const mark of marks) consider(mark, view.project(mark.co));
  for (const vert of mesh.verts.values()) {
    consider({ point: { kind: 'vert', vert: vert.id }, co: vert.co }, screen.get(vert.id));
  }
  return candidates;
}

/** The spots on edges and on pieces of the cut the pointer is within reach of, or their middles. */
function nearLines(
  mesh: BMesh,
  pointer: THREE.Vector2,
  view: KnifeView,
  options: KnifeTargetOptions,
  screen: ReadonlyMap<number, THREE.Vector2 | null>,
): Candidate[] {
  const candidates: Candidate[] = [];

  /** Where on a line drawn from `a` to `b` the pointer is nearest, if near enough. */
  const reach = (a: THREE.Vector2, b: THREE.Vector2, from: Vec3, to: Vec3) => {
    const span = b.clone().sub(a);
    const lengthSquared = span.lengthSq();
    const s =
      lengthSquared < 1e-9
        ? 0
        : THREE.MathUtils.clamp(pointer.clone().sub(a).dot(span) / lengthSquared, 0, 1);
    const distance = a.clone().addScaledVector(span, s).distanceTo(pointer);
    if (distance > EDGE_SNAP_PX) return null;

    // How far along it is found in the scene rather than on screen: perspective
    // squeezes the far half of a line, so the fraction of the way across the
    // screen is not the fraction of the way along the line.
    const t = options.midpoint
      ? 0.5
      : closestAlong(view.sight(a.clone().addScaledVector(span, s)), from, to);
    return { t, distance };
  };

  for (const edge of mesh.edges.values()) {
    const a = screen.get(edge.v0.id);
    const b = screen.get(edge.v1.id);
    const hit = a && b ? reach(a, b, edge.v0.co, edge.v1.co) : null;
    if (!hit) continue;
    candidates.push({
      mark: {
        point: { kind: 'edge', edge: edge.id, t: hit.t },
        co: lerp(edge.v0.co, edge.v1.co, hit.t),
      },
      distance: hit.distance,
      depth: 0,
    });
  }

  for (const section of options.sections) {
    const a = view.project(section.from.co);
    const b = view.project(section.to.co);
    const hit = a && b ? reach(a, b, section.from.co, section.to.co) : null;
    if (!hit) continue;
    const co = lerp(section.from.co, section.to.co, hit.t);
    candidates.push({
      mark: { point: { kind: 'face', face: section.face, co }, co },
      distance: hit.distance,
      depth: 0,
    });
  }
  return candidates;
}

/** How far along a line, 0 to 1, it passes closest to a line of sight. */
function closestAlong(sight: { origin: Vec3; direction: Vec3 }, from: Vec3, to: Vec3): number {
  const line = sub(to, from);
  const offset = sub(sight.origin, from);
  const a = dot(sight.direction, sight.direction);
  const b = dot(sight.direction, line);
  const c = dot(line, line);
  const d = dot(sight.direction, offset);
  const e = dot(line, offset);
  const denominator = a * c - b * b;
  // Seen end on: all of it is under the pointer at once.
  if (Math.abs(denominator) <= 1e-12 * a * c) return 0.5;
  return THREE.MathUtils.clamp((a * e - b * d) / denominator, 0, 1);
}

/** Whether a point is drawn within a pixel of a spot on the canvas. */
function near(view: KnifeView, co: Vec3, pixel: THREE.Vector2): boolean {
  const drawn = view.project(co);
  return drawn !== null && drawn.distanceTo(pixel) <= ON_LINE_PX;
}

/**
 * Whether the surface stands between the camera and a point of the cut, in a
 * view that hides what is behind it.
 *
 * Asked of a plane through the line of sight, since the faces that plane
 * slices are the only ones the line can meet. Any such plane answers, short of
 * one lying flat against a face, which is why it is tilted off the axes.
 */
function hidden(mesh: BMesh, view: KnifeView, mark: KnifeMark): boolean {
  if (!view.occlude) return false;
  const pixel = view.project(mark.co);
  if (!pixel) return true;

  const { direction } = view.sight(pixel);
  const tilt = lengthSq(cross(direction, SKEW)) > 1e-6 ? SKEW : vec3(1, 0, 0);
  const normal = normalize(cross(direction, tilt));

  const slices = sliceFaces(
    mesh,
    normal,
    (vert) => dot(sub(vert.co, mark.co), normal),
    (loop, t) => lerp(loop.vert.co, loop.next.vert.co, t),
  );
  return hiddenBehind(slices, normal, view, mark.co, knifePointFaces(mesh, mark.point));
}

/** One straight piece of a face's slice through a plane. */
interface Slice<T> {
  from: T;
  to: T;
  face: Face;
}

/**
 * Every face's slice through a plane, as the straight pieces it is made of:
 * one across a face that does not bend back on itself, more across one that
 * does.
 *
 * A corner exactly on the plane counts as lying on its positive side, which is
 * what keeps the crossings round every face's border in pairs without a
 * tolerance to tune: an edge running from the plane to the negative side is
 * crossed at its end, and one running from it to the positive side is not.
 * `t` is 0 or 1 exactly when the crossing is a corner.
 */
function sliceFaces<T extends Vec3 | KnifeMark>(
  mesh: BMesh,
  normal: Vec3,
  side: (vert: Vert) => number,
  point: (loop: Loop, t: number) => T,
): Slice<T>[] {
  const position = (crossing: T): Vec3 => ('co' in crossing ? crossing.co : crossing);
  const slices: Slice<T>[] = [];

  for (const face of mesh.faces.values()) {
    const crossings: T[] = [];
    for (const loop of mesh.faceLoops(face)) {
      const here = side(loop.vert);
      const there = side(loop.next.vert);
      if (here >= 0 === there >= 0) continue;
      crossings.push(point(loop, there === 0 ? 1 : here / (here - there)));
    }
    if (crossings.length < 2) continue;

    if (crossings.length > 2) {
      const across = cross(normal, face.normal);
      crossings.sort(
        (first, second) => dot(position(first), across) - dot(position(second), across),
      );
    }
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      slices.push({ from: crossings[i], to: crossings[i + 1], face });
    }
  }
  return slices;
}

/**
 * Whether any slice crosses the line of sight to a point before the line gets
 * there, leaving out the faces the point itself lies on.
 *
 * Worked flat, in the plane the slices lie in, with the point at the middle.
 */
function hiddenBehind<T extends Vec3 | KnifeMark>(
  slices: readonly Slice<T>[],
  normal: Vec3,
  view: KnifeView,
  co: Vec3,
  own: readonly Face[],
): boolean {
  const pixel = view.project(co);
  if (!pixel) return true;

  const { u, v } = basisFromNormal(normal);
  const flat = (point: T | Vec3) => {
    const offset = sub('co' in point ? point.co : point, co);
    return { x: dot(offset, u), y: dot(offset, v) };
  };
  const cross2 = (p: { x: number; y: number }, q: { x: number; y: number }) =>
    p.x * q.y - p.y * q.x;

  // From where the line of sight starts to the point, which sits at zero.
  const eye = flat(view.sight(pixel).origin);
  const reach = { x: -eye.x, y: -eye.y };
  const reachLength = Math.hypot(reach.x, reach.y);

  for (const slice of slices) {
    if (own.includes(slice.face)) continue;
    const p = flat(slice.from);
    const q = flat(slice.to);
    const span = { x: q.x - p.x, y: q.y - p.y };
    const denominator = cross2(reach, span);
    if (Math.abs(denominator) <= 1e-12 * reachLength * Math.hypot(span.x, span.y)) continue;

    const offset = { x: p.x - eye.x, y: p.y - eye.y };
    const alongSight = cross2(offset, span) / denominator;
    const alongSlice = cross2(offset, reach) / denominator;
    if (alongSlice < -GRAZE || alongSlice > 1 + GRAZE) continue;
    if (alongSight > 0 && alongSight < 1 - 1e-9) return true;
  }
  return false;
}
