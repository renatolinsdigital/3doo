import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { CameraController, MIN_ORBIT_DISTANCE, twistSign } from './CameraController';
import {
  TWIST_THRESHOLD,
  type TouchPoint,
  TwistGate,
  bearingDelta,
  gestureStep,
  twoFingerFrame,
} from './touchGestures';

const WIDTH = 800;
const HEIGHT = 600;

/** A controller on a canvas of a real size, looking at the origin from `phi`. */
function rig(phi = Math.PI / 3, orthographic = false) {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientWidth', { value: WIDTH });
  Object.defineProperty(element, 'clientHeight', { value: HEIGHT });
  const camera = orthographic
    ? new THREE.OrthographicCamera(-WIDTH / HEIGHT, WIDTH / HEIGHT, 1, -1, 0.05, 2000)
    : new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.05, 2000);
  const controls = new CameraController(camera, element);
  controls.setPose({ target: { x: 0, y: 0, z: 0 }, radius: 5, phi, theta: 0 });
  return { camera, controls };
}

/** Where a world point lands on the canvas, in pixels with y down. */
function onScreen(camera: THREE.Camera, point: THREE.Vector3): TouchPoint {
  camera.updateMatrixWorld();
  const ndc = point.clone().project(camera);
  return { x: ((ndc.x + 1) / 2) * WIDTH, y: ((1 - ndc.y) / 2) * HEIGHT };
}

/** Two fingers either side of `centre`, `spread` apart along `bearing`. */
function hand(centre: TouchPoint, spread: number, bearing: number): [TouchPoint, TouchPoint] {
  const dx = (Math.cos(bearing) * spread) / 2;
  const dy = (Math.sin(bearing) * spread) / 2;
  return [
    { x: centre.x - dx, y: centre.y - dy },
    { x: centre.x + dx, y: centre.y + dy },
  ];
}

/** Steers from one hand to another in small steps, the way a real move arrives. */
function steer(
  controls: CameraController,
  from: { centre: TouchPoint; spread: number; bearing: number },
  to: { centre: TouchPoint; spread: number; bearing: number },
  steps = 20,
) {
  controls.beginTouch(...hand(from.centre, from.spread, from.bearing));
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    controls.moveTouch(
      ...hand(
        {
          x: from.centre.x + (to.centre.x - from.centre.x) * t,
          y: from.centre.y + (to.centre.y - from.centre.y) * t,
        },
        from.spread + (to.spread - from.spread) * t,
        from.bearing + (to.bearing - from.bearing) * t,
      ),
    );
  }
  controls.endTouch();
}

/** The screen angle of a point about another, clockwise from +X with y down. */
function bearingAbout(origin: TouchPoint, point: TouchPoint): number {
  return Math.atan2(point.y - origin.y, point.x - origin.x);
}

describe('twoFingerFrame', () => {
  it('reads the middle, the spread and the bearing of two fingers', () => {
    const frame = twoFingerFrame({ x: 100, y: 100 }, { x: 200, y: 100 });
    expect(frame.centre).toEqual({ x: 150, y: 100 });
    expect(frame.spread).toBe(100);
    expect(frame.bearing).toBe(0);
  });

  it('never reports two fingers on one pixel as no spread at all', () => {
    expect(twoFingerFrame({ x: 5, y: 5 }, { x: 5, y: 5 }).spread).toBeGreaterThan(0);
  });
});

describe('gestureStep', () => {
  it('zooms in as the fingers spread and pans with their middle', () => {
    const from = twoFingerFrame({ x: 0, y: 0 }, { x: 100, y: 0 });
    const to = twoFingerFrame({ x: 10, y: 20 }, { x: 210, y: 20 });
    const step = gestureStep(from, to);
    expect(step.zoom).toBeCloseTo(0.5);
    expect(step.panX).toBeCloseTo(60);
    expect(step.panY).toBeCloseTo(20);
    expect(step.twist).toBeCloseTo(0);
  });

  it('takes the short way round when the bearing crosses the half turn', () => {
    expect(bearingDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
    expect(bearingDelta(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(-0.2);
  });
});

describe('TwistGate', () => {
  it('holds a small wobble back and lets a real turn through, without a jump', () => {
    const gate = new TwistGate();
    const small = TWIST_THRESHOLD / 4;
    expect(gate.pass(small)).toBe(0);
    expect(gate.pass(-small)).toBe(0);
    expect(gate.pass(small)).toBe(0);
    // Over the line: the step that crossed it is not paid out in one go.
    expect(gate.pass(TWIST_THRESHOLD)).toBe(0);
    expect(gate.pass(0.05)).toBe(0.05);
  });
});

describe('steering the camera with two fingers', () => {
  it('zooms in on a pinch outward and out on a pinch inward', () => {
    const { controls } = rig();
    const centre = { x: WIDTH / 2, y: HEIGHT / 2 };
    steer(controls, { centre, spread: 100, bearing: 0 }, { centre, spread: 200, bearing: 0 });
    expect(controls.distance).toBeCloseTo(2.5);

    steer(controls, { centre, spread: 200, bearing: 0 }, { centre, spread: 50, bearing: 0 });
    expect(controls.distance).toBeCloseTo(10);
  });

  it('keeps the zoom inside the orbit clamps', () => {
    const { controls } = rig();
    const centre = { x: WIDTH / 2, y: HEIGHT / 2 };
    steer(controls, { centre, spread: 10, bearing: 0 }, { centre, spread: 5000, bearing: 0 });
    expect(controls.distance).toBeGreaterThanOrEqual(MIN_ORBIT_DISTANCE);
  });

  it.each([false, true])(
    'slides the scene with the hand, so the point under it stays under it (ortho %s)',
    (orthographic) => {
      const { camera, controls } = rig(Math.PI / 3, orthographic);
      const start = onScreen(camera, new THREE.Vector3(0, 0, 0));
      steer(
        controls,
        { centre: start, spread: 120, bearing: 0 },
        { centre: { x: start.x + 90, y: start.y - 40 }, spread: 120, bearing: 0 },
      );
      const after = onScreen(camera, new THREE.Vector3(0, 0, 0));
      expect(after.x).toBeCloseTo(start.x + 90, 0);
      expect(after.y).toBeCloseTo(start.y - 40, 0);
    },
  );

  it('zooms about the point between the fingers rather than the middle of the view', () => {
    const { camera, controls } = rig();
    // A point on the plane the orbit point sits on, off to one side of it.
    const anchor = new THREE.Vector3();
    const right = new THREE.Vector3();
    camera.matrix.extractBasis(right, new THREE.Vector3(), new THREE.Vector3());
    anchor.addScaledVector(right, 1.2);

    const centre = onScreen(camera, anchor);
    steer(controls, { centre, spread: 100, bearing: 0 }, { centre, spread: 180, bearing: 0 });
    const after = onScreen(camera, anchor);
    expect(after.x).toBeCloseTo(centre.x, 0);
    expect(after.y).toBeCloseTo(centre.y, 0);
  });

  it.each([
    ['from above', Math.PI / 3],
    ['from below', (2 * Math.PI) / 3],
    ['upside down past the pole', 2 * Math.PI - Math.PI / 3],
  ])('turns the scene the way the hand twists, %s', (_, phi) => {
    const { camera, controls } = rig(phi);
    const middle = onScreen(camera, new THREE.Vector3(0, 0, 0));
    const marker = new THREE.Vector3(1, 0, 0.5);
    const before = bearingAbout(middle, onScreen(camera, marker));

    // A quarter turn clockwise on screen, well past the gate.
    steer(
      controls,
      { centre: middle, spread: 150, bearing: 0 },
      { centre: middle, spread: 150, bearing: Math.PI / 2 },
    );
    const after = bearingAbout(middle, onScreen(camera, marker));
    expect(bearingDelta(before, after)).toBeGreaterThan(0);
  });

  it('counts as navigating while the fingers are down, and lets go after', () => {
    const { controls } = rig();
    controls.beginTouch({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(controls.isNavigating).toBe(true);
    expect(controls.isTouching).toBe(true);
    controls.endTouch();
    expect(controls.isNavigating).toBe(false);
  });
});

describe('twistSign', () => {
  it('reverses under the ground, and not for a camera held upside down above it', () => {
    expect(twistSign(Math.PI / 4)).toBe(1);
    expect(twistSign((3 * Math.PI) / 4)).toBe(-1);
    expect(twistSign(2 * Math.PI - Math.PI / 4)).toBe(1);
  });
});

describe('orbitBy', () => {
  it('turns the camera the way a middle-drag of the same length would', () => {
    const { controls } = rig(Math.PI / 2);
    const before = controls.pose();
    controls.orbitBy(100, 0);
    const after = controls.pose();
    expect(after.theta).toBeCloseTo(before.theta - 100 * controls.orbitSpeed);
    expect(after.phi).toBeCloseTo(before.phi);
  });
});
