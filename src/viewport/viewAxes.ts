import { type Axis, type Vec3, AXES, dot, vec3 } from '@kernel/index';

/**
 * The camera's own frame, in world space: the columns of its world matrix.
 *
 * `toward` is the third column, which points out of the screen at the viewer
 * rather than into the scene, since that is the sign a depth reads best in: an
 * axis pointing at you is at +1.
 */
export interface CameraBasis {
  right: Vec3;
  up: Vec3;
  toward: Vec3;
}

/**
 * What the corner widget is drawing, published once a frame by the viewport.
 *
 * `axes` names what a transform in progress is acting on: one axis for a
 * pinned move, two for a plane handle or for an excluded axis, and null when
 * nothing is running or nothing is pinned. The widget lights those and dims the
 * rest, so the corner says what the next drag will actually move.
 */
export interface ViewAxesFrame {
  basis: CameraBasis;
  axes: readonly Axis[] | null;
}

/** One end of one axis: where it lands in the widget and how near it is. */
export interface AxisMark {
  axis: Axis;
  negative: boolean;
  /** Screen position in a -1 to 1 square, y growing downward as SVG does. */
  x: number;
  y: number;
  /** 1 pointing straight at the viewer, -1 straight away from them. */
  depth: number;
}

/** Looking down -Z with +Y up: three's own default, and what a fresh widget draws. */
export const DEFAULT_BASIS: CameraBasis = {
  right: vec3(1, 0, 0),
  up: vec3(0, 1, 0),
  toward: vec3(0, 0, 1),
};

const DEFAULT_FRAME: ViewAxesFrame = { basis: DEFAULT_BASIS, axes: null };

/**
 * Where each end of each world axis falls in the widget, back to front.
 *
 * The projection is the camera's own frame rather than its projection matrix:
 * the widget is a picture of which way the world is turned, not of where
 * anything is, so it wants the orientation with the perspective divide and the
 * position left out of it.
 *
 * Sorted by depth so that painting the list in order puts the near ends over
 * the far ones, which is the whole of the 3D read: SVG has no z-index.
 */
export function projectViewAxes(basis: CameraBasis): AxisMark[] {
  const marks: AxisMark[] = [];

  for (const axis of AXES) {
    for (const negative of [false, true]) {
      const sign = negative ? -1 : 1;
      const direction = vec3(
        axis === 'x' ? sign : 0,
        axis === 'y' ? sign : 0,
        axis === 'z' ? sign : 0,
      );
      marks.push({
        axis,
        negative,
        x: dot(direction, basis.right),
        // SVG counts y downward and the camera counts it up, so one of the two
        // has to be turned over. Here, once, rather than at every call site.
        y: -dot(direction, basis.up),
        depth: dot(direction, basis.toward),
      });
    }
  }

  return marks.sort((a, b) => a.depth - b.depth);
}

/**
 * The axes a transform is acting on, from the pin it was given.
 *
 * An excluded axis names the two it leaves free, which is what the widget has
 * to light: excluding X leaves the transform running in the Y/Z plane, and
 * lighting X there would say the opposite of what is happening.
 */
export function pinnedAxes(axis: Axis | null, excludeAxis: boolean): readonly Axis[] | null {
  if (!axis) return null;
  return excludeAxis ? AXES.filter((candidate) => candidate !== axis) : [axis];
}

let current: ViewAxesFrame = DEFAULT_FRAME;
const listeners = new Set<(frame: ViewAxesFrame) => void>();

/**
 * Hands the widget the frame it draws.
 *
 * A channel of its own rather than the editor store: this changes on every
 * orbit tick, and the store is where React state lives. Nothing that re-renders
 * belongs on the per-frame path, which is the same reason the viewport reads
 * the store rather than taking props.
 */
export function publishViewAxes(frame: ViewAxesFrame): void {
  current = frame;
  for (const listener of listeners) listener(frame);
}

/** Subscribes to the frame, called once straight away with the current one. */
export function subscribeViewAxes(listener: (frame: ViewAxesFrame) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

/** Drops back to the default view, so a torn-down viewport leaves nothing stale behind. */
export function resetViewAxes(): void {
  publishViewAxes(DEFAULT_FRAME);
}

const orbitListeners = new Set<(deltaX: number, deltaY: number) => void>();

/**
 * Turns the camera by a drag across the corner widget, in pixels.
 *
 * The other way along the same channel: the widget is React and the camera is
 * the viewport's, and a drag sends a move per pointer event, which is no
 * traffic to put through the store either.
 */
export function orbitFromViewAxes(deltaX: number, deltaY: number): void {
  for (const listener of orbitListeners) listener(deltaX, deltaY);
}

/** Listens for drags across the widget. The viewport is the one listener. */
export function subscribeViewAxesOrbit(
  listener: (deltaX: number, deltaY: number) => void,
): () => void {
  orbitListeners.add(listener);
  return () => {
    orbitListeners.delete(listener);
  };
}
