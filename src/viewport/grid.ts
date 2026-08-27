import * as THREE from 'three';

import { AXIS_COLORS } from '@bridge/index';
import { DEFAULT_PREFERENCES } from '@store/index';

/** What the ground plane is drawn from, out of the user's preferences. */
export interface GridSettings {
  /** Multiplier on the step `update` picks for the zoom, not a length. */
  scale: number;
  /** How many divisions between two heavy lines. */
  subdivisions: number;
  color: string;
  opacity: number;
  majorColor: string;
  majorOpacity: number;
}

const DEFAULT_GRID: GridSettings = {
  scale: DEFAULT_PREFERENCES.gridScale,
  subdivisions: DEFAULT_PREFERENCES.gridSubdivisions,
  color: DEFAULT_PREFERENCES.gridColor,
  opacity: DEFAULT_PREFERENCES.gridOpacity,
  majorColor: DEFAULT_PREFERENCES.gridMajorColor,
  majorOpacity: DEFAULT_PREFERENCES.gridMajorOpacity,
};

/**
 * Roughly how many fine cells the plane is drawn with, whatever the scale.
 *
 * The extent follows from it rather than the other way round: a grid is read as
 * so many squares around the origin, and pinning the count keeps the same
 * amount of it on screen when the scale changes.
 */
const GRID_CELLS = 100;

/**
 * How far into a decade the fine lines start giving way, as a fraction of it.
 *
 * They close up ten to one across each decade — seven of them across the view
 * at the near end, seventy at the far — so a flat alpha reads as a plane that
 * keeps gaining weight and then snaps back at the step. Holding them at full
 * strength through the roomy half and easing them out over the crowded one
 * keeps the ink on screen roughly even.
 */
const FINE_FADE_START = 0.5;

/**
 * The size the grid is drawn at for a camera distance, and how much of the fine
 * lines' opacity is left at it.
 *
 * The step is quantised to powers of ten so the lines stay put as the camera
 * moves; the fade is what stops that quantising from being a pop. By the time
 * one takes effect the lines it replaces have already gone, and the ones left
 * standing are the heavy ones, which are in the same places either side of it.
 */
export function gridLevel(distance: number): { step: number; fade: number } {
  const eye = Math.max(distance, 0.001);
  const step = Math.max(Math.pow(10, Math.floor(Math.log10(eye)) - 1), 0.01);

  // Where the camera sits inside the decade this step covers: 0 where the fine
  // lines are widest apart, 1 where they have closed up and the step is due.
  const crowding = THREE.MathUtils.clamp(Math.log10(eye) - 1 - Math.log10(step), 0, 1);

  return { step, fade: 1 - THREE.MathUtils.smoothstep(crowding, FINE_FADE_START, 1) };
}

/**
 * Adaptive ground grid.
 *
 * Two overlaid grids — a fine one that fades with distance and a coarse one for
 * the major divisions — read better than a single grid at every zoom level.
 */
export class ViewportGrid {
  readonly group = new THREE.Group();

  private readonly fine = new THREE.LineSegments();
  private readonly coarse = new THREE.LineSegments();
  private readonly axes = new THREE.LineSegments();

  /** What the line geometry was last built from; colour is baked into it too. */
  private shape = '';

  /** The opacities asked for. What the fine lines are actually drawn at is these times the fade. */
  private opacity = DEFAULT_GRID.opacity;
  private majorOpacity = DEFAULT_GRID.majorOpacity;
  /** How much of the fine opacity the current zoom leaves standing. */
  private fade = 1;

  constructor(settings: GridSettings = DEFAULT_GRID) {
    this.axes.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });

    this.setGrid(settings);

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

  /**
   * Applies the user's grid preferences.
   *
   * Line positions *and* colours are baked into a `GridHelper`'s geometry, so
   * either one changing means rebuilding it; opacity is plain material state
   * and is written every time. The two objects are reused rather than replaced,
   * which is what carries their visibility, scale and draw order across.
   */
  setGrid(settings: GridSettings): void {
    const majors = Math.max(1, Math.round(GRID_CELLS / settings.subdivisions));
    const cells = majors * settings.subdivisions;
    const extent = cells * settings.scale;

    const shape = [extent, cells, majors, settings.color, settings.majorColor].join('|');
    if (shape !== this.shape) {
      this.shape = shape;
      reshape(this.fine, extent, cells, settings.color);
      reshape(this.coarse, extent, majors, settings.majorColor);
      this.buildAxes(extent / 2);
    }

    this.opacity = settings.opacity;
    this.majorOpacity = settings.majorOpacity;
    this.applyOpacity();
  }

  /** The one writer of both materials' alpha, since two things set it. */
  private applyOpacity(): void {
    (this.fine.material as THREE.Material).opacity = this.opacity * this.fade;
    (this.coarse.material as THREE.Material).opacity = this.majorOpacity;
  }

  setVisibility(grid: boolean, axes: boolean): void {
    this.fine.visible = grid;
    this.coarse.visible = grid;
    this.axes.visible = axes;
  }

  /** Resizes the grid, and fades the fine lines, so both stay useful as the camera zooms. */
  update(distance: number): void {
    const { step, fade } = gridLevel(distance);

    this.fine.scale.setScalar(step);
    this.coarse.scale.setScalar(step);
    this.axes.scale.setScalar(Math.max(step, 1));

    if (fade === this.fade) return;
    this.fade = fade;
    this.applyOpacity();
  }

  /** The two world centre lines, spanning the grid they sit under. */
  private buildAxes(span: number): void {
    const positions = new Float32Array([-span, 0, 0, span, 0, 0, 0, 0, -span, 0, 0, span]);
    // Run through THREE.Color rather than written out as raw channels: with
    // colour management on, that is the same sRGB-to-working conversion the
    // gizmo's materials get from `setHex`. Hand-written values would land in a
    // different space and the two would not match on screen.
    const x = new THREE.Color(AXIS_COLORS.x);
    const z = new THREE.Color(AXIS_COLORS.z);
    const colors = new Float32Array([x.r, x.g, x.b, x.r, x.g, x.b, z.r, z.g, z.b, z.r, z.g, z.b]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.axes.geometry.dispose();
    this.axes.geometry = geometry;
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

/** Re-lays one set of grid lines at a new size, count or colour. */
function reshape(
  target: THREE.LineSegments,
  extent: number,
  divisions: number,
  color: string,
): void {
  const built = new THREE.GridHelper(extent, divisions, color, color);

  target.geometry.dispose();
  (target.material as THREE.Material).dispose();
  target.geometry = built.geometry;
  target.material = built.material;

  const material = target.material as THREE.Material;
  material.transparent = true;
  material.depthWrite = false;
}
