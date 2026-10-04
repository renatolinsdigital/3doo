/**
 * The arithmetic of two fingers on the viewport, kept apart from the camera so
 * it can be read, and tested, without one.
 *
 * Two fingers are read as one hand: where their middle is, how far apart they
 * are, and which way the line between them points. Each move of either finger
 * compares the hand with where it last was, and the camera takes the
 * difference: the spread zooms, the middle pans, the bearing turns.
 */

/** A finger on the canvas, in canvas pixels with y growing downward. */
export interface TouchPoint {
  x: number;
  y: number;
}

/** Two fingers read as one hand. */
export interface TwoFingerFrame {
  centre: TouchPoint;
  /** How far apart the fingers are, in pixels. Never zero. */
  spread: number;
  /** The line from the first finger to the second, clockwise from +X on screen. */
  bearing: number;
}

/** What one move of the hand asks of the camera. */
export interface GestureStep {
  /** What to multiply the orbit radius by: below 1 when the fingers spread, which zooms in. */
  zoom: number;
  /** How far the middle of the hand travelled, in pixels. */
  panX: number;
  panY: number;
  /** How far the hand turned, clockwise on screen, in radians. */
  twist: number;
}

/**
 * How far the hand has to turn before the twist counts, in radians.
 *
 * About ten degrees. A pinch or a pan never keeps the line between the fingers
 * perfectly still, and a view that wobbled round on every zoom would be worse
 * than one that cannot turn at all. Past this the hand is plainly turning, and
 * from then on every degree of it counts.
 */
export const TWIST_THRESHOLD = (10 * Math.PI) / 180;

/**
 * The closest two fingers are taken to be.
 *
 * Two touches reported on the same pixel would make a spread of zero and a
 * zoom by infinity. A real hand cannot get its fingertips closer than this.
 */
const MIN_SPREAD = 1;

const TWO_PI = Math.PI * 2;

/** The hand two fingers make. */
export function twoFingerFrame(a: TouchPoint, b: TouchPoint): TwoFingerFrame {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return {
    centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    spread: Math.max(MIN_SPREAD, Math.hypot(dx, dy)),
    bearing: Math.atan2(dy, dx),
  };
}

/** The shorter way round from one bearing to another, in -π to π. */
export function bearingDelta(from: number, to: number): number {
  return ((((to - from) % TWO_PI) + TWO_PI + Math.PI) % TWO_PI) - Math.PI;
}

/** What the camera should do to follow the hand from one frame to the next. */
export function gestureStep(from: TwoFingerFrame, to: TwoFingerFrame): GestureStep {
  return {
    zoom: from.spread / to.spread,
    panX: to.centre.x - from.centre.x,
    panY: to.centre.y - from.centre.y,
    twist: bearingDelta(from.bearing, to.bearing),
  };
}

/**
 * Holds the twist back until the hand has plainly turned.
 *
 * Fed every step's twist, it answers how much of it to apply: none while the
 * running total stays inside `TWIST_THRESHOLD`, and all of it once the total
 * has crossed it. The turn that crossed the line is not paid out in one go,
 * which would make the view jump by ten degrees the moment it unlocked.
 */
export class TwistGate {
  private total = 0;
  private open = false;

  pass(twist: number): number {
    if (this.open) return twist;
    this.total += twist;
    if (Math.abs(this.total) < TWIST_THRESHOLD) return 0;
    this.open = true;
    return 0;
  }
}
