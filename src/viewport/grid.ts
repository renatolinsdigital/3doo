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
 * They close up ten to one across each decade: seven of them across the view
 * at the near end, seventy at the far, so a flat alpha reads as a plane that
 * keeps gaining weight and then snaps back at the step. Holding them at full
 * strength through the roomy half and easing them out over the crowded one
 * keeps the ink on screen roughly even.
 */
const FINE_FADE_START = 0.5;

/**
 * The closest the zoom is read as being, in world units.
 *
 * The orbit can come nearer than this, and everything the plane is sized from
 * would go to nothing with it: the step, and the reach of the centre lines.
 */
const MIN_EYE_DISTANCE = 0.001;

/**
 * How far out the centre lines reach, in camera distances.
 *
 * They are not part of the quantised grid: all they have to do is leave the
 * frustum from wherever the camera is standing, which fifty distances does from
 * any angle. Going further is not free. A line thousands of view widths long is
 * clipped down to a sliver of itself before it is drawn, and the float the clip
 * is worked out in has too little precision left to say where that sliver
 * lands: held at a fixed length, as these were, each axis drifted a few pixels
 * off the grid's own centre line underneath it as the camera closed in, and the
 * two read as one line drawn twice.
 */
const AXIS_REACH = 50;

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
  const eye = Math.max(distance, MIN_EYE_DISTANCE);
  const step = Math.max(Math.pow(10, Math.floor(Math.log10(eye)) - 1), 0.01);

  // Where the camera sits inside the decade this step covers: 0 where the fine
  // lines are widest apart, 1 where they have closed up and the step is due.
  const crowding = THREE.MathUtils.clamp(Math.log10(eye) - 1 - Math.log10(step), 0, 1);

  return { step, fade: 1 - THREE.MathUtils.smoothstep(crowding, FINE_FADE_START, 1) };
}

/**
 * The turn one whole grid step of snapping means, in radians.
 *
 * A turn is not a distance, so no grid square can set it. Fifteen degrees is
 * the modelling convention: it divides a quarter turn six ways and a whole one
 * by twenty-four, so 30, 45 and 90 all fall on it.
 */
export const SNAP_ROTATE_STEP = Math.PI / 12;

/** The ratio one whole grid step of snapping means for a scale, for the same reason. */
export const SNAP_SCALE_STEP = 0.1;

/** What each kind of transform lands on multiples of while snapping is on. */
export interface SnapAmounts {
  /** World units, for a move. */
  translate: number;
  /** Radians, for a turn. */
  rotate: number;
  /** Ratio, for a scale. */
  scale: number;
}

/**
 * What snapping quantises to, or null when it is off.
 *
 * The move is `step` grid scales, taken straight from the preference and not
 * from the plane on screen. The plane rescales itself by ten as the camera
 * pulls back, and a snap that followed it would silently change what it lands
 * on between one zoom and the next, which is no use for placing anything.
 */
export function snapAmounts(enabled: boolean, step: number, gridScale: number): SnapAmounts | null {
  if (!enabled || !(step > 0) || !(gridScale > 0)) return null;

  return {
    translate: gridScale * step,
    rotate: SNAP_ROTATE_STEP * step,
    scale: SNAP_SCALE_STEP * step,
  };
}

/** `value` rounded onto the nearest multiple of `step`. */
export function snapTo(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value;
}

/**
 * Adaptive ground grid.
 *
 * Two overlaid grids (a fine one that fades with distance and a coarse one for
 * the major divisions) read better than a single grid at every zoom level.
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
    this.buildAxes();

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
    // the order below (fixed, not camera-dependent) is what decides. Negative
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
    this.axes.scale.setScalar(Math.max(distance, MIN_EYE_DISTANCE) * AXIS_REACH);

    if (fade === this.fade) return;
    this.fade = fade;
    this.applyOpacity();
  }

  /**
   * The two world centre lines, as a unit cross for `update` to size.
   *
   * Built once: nothing in the preferences reaches them. How far they run is
   * the zoom's business and the colours are the app's own, the same two the
   * gizmo paints its X and Z handles with.
   */
  private buildAxes(): void {
    const positions = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 1]);
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
