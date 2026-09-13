import * as THREE from 'three';

import { MIN_OBJECT_SIZE } from '@kernel/index';
import type { CameraPose, NavigationPreset, ViewLostReason } from '@store/types';

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
 * Orbit / pan / zoom with configurable bindings.
 *
 * Written by hand rather than using OrbitControls because the two presets bind
 * different buttons and modifiers, and the viewport needs to know when a drag
 * was navigation so it does not also treat it as a selection click.
 */
export class CameraController {
  private readonly spherical = new THREE.Spherical(8, Math.PI / 3, Math.PI / 4);
  private readonly target = new THREE.Vector3();
  private readonly pointers = new Map<number, THREE.Vector2>();

  private action: 'orbit' | 'pan' | null = null;
  private lastPosition = new THREE.Vector2();
  private moved = false;

  orbitSpeed = 0.005;
  panSpeed = 0.0018;
  zoomSpeed = 0.0012;
  preset: NavigationPreset = 'blender';
  /** Whether a vertical orbit stops at the poles instead of rolling over them. */
  lockVerticalOrbit = false;

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

  /** Where the camera is standing, in a form that survives being stored. */
  pose(): CameraPose {
    return {
      target: { x: this.target.x, y: this.target.y, z: this.target.z },
      radius: this.spherical.radius,
      phi: this.spherical.phi,
      theta: this.spherical.theta,
    };
  }

  setPose(pose: CameraPose): void {
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

    this.action = action;
    this.moved = false;
    this.lastPosition.set(event.clientX, event.clientY);
    this.element.setPointerCapture(event.pointerId);
    return true;
  }

  onPointerMove(event: PointerEvent): boolean {
    if (!this.action) return false;

    const deltaX = event.clientX - this.lastPosition.x;
    const deltaY = event.clientY - this.lastPosition.y;
    if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) this.moved = true;
    this.lastPosition.set(event.clientX, event.clientY);

    if (this.action === 'orbit') {
      this.spherical.theta -= deltaX * this.orbitSpeed;
      this.spherical.phi = orbitPhi(
        this.spherical.phi,
        -deltaY * this.orbitSpeed,
        this.lockVerticalOrbit,
      );
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
    this.action = null;
  }

  onWheel(event: WheelEvent): void {
    const factor = Math.exp(event.deltaY * this.zoomSpeed);
    this.spherical.radius = THREE.MathUtils.clamp(
      this.spherical.radius * factor,
      MIN_ORBIT_DISTANCE,
      MAX_ORBIT_DISTANCE,
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

  /** Numpad-style axis views. */
  setAxisView(axis: 'x' | 'y' | 'z', negative: boolean): void {
    const sign = negative ? -1 : 1;
    if (axis === 'y') {
      this.spherical.phi = negative ? Math.PI - 0.001 : 0.001;
      this.spherical.theta = 0;
    } else if (axis === 'x') {
      this.spherical.phi = Math.PI / 2;
      this.spherical.theta = sign * (Math.PI / 2);
    } else {
      this.spherical.phi = Math.PI / 2;
      this.spherical.theta = negative ? Math.PI : 0;
    }
    this.apply();
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
