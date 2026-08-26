import * as THREE from 'three';

import { VIEWPORT_COLORS } from '@bridge/index';

/**
 * Adaptive ground grid.
 *
 * Two overlaid grids — a fine one that fades with distance and a coarse one for
 * the major divisions — read better than a single grid at every zoom level.
 */
export class ViewportGrid {
  readonly group = new THREE.Group();

  private readonly fine: THREE.GridHelper;
  private readonly coarse: THREE.GridHelper;
  private readonly axes = new THREE.LineSegments();

  constructor() {
    this.fine = new THREE.GridHelper(100, 100, VIEWPORT_COLORS.grid, VIEWPORT_COLORS.grid);
    this.coarse = new THREE.GridHelper(100, 10, VIEWPORT_COLORS.rust, VIEWPORT_COLORS.rust);

    for (const grid of [this.fine, this.coarse]) {
      const material = grid.material as THREE.Material;
      material.transparent = true;
      material.depthWrite = false;
    }
    (this.fine.material as THREE.Material).opacity = 0.35;
    (this.coarse.material as THREE.Material).opacity = 0.65;

    const span = 50;
    const positions = new Float32Array([-span, 0, 0, span, 0, 0, 0, 0, -span, 0, 0, span]);
    const colors = new Float32Array([
      0.9, 0.2, 0.16, 0.9, 0.2, 0.16, 0.24, 0.88, 0.82, 0.24, 0.88, 0.82,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.axes.geometry = geometry;
    this.axes.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });

    // Everything here is coplanar at y = 0, so depth cannot separate it and
    // draw order has to. The axes used to be the one opaque object of the
    // three: they rendered first and wrote depth, leaving the grids to
    // depth-test against a value equal to their own to within float error. The
    // two axis lines did the same to each other where they converge on screen
    // at a grazing angle, which is what made the X axis flicker between red and
    // the Z axis's cyan as the camera orbited.
    //
    // With nothing on the plane writing depth, the group cannot fight itself:
    // every line passes or fails the test against the scene identically, and
    // the order below — fixed, not camera-dependent — is what decides. Negative
    // so the ground plane stays behind the selection overlays in `ObjectView`.
    this.fine.renderOrder = -3;
    this.coarse.renderOrder = -2;
    this.axes.renderOrder = -1;

    this.group.add(this.fine, this.coarse, this.axes);
  }

  setVisibility(grid: boolean, axes: boolean): void {
    this.fine.visible = grid;
    this.coarse.visible = grid;
    this.axes.visible = axes;
  }

  /** Rescales the grid so its divisions stay useful as the camera zooms. */
  update(distance: number): void {
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(distance, 0.001))) - 1);
    const scale = Math.max(magnitude, 0.01);
    this.fine.scale.setScalar(scale);
    this.coarse.scale.setScalar(scale);
    this.axes.scale.setScalar(Math.max(scale, 1));
  }

  dispose(): void {
    this.group.traverse((child) => {
      const holder = child as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material;
      };
      holder.geometry?.dispose();
      holder.material?.dispose();
    });
  }
}
