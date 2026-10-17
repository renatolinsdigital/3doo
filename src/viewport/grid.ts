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
 * Where the plane starts to give way, and where it has gone, in camera
 * distances out from the point the camera orbits.
 *
 * It has to run on towards the horizon: the camera mostly looks across the
 * plane rather than down on it. It used to be a hundred squares across, which
 * at the zoom the app opens at is ten units, and its far corner sat in plain
 * view with every line stopping dead at it. Nothing can be drawn without end,
 * so it fades out, and is drawn a little past where it has gone, so its end is
 * never a line of its own.
 */
const FADE_START = 2;
const FADE_END = 8;

/**
 * How far out the ground plane is drawn, in camera distances, for the far
 * plane to stay beyond.
 */
export const GRID_REACH = FADE_END + 1;

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
 * They are not part of the quantised grid: all they have to do is run on past
 * where they fade out with the plane, which fifty distances does with room to
 * spare. Going further is not free. A line thousands of view widths long is
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
 * The lines of the ground plane, worked out per pixel.
 *
 * `vGround` leaves the plane's own position out: the plane follows the camera
 * and can stand far from the origin, where float32 has too little left to say
 * where a line falls. It is always moved by whole heavy squares, so the lines
 * measured from it land where the world's own would.
 */
const GROUND_VERTEX = /* glsl */ `
  varying vec2 vGround;

  void main() {
    vGround = (modelMatrix * vec4(position, 0.0)).xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Lines closer together on screen than a few pixels stop reading as lines and
 * come out as moire, so each set is let go as it closes up: the fine ones first,
 * the heavy ones further off. Past that the whole plane fades with distance from
 * the point the camera orbits.
 */
const GROUND_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  uniform vec3 majorColor;
  uniform float majorOpacity;
  uniform float spacing;
  uniform float subdivisions;
  uniform vec2 focus;
  uniform vec2 fade;

  varying vec2 vGround;

  float lines(vec2 coord) {
    vec2 width = max(fwidth(coord), vec2(1e-6));
    vec2 gap = abs(fract(coord - 0.5) - 0.5) / width;
    vec2 cover = (1.0 - min(gap, 1.0)) * (1.0 - smoothstep(0.1, 0.35, width));
    return max(cover.x, cover.y);
  }

  void main() {
    vec2 cell = vGround / spacing;
    float major = lines(cell / subdivisions) * majorOpacity;
    float minor = lines(cell) * opacity * (1.0 - major);
    float alpha = major + minor;
    if (alpha <= 0.0) discard;

    float reach = 1.0 - smoothstep(fade.x, fade.y, distance(vGround, focus));
    gl_FragColor = vec4((majorColor * major + color * minor) / alpha, alpha * reach);
    #include <colorspace_fragment>
  }
`;

/** The centre lines, faded out where the plane is, so they never end in view either. */
const AXES_VERTEX = /* glsl */ `
  varying vec3 vColor;
  varying vec2 vGround;

  void main() {
    vColor = color;
    vGround = (modelMatrix * vec4(position, 1.0)).xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const AXES_FRAGMENT = /* glsl */ `
  uniform vec2 focus;
  uniform vec2 fade;

  varying vec3 vColor;
  varying vec2 vGround;

  void main() {
    gl_FragColor = vec4(vColor, 1.0 - smoothstep(fade.x, fade.y, distance(vGround, focus)));
    #include <colorspace_fragment>
  }
`;

/**
 * Adaptive ground grid.
 *
 * Two overlaid sets of lines (a fine one that fades with distance and a coarse
 * one for the major divisions) read better than a single grid at every zoom
 * level. Both are drawn by one plane that follows the camera, so there is
 * always ground under the view.
 */
export class ViewportGrid {
  readonly group = new THREE.Group();

  private readonly ground: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly axes: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Where the plane and the centre lines fade, one value shared by both. */
  private readonly fadeRange = { value: new THREE.Vector2() };

  private scale = DEFAULT_GRID.scale;
  private subdivisions = DEFAULT_GRID.subdivisions;
  /** The opacity asked for. What the fine lines are actually drawn at is this times the fade. */
  private opacity = DEFAULT_GRID.opacity;
  /** How much of the fine opacity the current zoom leaves standing. */
  private fade = 1;

  constructor(settings: GridSettings = DEFAULT_GRID) {
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        vertexShader: GROUND_VERTEX,
        fragmentShader: GROUND_FRAGMENT,
        uniforms: {
          color: { value: new THREE.Color() },
          opacity: { value: 1 },
          majorColor: { value: new THREE.Color() },
          majorOpacity: { value: 1 },
          spacing: { value: 1 },
          subdivisions: { value: 1 },
          focus: { value: new THREE.Vector2() },
          fade: this.fadeRange,
        },
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
      }),
    );

    this.axes = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        vertexShader: AXES_VERTEX,
        fragmentShader: AXES_FRAGMENT,
        uniforms: {
          focus: { value: new THREE.Vector2() },
          fade: this.fadeRange,
        },
        vertexColors: true,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.buildAxes();

    this.setGrid(settings);
    this.update(0, { x: 0, z: 0 });

    // Everything here is coplanar at y = 0, so depth cannot separate it and
    // draw order has to. The axes used to be the one opaque object on the
    // plane: they rendered first and wrote depth, leaving the grid to
    // depth-test against a value equal to its own to within float error. The
    // two axis lines did the same to each other where they converge on screen
    // at a grazing angle, which is what made the X axis flicker between red and
    // the Z axis's cyan as the camera orbited.
    //
    // With nothing on the plane writing depth, the group cannot fight itself:
    // every line passes or fails the test against the scene identically, and
    // the order below (fixed, not camera-dependent) is what decides. Negative
    // so the ground plane stays behind the selection overlays in `ObjectView`.
    this.ground.renderOrder = -2;
    this.axes.renderOrder = -1;

    this.group.add(this.ground, this.axes);
  }

  /** Applies the user's grid preferences. The size they mean is the next `update`'s to set. */
  setGrid(settings: GridSettings): void {
    const { uniforms } = this.ground.material;
    this.scale = settings.scale;
    this.subdivisions = settings.subdivisions;
    this.opacity = settings.opacity;

    uniforms.color.value.set(settings.color);
    uniforms.majorColor.value.set(settings.majorColor);
    uniforms.majorOpacity.value = settings.majorOpacity;
    uniforms.subdivisions.value = settings.subdivisions;
    this.applyOpacity();
  }

  /** The one writer of the fine lines' alpha, since two things set it. */
  private applyOpacity(): void {
    this.ground.material.uniforms.opacity.value = this.opacity * this.fade;
  }

  setVisibility(grid: boolean, axes: boolean): void {
    this.ground.visible = grid;
    this.axes.visible = axes;
  }

  /**
   * Resizes the grid, fades the fine lines, and brings the plane along under
   * `focus` (the point the camera orbits), so all of it stays useful as the
   * camera zooms and pans.
   */
  update(distance: number, focus: { x: number; z: number }): void {
    const eye = Math.max(distance, MIN_EYE_DISTANCE);
    const { step, fade } = gridLevel(distance);
    const spacing = step * this.scale;
    const major = spacing * this.subdivisions;
    const { uniforms } = this.ground.material;

    // Whole heavy squares, so the lines measured from it stay where they are
    // in the world. The plane is then up to half a square off centre, which is
    // what the extra square on its reach is for.
    const x = Math.round(focus.x / major) * major;
    const z = Math.round(focus.z / major) * major;
    const reach = eye * FADE_END + major;
    this.ground.position.set(x, 0, z);
    this.ground.scale.set(reach, 1, reach);

    uniforms.spacing.value = spacing;
    uniforms.focus.value.set(focus.x - x, focus.z - z);
    this.fadeRange.value.set(eye * FADE_START, eye * FADE_END);
    this.axes.material.uniforms.focus.value.set(focus.x, focus.z);
    this.axes.scale.setScalar(eye * AXIS_REACH);

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
