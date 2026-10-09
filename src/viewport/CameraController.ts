import * as THREE from 'three';

import { MIN_OBJECT_SIZE } from '@kernel/index';
import type { CameraPose, NavigationPreset, ViewLostReason, WheelZoom } from '@store/types';

import {
  type TouchPoint,
  type TwoFingerFrame,
  TwistGate,
  gestureStep,
  twoFingerFrame,
} from './touchGestures';

/**
 * Hard clamp on how far the orbit can zoom out. Shared with the viewport so it
 * can decide when the scene has scrolled out of comfortable view.
 */
export const MAX_ORBIT_DISTANCE = 5000;

/**
 * How far out the orbit has to scroll before the scene counts as lost.
 *
 * Most of the way to the clamp: short of this there is still a plausible
 * reason to be out here, looking at a large scene whole.
 */
const VIEW_LOST_DISTANCE = MAX_ORBIT_DISTANCE * 0.45;

/**
 * Hard clamp on how far the orbit can zoom in.
 *
 * Matched to `MIN_OBJECT_SIZE` so that an object sitting on the size floor can
 * still be brought up to fill the view: at a 50 degree field of view an orbit
 * this close spans about twice the floor, which puts the smallest object the
 * editor allows across roughly half the height of the viewport.
 */
export const MIN_ORBIT_DISTANCE = MIN_OBJECT_SIZE;

/**
 * The share of the gap to the scene the orbit still has to be able to close
 * for the wheel to be worth turning.
 *
 * A tenth: below that, closing the orbit the whole way would bring the camera
 * less than a tenth nearer whatever it is looking at, which on screen is
 * nothing.
 */
const ZOOM_REACH = 0.1;

/**
 * Whether zooming in has stopped being able to help.
 *
 * The wheel moves the camera along its orbit, so the nearest the scene can be
 * brought is the pivot the orbit turns about: collapse the radius to nothing
 * and the camera arrives at the pivot and stops. That is fine while the pivot
 * sits on the model, which is where framing puts it, and it is the whole
 * problem once a pan has carried the pivot off into empty space. From there
 * every notch of the wheel shortens a radius that was never what stood between
 * the camera and the model, the steps shrink along with it, and the zoom grinds
 * to a halt with the model as far off and as small as it was. Blender is famous
 * for it.
 *
 * `gap` is how far the camera stands from the scene itself, and `radius` is all
 * the zoom has left to give. Once the second is a small fraction of the first
 * there is nothing left to gain by turning the wheel, and once the orbit is
 * down on its clamp there is nothing left to turn it with. The way back from
 * both is to put the pivot on the scene again, which is what Frame All does.
 */
export function zoomSpent(radius: number, gap: number): boolean {
  // The orbit is as tight as it is allowed to get, so the wheel has nothing
  // left to do at all: the next notch changes no number anywhere, which is
  // the stall a user actually runs into. It takes about eighty-five notches
  // from a framed object to get here, and the gap does not come into it: by
  // then the camera is usually inside the thing it was closing in on.
  if (radius <= MIN_ORBIT_DISTANCE) return true;

  // Short of that the wheel still moves the camera, and the question is
  // whether moving it is worth anything. No gap means the camera is in
  // amongst the geometry already, which is where a close-up works.
  if (!Number.isFinite(gap) || gap <= 0) return false;
  return radius < gap * ZOOM_REACH;
}

/**
 * How long a keyboard move of the camera takes, in milliseconds.
 *
 * Blender's smooth view, and the reason it is there: a view that snaps tells
 * you where the camera ended up, and a view that turns tells you how the model
 * you were looking at relates to the one you are looking at now. Going from
 * the right side to the left is the case that makes the point, since the two
 * pictures are mirror images and the turn between them is the only thing that
 * says which way round the model went.
 *
 * Short enough not to be a wait. Two tenths of a second is about the length of
 * a blink, which is long enough to read as motion and too short to sit through.
 */
export const VIEW_TWEEN_MS = 200;

/**
 * How far the wheel's zoom leans from the middle of the view toward the
 * pointer: 0 zooms dead centre, 1 holds the point under the pointer still.
 *
 * Under a third. Following the pointer the whole way swings the model off to
 * the side within a few notches, which reads as the view running away. This
 * keeps the zoom centred and lets the pointer steer it.
 */
export const WHEEL_POINTER_LEAN = 0.3;

/** Slow off the mark and slow into the stop, quick through the middle. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

/** The shorter way round to an angle, in -π to π. */
function shortestTurn(delta: number): number {
  return (((delta % TWO_PI) + TWO_PI + Math.PI) % TWO_PI) - Math.PI;
}

/** A camera move in flight, from where it started to where it is going. */
interface CameraMove {
  fromPhi: number;
  toPhi: number;
  fromTheta: number;
  toTheta: number;
  /**
   * When the move began, on the same clock `update` is given, or null until
   * the first frame picks it up.
   *
   * The turn starts on the frame that draws it rather than on the keypress:
   * whatever the keypress was waiting behind, a frame the browser never drew
   * is not a frame the user watched go by, and counting it against the turn
   * would eat the beginning of the only part of this anyone sees.
   */
  start: number | null;
}

/**
 * How far one press of the keyboard orbit turns the camera.
 *
 * Blender's fifteen degrees, which divides the turn into twenty-four and the
 * quarter turn into six, so a run of presses lands squarely on the straight-on
 * views rather than somewhere near them.
 */
export const ORBIT_STEP = Math.PI / 12;

/**
 * How near the pole the camera may stand.
 *
 * Straight up is where the polar angle stops meaning anything: the view
 * direction and the up vector line up, and `lookAt` has no way left to decide
 * which way round the picture goes. A locked orbit holds here; an unlocked one
 * steps across rather than landing on it.
 */
const POLE_EPSILON = 0.001;

const TWO_PI = Math.PI * 2;

/**
 * Where a vertical drag leaves the polar angle.
 *
 * Locked, it stops just short of straight up and straight down. Unlocked, it
 * wraps the whole way round: past the pole the angle keeps growing, which puts
 * the camera on the far side of the axis and carries on down the other side,
 * so a slow drag turns the model over rather than jamming against the top of
 * it. `upSign` is what keeps that crossing continuous on screen.
 */
export function orbitPhi(phi: number, delta: number, locked: boolean): number {
  const next = phi + delta;
  if (locked) return Math.max(POLE_EPSILON, Math.min(Math.PI - POLE_EPSILON, next));

  const wrapped = wrapAngle(next);
  // Landing exactly on a pole is the one place the maths gives out, so a drag
  // that would stop there is nudged the way it was already going.
  const toPole = Math.min(wrapped, Math.abs(wrapped - Math.PI), TWO_PI - wrapped);
  if (toPole >= POLE_EPSILON) return wrapped;
  return wrapAngle(wrapped + (delta < 0 ? -POLE_EPSILON : POLE_EPSILON));
}

/**
 * Where one step of the keyboard orbit leaves the polar angle.
 *
 * A drag that lands on a pole is carried across it, because the hand was still
 * moving and stopping dead would read as a snag. A step is a different
 * gesture: it was asked for once, and the pole is where it was aimed. Crossing
 * would leave the camera a thousandth of a radian past straight up, looking
 * down at a scene rolled half a turn from the one the Top view gives, which is
 * not what the key was asking for. So a step that lands on a pole stops just
 * short of it, on the side it came from, and the press after that crosses.
 */
export function orbitStepPhi(phi: number, delta: number, locked: boolean): number {
  const next = wrapAngle(phi + delta);
  const toPole = Math.min(next, Math.abs(next - Math.PI), TWO_PI - next);
  if (toPole >= POLE_EPSILON) return orbitPhi(phi, delta, locked);
  return wrapAngle(next - (delta < 0 ? -POLE_EPSILON : POLE_EPSILON));
}

/** An angle brought back into 0 to 2π, whichever way round it went. */
function wrapAngle(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * Which way up the camera is held at this polar angle.
 *
 * Between the poles the world's own up will do. Past one, the camera is
 * hanging under the axis looking back up at the scene, and world up would flip
 * the picture end for end in a single frame: turning the camera's own up over
 * instead is what makes rolling across the pole look like one continuous turn.
 */
export function upSign(phi: number): number {
  return Math.sin(phi) < 0 ? -1 : 1;
}

/**
 * Which way the turntable has to turn for the scene to follow a twisting hand.
 *
 * From above, a clockwise hand asks for the camera to go clockwise round the
 * vertical too. From underneath, the ground is seen from its other face and
 * the spin on screen reverses. Holding the camera upside down past a pole
 * changes nothing: that turns the picture half over, and a half turn keeps
 * clockwise clockwise. So the only question is which side of the ground the
 * camera is on.
 */
export function twistSign(phi: number): number {
  return Math.cos(phi) < 0 ? -1 : 1;
}

/** Where the camera stands round its pivot, as the two angles of the orbit. */
export interface ViewAngles {
  /** From straight up, 0 to π. */
  phi: number;
  /** Round the vertical, 0 looking from +Z. */
  theta: number;
}

/** The view a fresh tab opens on: above the ground, a quarter turn round from the front. */
export const OPENING_VIEW: ViewAngles = { phi: Math.PI / 3, theta: Math.PI / 4 };

/**
 * The angles of the six straight-on views, which Shift and a number pick.
 *
 * Top and bottom stop a hair short of the pole, where the orbit's maths gives
 * out. Exported for the snapshot renderer, so a picture of the front view is
 * taken from exactly where Shift+1 puts the camera.
 */
export function axisViewAngles(axis: 'x' | 'y' | 'z', negative: boolean): ViewAngles {
  if (axis === 'y') return { phi: negative ? Math.PI - POLE_EPSILON : POLE_EPSILON, theta: 0 };
  if (axis === 'x') return { phi: Math.PI / 2, theta: (negative ? -1 : 1) * (Math.PI / 2) };
  return { phi: Math.PI / 2, theta: negative ? Math.PI : 0 };
}

/**
 * Orbit / pan / zoom with configurable bindings.
 *
 * Written by hand rather than using OrbitControls because the two presets bind
 * different buttons and modifiers, and the viewport needs to know when a drag
 * was navigation so it does not also treat it as a selection click.
 */
export class CameraController {
  private readonly spherical = new THREE.Spherical(8, OPENING_VIEW.phi, OPENING_VIEW.theta);
  private readonly target = new THREE.Vector3();
  private readonly pointers = new Map<number, THREE.Vector2>();

  private action: 'orbit' | 'pan' | 'touch' | null = null;
  private move: CameraMove | null = null;
  /** The hand two fingers make, as it was at their last move, while they steer. */
  private touch: { frame: TwoFingerFrame; gate: TwistGate } | null = null;
  private lastPosition = new THREE.Vector2();
  private moved = false;

  orbitSpeed = 0.005;
  panSpeed = 0.0018;
  zoomSpeed = 0.0012;
  preset: NavigationPreset = 'blender';
  /** Whether a vertical orbit stops at the poles instead of rolling over them. */
  lockVerticalOrbit = false;
  /** Whether the wheel zooms into the middle of the view or leans toward the pointer. */
  wheelZoom: WheelZoom = 'pointer';
  /**
   * How long a keyboard move takes. Zero puts the camera there on the spot,
   * which is what a test wants and what a motion setting would turn off.
   */
  viewTweenMs = VIEW_TWEEN_MS;

  constructor(
    private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    private readonly element: HTMLElement,
  ) {
    this.apply();
  }

  setCamera(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): void {
    this.camera = camera;
    this.apply();
  }

  /** True while a navigation drag is in progress, so clicks are suppressed. */
  get isNavigating(): boolean {
    return this.action !== null;
  }

  /** True when the last drag actually moved, distinguishing it from a click. */
  get didMove(): boolean {
    return this.moved;
  }

  get distance(): number {
    return this.spherical.radius;
  }

  get focusPoint(): THREE.Vector3 {
    return this.target.clone();
  }

  /**
   * Where the camera is standing, in a form that survives being stored.
   *
   * Where it is heading, rather, while a move is in flight: walking out of the
   * module mid-turn should leave you at the view you asked for, not at the
   * frame the teardown happened to catch.
   */
  pose(): CameraPose {
    return {
      target: { x: this.target.x, y: this.target.y, z: this.target.z },
      radius: this.spherical.radius,
      phi: this.pendingPhi,
      theta: this.pendingTheta,
    };
  }

  setPose(pose: CameraPose): void {
    this.move = null;
    this.target.set(pose.target.x, pose.target.y, pose.target.z);
    this.spherical.radius = pose.radius;
    this.spherical.phi = pose.phi;
    this.spherical.theta = pose.theta;
    this.apply();
  }

  onPointerDown(event: PointerEvent): boolean {
    this.pointers.set(event.pointerId, new THREE.Vector2(event.clientX, event.clientY));
    const action = this.resolveAction(event);
    if (!action) return false;

    // The hand wins: a drag that starts mid-turn takes the camera from where
    // it has got to rather than fighting the move for it.
    this.move = null;
    this.action = action;
    this.moved = false;
    this.lastPosition.set(event.clientX, event.clientY);
    this.element.setPointerCapture(event.pointerId);
    return true;
  }

  onPointerMove(event: PointerEvent): boolean {
    if (!this.action) return false;
    // Two fingers are read whole by `moveTouch`, never one pointer at a time.
    if (this.action === 'touch') return true;

    const deltaX = event.clientX - this.lastPosition.x;
    const deltaY = event.clientY - this.lastPosition.y;
    if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) this.moved = true;
    this.lastPosition.set(event.clientX, event.clientY);

    if (this.action === 'orbit') {
      this.turn(deltaX, deltaY);
    } else {
      const scale = this.spherical.radius * this.panSpeed;
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      this.camera.matrix.extractBasis(right, up, new THREE.Vector3());
      this.target.addScaledVector(right, -deltaX * scale);
      this.target.addScaledVector(up, deltaY * scale);
    }

    this.apply();
    return true;
  }

  onPointerUp(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    if (this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }
    // A mouse let go while two fingers steer has nothing of theirs to end.
    if (this.action !== 'touch') this.action = null;
  }

  /**
   * Orbits by a drag of so many pixels, the way a middle-drag on the canvas
   * would. The corner widget drives this, so a hand with no middle button, a
   * finger above all, can still turn the camera over the top of the model.
   */
  orbitBy(deltaX: number, deltaY: number): void {
    this.move = null;
    this.turn(deltaX, deltaY);
    this.apply();
  }

  private turn(deltaX: number, deltaY: number): void {
    this.spherical.theta -= deltaX * this.orbitSpeed;
    this.spherical.phi = orbitPhi(
      this.spherical.phi,
      -deltaY * this.orbitSpeed,
      this.lockVerticalOrbit,
    );
  }

  /** True while two fingers are steering the camera. */
  get isTouching(): boolean {
    return this.action === 'touch';
  }

  /**
   * Hands the camera to two fingers.
   *
   * The hand wins over a keyboard turn in flight, the same as a mouse drag
   * does. From here `moveTouch` follows the fingers until `endTouch`.
   */
  beginTouch(a: TouchPoint, b: TouchPoint): void {
    this.move = null;
    this.action = 'touch';
    this.moved = false;
    this.touch = { frame: twoFingerFrame(a, b), gate: new TwistGate() };
  }

  /**
   * Follows two fingers to where they are now, in canvas pixels.
   *
   * All three at once, because a hand does all three at once:
   * - **Slide**: the scene travels with the middle of the hand, one pixel for
   *   one pixel at the depth of the orbit point, so what was under the fingers
   *   stays under them.
   * - **Pinch**: the orbit closes in or opens out by the spread's ratio, and
   *   the point between the fingers holds still while it does, the way a map
   *   zooms where it is pinched rather than at its middle.
   * - **Twist**: the camera turns round the vertical, so the scene turns with
   *   the hand like a turntable. Held back by `TwistGate` until the hand is
   *   plainly turning, so a pinch does not wobble the view round.
   */
  moveTouch(a: TouchPoint, b: TouchPoint): void {
    const touch = this.touch;
    if (!touch) return;

    const frame = twoFingerFrame(a, b);
    const step = gestureStep(touch.frame, frame);
    touch.frame = frame;

    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    this.camera.matrix.extractBasis(right, up, new THREE.Vector3());
    const perPixel = this.unitsPerPixel();

    this.target.addScaledVector(right, -step.panX * perPixel);
    this.target.addScaledVector(up, step.panY * perPixel);

    this.zoomAbout(step.zoom, frame.centre.x, frame.centre.y);

    this.spherical.theta += twistSign(this.spherical.phi) * touch.gate.pass(step.twist);

    if (Math.hypot(step.panX, step.panY) > 1 || Math.abs(1 - step.zoom) > 0.01) {
      this.moved = true;
    }
    this.apply();
  }

  /** Lets go of the camera once fewer than two fingers are left on it. */
  endTouch(): void {
    this.touch = null;
    if (this.action === 'touch') this.action = null;
  }

  /**
   * World units per canvas pixel at the depth of the orbit point.
   *
   * What makes a two-finger slide stick to the scene: the target moves by
   * exactly what the fingers moved over it. A canvas with no size yet (a test,
   * or a frame before layout) is read as one pixel tall rather than divided by.
   */
  private unitsPerPixel(): number {
    const height = Math.max(this.element.clientHeight, 1);
    if (this.camera instanceof THREE.OrthographicCamera) {
      return (this.camera.top - this.camera.bottom) / height;
    }
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    return (2 * this.spherical.radius * Math.tan(halfFov)) / height;
  }

  /**
   * Scales the orbit by `factor` while the point at canvas pixel `x`, `y`
   * holds still on screen.
   *
   * The point is read on the plane through the pivot, facing the camera. The
   * pivot slides toward it by the same share the radius shrinks by, which is
   * exactly what keeps it under the same pixel: the view closes on what the
   * pointer or the fingers are over rather than on its own middle.
   */
  private zoomAbout(factor: number, x: number, y: number): void {
    const radius = THREE.MathUtils.clamp(
      this.spherical.radius * factor,
      MIN_ORBIT_DISTANCE,
      MAX_ORBIT_DISTANCE,
    );
    const pull = 1 - radius / this.spherical.radius;
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    this.camera.matrix.extractBasis(right, up, new THREE.Vector3());
    const perPixel = this.unitsPerPixel();
    const offsetX = x - this.element.clientWidth / 2;
    const offsetY = y - this.element.clientHeight / 2;
    this.target.addScaledVector(right, offsetX * perPixel * pull);
    this.target.addScaledVector(up, -offsetY * perPixel * pull);
    this.spherical.radius = radius;
  }

  /**
   * Slides the pivot along the line of sight to the depth of `point`, with the
   * camera left exactly where it stands, so nothing on screen moves.
   *
   * Not for an orthographic camera: there the radius is how much of the scene
   * the view spans, so changing it would change the picture, and depth has no
   * say in which pixel a point lands on anyway.
   */
  private pivotAtDepthOf(point: THREE.Vector3): void {
    if (this.camera instanceof THREE.OrthographicCamera) return;
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const depth = THREE.MathUtils.clamp(
      forward.dot(point.clone().sub(this.camera.position)),
      MIN_ORBIT_DISTANCE,
      MAX_ORBIT_DISTANCE,
    );
    this.target.copy(this.camera.position).addScaledVector(forward, depth);
    this.spherical.radius = depth;
  }

  /**
   * Zooms in or out: into the middle of the view, or leaning toward the
   * pointer, as `wheelZoom` says.
   *
   * Leaning, the pixel held still sits `WHEEL_POINTER_LEAN` of the way from
   * the middle of the view to the pointer, so the view stays mostly centred
   * and drifts toward what the pointer is over rather than chasing it.
   *
   * `surface` is the point of the scene under the pointer, when it is over
   * anything. The pivot is moved to its depth first, so the zoom closes in at
   * that depth rather than on a plane through wherever the pivot was left.
   * Each notch then covers a share of the real distance: the camera slows as
   * it arrives instead of passing through a model nearer than the pivot, and
   * keeps coming on one behind it instead of stalling short.
   *
   * Over empty space there is no depth to read, and the pivot's plane serves.
   * Centred, neither the pointer nor the surface has any say.
   */
  onWheel(event: WheelEvent, surface: THREE.Vector3 | null = null): void {
    const middleX = this.element.clientWidth / 2;
    const middleY = this.element.clientHeight / 2;
    const factor = Math.exp(event.deltaY * this.zoomSpeed);
    if (this.wheelZoom === 'centred') {
      this.zoomAbout(factor, middleX, middleY);
      this.apply();
      return;
    }

    if (surface) this.pivotAtDepthOf(surface);
    const rect = this.element.getBoundingClientRect();
    this.zoomAbout(
      factor,
      middleX + (event.clientX - rect.left - middleX) * WHEEL_POINTER_LEAN,
      middleY + (event.clientY - rect.top - middleY) * WHEEL_POINTER_LEAN,
    );
    this.apply();
  }

  private resolveAction(event: PointerEvent): 'orbit' | 'pan' | null {
    if (this.preset === 'maya') {
      // Maya: Alt + LMB orbits, Alt + MMB pans.
      if (!event.altKey) return null;
      if (event.button === 0) return 'orbit';
      if (event.button === 1) return 'pan';
      return null;
    }

    // Blender: MMB orbits, Shift + MMB pans.
    if (event.button !== 1) return null;
    return event.shiftKey ? 'pan' : 'orbit';
  }

  frameBox(box: THREE.Box3): void {
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

    this.target.copy(center);
    const fov = this.camera instanceof THREE.PerspectiveCamera ? this.camera.fov : 50;
    this.spherical.radius = Math.max(
      MIN_ORBIT_DISTANCE,
      (radius * 2.4) / Math.tan(THREE.MathUtils.degToRad(fov) * 0.5),
    );
    this.apply();
  }

  /** Where the camera is heading: the end of a move, or where it stands. */
  private get pendingPhi(): number {
    return this.move?.toPhi ?? this.spherical.phi;
  }

  private get pendingTheta(): number {
    return this.move?.toTheta ?? this.spherical.theta;
  }

  /** True while the camera is turning under its own steam. */
  get isMoving(): boolean {
    return this.move !== null;
  }

  /**
   * Advances a move in flight, and says whether it moved anything.
   *
   * Driven off wall time rather than counted in frames so the turn takes the
   * same two tenths of a second on a machine dropping them as on one that is
   * not. The viewport calls this once a frame; a test passes its own clock.
   */
  update(now: number = performance.now()): boolean {
    const move = this.move;
    if (!move) return false;

    move.start ??= now;
    const t = Math.min(1, (now - move.start) / this.viewTweenMs);
    const at = ease(t);
    this.spherical.phi = move.fromPhi + (move.toPhi - move.fromPhi) * at;
    this.spherical.theta = move.fromTheta + (move.toTheta - move.fromTheta) * at;
    if (t >= 1) {
      // Landed: take the target exactly rather than whatever the last
      // multiply left, so a view is the view and not a hair off it.
      this.spherical.phi = move.toPhi;
      this.spherical.theta = move.toTheta;
      this.move = null;
    }

    this.apply();
    return true;
  }

  /**
   * Sends the camera to an orientation, turning rather than jumping.
   *
   * Both angles are given as a change rather than a destination, because every
   * caller has one: a step is a change by its nature, and a view works out its
   * own from wherever the camera is heading. Measuring from there rather than
   * from where it stands is what lets a held key stack up steps instead of
   * losing the ones that land mid-turn.
   */
  private moveBy(deltaPhi: number, deltaTheta: number): void {
    const toPhi = this.pendingPhi + deltaPhi;
    const toTheta = this.pendingTheta + deltaTheta;

    if (this.viewTweenMs <= 0) {
      this.move = null;
      this.spherical.phi = toPhi;
      this.spherical.theta = toTheta;
      this.apply();
      return;
    }

    this.move = {
      fromPhi: this.spherical.phi,
      fromTheta: this.spherical.theta,
      toPhi,
      toTheta,
      start: null,
    };
  }

  /**
   * One step of the keyboard orbit, from Blender's numpad 4, 6, 8 and 2.
   *
   * Named for where the camera goes rather than for which way the scene
   * appears to turn, the same way the views are: orbiting up from the front
   * view arrives at the top view, and orbiting left arrives at the left one.
   * The vertical pair goes through `orbitStepPhi`, which lands on the pole
   * a run of presses is aimed at and crosses it on the press after.
   */
  orbitStep(direction: 'left' | 'right' | 'up' | 'down'): void {
    if (direction === 'left') this.moveBy(0, -ORBIT_STEP);
    else if (direction === 'right') this.moveBy(0, ORBIT_STEP);
    else {
      const from = this.pendingPhi;
      const to = orbitStepPhi(
        from,
        direction === 'up' ? -ORBIT_STEP : ORBIT_STEP,
        this.lockVerticalOrbit,
      );
      this.moveBy(to - from, 0);
    }
  }

  /**
   * Blender's numpad 9: the same scene from the far side.
   *
   * The antipode of where the camera stands, which is half a turn round and
   * the polar angle reflected. Reflecting it leaves its sine alone, so the
   * picture stays the same way up and the jump reads as walking round the
   * model rather than as the view turning over.
   */
  orbitOpposite(): void {
    const from = this.pendingPhi;
    this.moveBy(wrapAngle(Math.PI - from) - from, Math.PI);
  }

  /**
   * The six straight-on views, bound to Shift and a number on either block.
   *
   * Blender's numpad views, opened up to the number row so a laptop can reach
   * them too. Each one drops the camera on one end of one axis looking back at
   * the pivot, and leaves the orbit radius and the pivot itself where they
   * were, so the jump changes which side you are on without changing how near
   * you are standing.
   */
  setAxisView(axis: 'x' | 'y' | 'z', negative: boolean): void {
    const { phi, theta } = axisViewAngles(axis, negative);

    // The shorter way round, measured from where the camera is heading: the
    // half turn from the right side to the left is the same either way, but
    // three quarters of a turn the wrong way round is not.
    this.moveBy(phi - this.pendingPhi, shortestTurn(theta - this.pendingTheta));
  }

  private apply(): void {
    const offset = new THREE.Vector3().setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(offset);
    // Set every time rather than only when a drag crosses a pole: a restored
    // pose and the axis views drop the camera anywhere, and the sign has to
    // match wherever it landed rather than wherever it was last dragged.
    this.camera.up.set(0, upSign(this.spherical.phi), 0);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();

    if (this.camera instanceof THREE.OrthographicCamera) {
      // An ortho camera has no perspective divide, so the orbit radius has to
      // drive the frustum height instead of the eye distance.
      const aspect =
        (this.camera.right - this.camera.left) / (this.camera.top - this.camera.bottom);
      const height = this.spherical.radius * 0.6;
      this.camera.top = height;
      this.camera.bottom = -height;
      this.camera.left = -height * aspect;
      this.camera.right = height * aspect;
      this.camera.updateProjectionMatrix();
    }
  }
}

/**
 * Whether the scene has got away from the camera, and which way.
 *
 * The two traps a navigating camera falls into, and Frame All is the way
 * out of both, which is why they are one answer rather than two. 'far' is
 * the orbit scrolled out past everything there is, read off the orbit alone.
 * 'stuck' is the zoom that has stopped biting, which needs `gap`: how far the
 * camera actually stands from the scene. See `zoomSpent`.
 *
 * Distance wins when both are true: from that far out the zoom being spent
 * is a symptom of the same thing, and coming back in is the first move.
 */
export function viewLostReason(distance: number, gap: number): ViewLostReason | null {
  if (distance > VIEW_LOST_DISTANCE) return 'far';
  return zoomSpent(distance, gap) ? 'stuck' : null;
}
