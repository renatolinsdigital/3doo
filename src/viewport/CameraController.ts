import * as THREE from 'three';

import type { NavigationPreset } from '@store/types';

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
      this.spherical.phi -= deltaY * this.orbitSpeed;
      // Clamping short of the poles avoids the gimbal flip at straight up/down.
      this.spherical.phi = Math.max(0.001, Math.min(Math.PI - 0.001, this.spherical.phi));
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
    this.spherical.radius = THREE.MathUtils.clamp(this.spherical.radius * factor, 0.05, 5000);
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
      0.5,
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

  resetRoll(): void {
    this.camera.up.set(0, 1, 0);
    this.apply();
  }

  private apply(): void {
    const offset = new THREE.Vector3().setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();

    if (this.camera instanceof THREE.OrthographicCamera) {
      // An ortho camera has no perspective divide, so the orbit radius has to
      // drive the frustum height instead of the eye distance.
      const aspect = (this.camera.right - this.camera.left) / (this.camera.top - this.camera.bottom);
      const height = this.spherical.radius * 0.6;
      this.camera.top = height;
      this.camera.bottom = -height;
      this.camera.left = -height * aspect;
      this.camera.right = height * aspect;
      this.camera.updateProjectionMatrix();
    }
  }
}
