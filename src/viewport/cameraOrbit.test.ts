import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { MIN_OBJECT_SIZE } from '@kernel/index';

import {
  CameraController,
  MAX_ORBIT_DISTANCE,
  MIN_ORBIT_DISTANCE,
  ORBIT_STEP,
  VIEW_TWEEN_MS,
  orbitPhi,
  orbitStepPhi,
  upSign,
  viewLostReason,
  zoomSpent,
} from './CameraController';

const TWO_PI = Math.PI * 2;

/** A controller on a camera of its own, standing at the pose given. */
function controllerAt(phi: number) {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
  const controls = new CameraController(camera, document.createElement('div'));
  controls.setPose({ target: { x: 0, y: 0, z: 0 }, radius: 5, phi, theta: 0 });
  return { camera, controls };
}

describe('orbitPhi', () => {
  it('holds short of the poles when the orbit is locked', () => {
    // Dragging up past straight down, and down past straight up.
    expect(orbitPhi(0.5, -2, true)).toBeCloseTo(0.001);
    expect(orbitPhi(3, 2, true)).toBeCloseTo(Math.PI - 0.001);
  });

  it('carries on round the other side when it is not', () => {
    // A drag that would have stopped at the top now crosses it and comes down
    // the far side, which is what turning the model over looks like.
    expect(orbitPhi(0.5, -1, false)).toBeCloseTo(TWO_PI - 0.5);
    expect(orbitPhi(3, 1, false)).toBeCloseTo(4);
  });

  it('steps across a pole rather than landing on one', () => {
    // Straight up is where lookAt gives out, so a drag that lands exactly there
    // is carried the last thousandth in the direction it was already going.
    expect(orbitPhi(0.5, -0.5, false)).toBeCloseTo(TWO_PI - 0.001);
    expect(orbitPhi(Math.PI - 0.5, 0.5, false)).toBeCloseTo(Math.PI + 0.001);
  });

  it('stays inside one turn however far the drag runs', () => {
    for (const delta of [10, -10, 100]) {
      const phi = orbitPhi(1, delta, false);
      expect(phi).toBeGreaterThanOrEqual(0);
      expect(phi).toBeLessThan(TWO_PI);
    }
  });
});

describe('upSign', () => {
  it('holds world up between the poles and turns over past them', () => {
    expect(upSign(Math.PI / 2)).toBe(1);
    expect(upSign(0.001)).toBe(1);
    expect(upSign(Math.PI + 0.001)).toBe(-1);
    expect(upSign(TWO_PI - 0.5)).toBe(-1);
  });
});

describe('orbiting past the pole', () => {
  it('leaves the camera the right way up on the near side', () => {
    const { camera } = controllerAt(Math.PI / 3);

    expect(camera.up.y).toBe(1);
    expect(camera.position.y).toBeGreaterThan(0);
  });

  it('turns the camera over on the far side, where the view is upside down', () => {
    // Three quarters of a turn: over the top and down the back, which is the
    // back view held upside down rather than a jump to somewhere else.
    const { camera } = controllerAt(Math.PI * 1.5);

    expect(camera.up.y).toBe(-1);
    expect(camera.position.z).toBeCloseTo(-5);
    expect(camera.position.y).toBeCloseTo(0);
  });

  it('takes the sign from the pose it was handed, not from the drag that made it', () => {
    // A viewport rebuilt on the far side has never orbited at all, so the sign
    // has to come out of the pose itself.
    const { camera, controls } = controllerAt(Math.PI / 3);
    expect(camera.up.y).toBe(1);

    controls.setPose({ target: { x: 0, y: 0, z: 0 }, radius: 5, phi: 4, theta: 0 });

    expect(camera.up.y).toBe(-1);
  });
});

describe('the stepped orbit', () => {
  /** A pose off every axis, so a step in any direction has somewhere to go. */
  function stepped() {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
    const controls = new CameraController(camera, document.createElement('div'));
    controls.viewTweenMs = 0;
    controls.setPose({ target: { x: 0, y: 0, z: 0 }, radius: 5, phi: Math.PI / 2, theta: 0 });
    return controls;
  }

  it('turns by exactly one step, so six of them make a quarter turn', () => {
    // Fifteen degrees is what makes a run of presses land on a straight-on
    // view rather than near one: from the front, six lefts is the left view.
    const controls = stepped();
    for (let press = 0; press < 6; press += 1) controls.orbitStep('left');

    expect(controls.pose().theta).toBeCloseTo(-Math.PI / 2, 10);
    expect(ORBIT_STEP * 6).toBeCloseTo(Math.PI / 2, 10);
  });

  it('sends the camera the way the key is named', () => {
    // From the front view, left lands on the left view and up on the top one,
    // which is the whole reason the four are named for the camera.
    const left = stepped();
    for (let press = 0; press < 6; press += 1) left.orbitStep('left');
    expect(left.pose().theta).toBeCloseTo(-Math.PI / 2, 10);

    // Six ups from the front is aimed straight at the pole, and stops a
    // thousandth short of it, the same place the Top view stands. The sign
    // matters as much as the angle: past the pole the picture is upside down.
    const up = stepped();
    for (let press = 0; press < 6; press += 1) up.orbitStep('up');
    expect(up.pose().phi).toBeCloseTo(0.001, 10);
    expect(upSign(up.pose().phi)).toBe(1);

    const down = stepped();
    down.orbitStep('down');
    expect(down.pose().phi).toBeCloseTo(Math.PI / 2 + ORBIT_STEP, 10);

    const right = stepped();
    right.orbitStep('right');
    expect(right.pose().theta).toBeCloseTo(ORBIT_STEP, 10);
  });

  it('crosses the pole on the press after landing on it', () => {
    // Landing there is where an up run was aimed; carrying on past it is a
    // second ask, and an unlocked orbit still honours it.
    const controls = stepped();
    for (let press = 0; press < 6; press += 1) controls.orbitStep('up');
    expect(upSign(controls.pose().phi)).toBe(1);

    controls.orbitStep('up');
    expect(upSign(controls.pose().phi)).toBe(-1);
  });

  it('leaves a step that lands nowhere near a pole to the drag rule', () => {
    expect(orbitStepPhi(1, 0.2, false)).toBeCloseTo(orbitPhi(1, 0.2, false), 10);
  });

  it('obeys the vertical lock the same way a drag does', () => {
    // Locked, a run of ups stops just short of straight down rather than
    // rolling over the pole and coming up the far side upside down.
    const locked = stepped();
    locked.lockVerticalOrbit = true;
    for (let press = 0; press < 12; press += 1) locked.orbitStep('up');
    expect(locked.pose().phi).toBeCloseTo(0.001, 10);

    const free = stepped();
    for (let press = 0; press < 12; press += 1) free.orbitStep('up');
    expect(free.pose().phi).toBeGreaterThan(Math.PI);
  });

  it('leaves the pivot and the distance alone', () => {
    const controls = stepped();
    controls.orbitStep('left');

    expect(controls.distance).toBeCloseTo(5, 10);
    expect(controls.focusPoint.toArray()).toEqual([0, 0, 0]);
  });
});

describe('the opposite side', () => {
  function at(phi: number, theta: number) {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
    const controls = new CameraController(camera, document.createElement('div'));
    controls.viewTweenMs = 0;
    controls.setPose({ target: { x: 1, y: 2, z: 3 }, radius: 6, phi, theta });
    return { camera, controls };
  }

  it('puts the camera across the pivot from where it stood', () => {
    const { camera, controls } = at(1.1, 0.4);
    const before = camera.position.clone();

    controls.orbitOpposite();

    // The antipode about the pivot: each offset negated, the distance kept.
    const pivot = new THREE.Vector3(1, 2, 3);
    const after = camera.position.clone().sub(pivot);
    expect(after.x).toBeCloseTo(-(before.x - pivot.x), 6);
    expect(after.y).toBeCloseTo(-(before.y - pivot.y), 6);
    expect(after.z).toBeCloseTo(-(before.z - pivot.z), 6);
    expect(controls.distance).toBeCloseTo(6, 10);
  });

  it('leaves the picture the same way up', () => {
    // Reflecting the polar angle leaves its sine alone, so the jump reads as
    // walking round the model rather than as the view turning over.
    const { camera, controls } = at(1.1, 0.4);
    const up = camera.up.y;

    controls.orbitOpposite();

    expect(camera.up.y).toBe(up);
  });

  it('comes back to where it started when pressed twice', () => {
    const { controls } = at(1.1, 0.4);
    const before = controls.pose();

    controls.orbitOpposite();
    controls.orbitOpposite();

    expect(controls.pose().phi).toBeCloseTo(before.phi, 10);
    expect(Math.cos(controls.pose().theta)).toBeCloseTo(Math.cos(before.theta), 10);
  });
});

describe('the six axis views', () => {
  /** A pivot off the origin and a radius worth keeping, to prove neither moves. */
  const TARGET = { x: 2, y: -1, z: 4 };
  const RADIUS = 7;

  function viewed(axis: 'x' | 'y' | 'z', negative: boolean) {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
    const controls = new CameraController(camera, document.createElement('div'));
    controls.viewTweenMs = 0;
    controls.setPose({ target: TARGET, radius: RADIUS, phi: 1, theta: 1 });
    controls.setAxisView(axis, negative);
    return {
      controls,
      // Where the eye ended up relative to the pivot, which is the direction
      // the view is named after.
      offset: camera.position.clone().sub(new THREE.Vector3(TARGET.x, TARGET.y, TARGET.z)),
    };
  }

  it.each([
    ['top', 'y', false, [0, RADIUS, 0]],
    ['bottom', 'y', true, [0, -RADIUS, 0]],
    ['left', 'x', true, [-RADIUS, 0, 0]],
    ['right', 'x', false, [RADIUS, 0, 0]],
    ['front', 'z', false, [0, 0, RADIUS]],
    ['back', 'z', true, [0, 0, -RADIUS]],
  ] as const)('stands the camera on the %s of the scene', (_name, axis, negative, expected) => {
    const { offset } = viewed(axis, negative);

    // Loose: top and bottom stop a thousandth of a radian short of the pole,
    // which is what keeps `lookAt` able to say which way up the picture goes.
    expect(offset.x).toBeCloseTo(expected[0], 1);
    expect(offset.y).toBeCloseTo(expected[1], 1);
    expect(offset.z).toBeCloseTo(expected[2], 1);
  });

  it('leaves the pivot and the distance where they were', () => {
    // The view changes which side you are on, not how near you are standing:
    // an orbit afterwards has to carry on from the same place.
    const { controls } = viewed('y', true);

    expect(controls.distance).toBeCloseTo(RADIUS, 10);
    expect(controls.focusPoint.toArray()).toEqual([TARGET.x, TARGET.y, TARGET.z]);
  });
});

describe('zooming in on something small', () => {
  /** One wheel notch, the way the viewport hands them over. */
  function wheel(controls: CameraController, deltaY: number) {
    controls.onWheel({ deltaY } as WheelEvent);
  }

  it('closes in far enough for an object at the size floor to fill the view', () => {
    const { controls } = controllerAt(Math.PI / 3);

    for (let notch = 0; notch < 400; notch += 1) wheel(controls, -100);

    expect(controls.distance).toBe(MIN_ORBIT_DISTANCE);
    // At a 50 degree field of view this orbit spans about twice the floor, so
    // the smallest object allowed covers roughly half the viewport height.
    const spanned = 2 * controls.distance * Math.tan((50 * Math.PI) / 180 / 2);
    expect(spanned).toBeLessThan(MIN_OBJECT_SIZE * 4);
  });

  it('frames a millimetre-scale object close enough to see it', () => {
    const { controls } = controllerAt(Math.PI / 3);
    const box = new THREE.Box3(
      new THREE.Vector3(-0.0005, -0.0005, -0.0005),
      new THREE.Vector3(0.0005, 0.0005, 0.0005),
    );

    controls.frameBox(box);

    // Framing used to stop at half a metre, which left a 1 mm box a speck.
    expect(controls.distance).toBeLessThan(0.01);
    expect(controls.distance).toBeGreaterThanOrEqual(MIN_ORBIT_DISTANCE);
  });
});

describe('a zoom that has stopped biting', () => {
  /** One wheel notch in, the way the viewport hands them over. */
  function zoomIn(controls: CameraController, notches: number) {
    for (let notch = 0; notch < notches; notch += 1) {
      controls.onWheel({ deltaY: -100 } as WheelEvent);
    }
  }

  /** How far the camera stands from a one metre box sitting on the origin. */
  function gapToBox(camera: THREE.PerspectiveCamera): number {
    const box = new THREE.Box3(
      new THREE.Vector3(-0.5, -0.5, -0.5),
      new THREE.Vector3(0.5, 0.5, 0.5),
    );
    return box.distanceToPoint(camera.position);
  }

  it('leaves a camera framed on its model alone', () => {
    // The pivot is on the model, so every notch of the wheel closes a real
    // share of what is left between them.
    const { camera, controls } = controllerAt(Math.PI / 3);

    expect(zoomSpent(controls.distance, gapToBox(camera))).toBe(false);

    zoomIn(controls, 20);
    expect(zoomSpent(controls.distance, gapToBox(camera))).toBe(false);
  });

  it('says nothing while the camera is in amongst the geometry', () => {
    // No gap to close and plenty of orbit left: this is a close-up working,
    // which is most of a zoom in, since the camera is inside the bounding box
    // of what it is looking at long before it gets near anything.
    expect(zoomSpent(0.5, 0)).toBe(false);
  });

  it('catches the wheel going dead on a model the camera is right up against', () => {
    // The reported one, and the one the gap could never have caught: the
    // camera is inside the box it closed in on, so there is no gap to measure,
    // and the orbit is on its clamp so the wheel does nothing at all.
    const { camera, controls } = controllerAt(Math.PI / 3);
    controls.frameBox(
      new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)),
    );
    expect(zoomSpent(controls.distance, gapToBox(camera))).toBe(false);

    zoomIn(controls, 100);

    expect(controls.distance).toBe(MIN_ORBIT_DISTANCE);
    expect(gapToBox(camera)).toBe(0);
    expect(zoomSpent(controls.distance, gapToBox(camera))).toBe(true);
  });

  it('really has stopped moving by then, which is what the user sees', () => {
    const { controls } = controllerAt(Math.PI / 3);
    controls.frameBox(
      new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)),
    );
    zoomIn(controls, 100);

    const stalled = controls.distance;
    zoomIn(controls, 50);

    expect(controls.distance).toBe(stalled);
  });

  it('catches the pivot a pan left out in empty space', () => {
    const { camera, controls } = controllerAt(Math.PI / 3);
    // The pan that causes it: the pivot carried thirty metres off the model,
    // which is still sitting on the origin.
    controls.setPose({ target: { x: 30, y: 0, z: 0 }, radius: 5, phi: Math.PI / 3, theta: 0 });

    // Nothing is wrong yet: the orbit is still wide enough to matter.
    expect(zoomSpent(controls.distance, gapToBox(camera))).toBe(false);

    // Then the user scrolls, and scrolls, because nothing seems to be getting
    // any closer. Which it is not: the camera is converging on the pivot.
    zoomIn(controls, 30);
    expect(zoomSpent(controls.distance, gapToBox(camera))).toBe(true);
  });

  it('catches an orbit that has run all the way down to its clamp', () => {
    const { camera, controls } = controllerAt(Math.PI / 3);
    controls.setPose({ target: { x: 30, y: 0, z: 0 }, radius: 5, phi: Math.PI / 3, theta: 0 });

    zoomIn(controls, 400);

    expect(controls.distance).toBe(MIN_ORBIT_DISTANCE);
    expect(zoomSpent(controls.distance, gapToBox(camera))).toBe(true);
  });

  it('clears again once the camera is framed back on the model', () => {
    const { camera, controls } = controllerAt(Math.PI / 3);
    controls.setPose({ target: { x: 30, y: 0, z: 0 }, radius: 5, phi: Math.PI / 3, theta: 0 });
    zoomIn(controls, 60);
    expect(zoomSpent(controls.distance, gapToBox(camera))).toBe(true);

    controls.frameBox(
      new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)),
    );

    expect(zoomSpent(controls.distance, gapToBox(camera))).toBe(false);
  });
});

describe('what Frame All is asked to say', () => {
  it('says nothing while the camera is working normally', () => {
    // Framed on a one metre box: four metres of gap and five of orbit to
    // close it with.
    expect(viewLostReason(5, 4)).toBeNull();
  });

  it('calls an orbit scrolled out past the scene far', () => {
    expect(viewLostReason(MAX_ORBIT_DISTANCE * 0.9, 2500)).toBe('far');
  });

  it('calls a zoom that can no longer close the gap stuck', () => {
    // A tenth of a metre of orbit left against thirty metres of gap: the
    // wheel has nothing to give.
    expect(viewLostReason(0.1, 30)).toBe('stuck');
  });

  it('reports the distance first when the camera is both', () => {
    // Out past the scene, and with an orbit that could not close the gap
    // either. Coming back in is the move, and saying so is more use than
    // explaining the pivot.
    expect(viewLostReason(MAX_ORBIT_DISTANCE * 0.9, 1e6)).toBe('far');
  });

  it('says nothing when there is no gap to close and room left to close it', () => {
    // The camera is in amongst the geometry, which is where a close-up works.
    expect(viewLostReason(0.5, 0)).toBeNull();
  });

  it('calls a wheel that has run out of orbit stuck, gap or no gap', () => {
    expect(viewLostReason(MIN_ORBIT_DISTANCE, 0)).toBe('stuck');
  });
});

describe('a view that turns rather than jumps', () => {
  /**
   * A middle-button drag.
   *
   * jsdom has neither PointerEvent nor pointer capture, and the controller
   * reads five fields off the event, so a stand-in carrying those five is the
   * honest minimum rather than a mock of something larger.
   */
  function middleDrag(): PointerEvent {
    return {
      pointerId: 1,
      button: 1,
      clientX: 0,
      clientY: 0,
      shiftKey: false,
      altKey: false,
    } as unknown as PointerEvent;
  }

  /** A camera standing on the right of the scene, five metres out. */
  function onTheRight() {
    const element = document.createElement('div');
    element.setPointerCapture = () => {};
    element.hasPointerCapture = () => false;
    element.releasePointerCapture = () => {};

    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
    const controls = new CameraController(camera, element);
    controls.setPose({
      target: { x: 0, y: 0, z: 0 },
      radius: 5,
      phi: Math.PI / 2,
      theta: Math.PI / 2,
    });
    return { camera, controls };
  }

  it('leaves the camera where it stood until the clock moves', () => {
    // The keypress asks for the turn, it does not perform it, and the frame
    // that picks it up is where the two tenths of a second start counting.
    const { camera, controls } = onTheRight();

    controls.setAxisView('x', true);
    controls.update(0);

    expect(camera.position.x).toBeCloseTo(5, 6);
    expect(controls.isMoving).toBe(true);
  });

  it('is halfway round at half the time, which is the whole point', () => {
    // Right side to left side passes through the front, and watching it pass
    // is the only thing that says which way round the model went.
    const { camera, controls } = onTheRight();
    controls.setAxisView('x', true);

    controls.update(0);
    controls.update(VIEW_TWEEN_MS / 2);

    expect(camera.position.x).toBeCloseTo(0, 6);
    expect(camera.position.z).toBeCloseTo(5, 6);
  });

  it('arrives exactly, not a hair off', () => {
    const { camera, controls } = onTheRight();
    controls.setAxisView('x', true);

    controls.update(0);
    controls.update(VIEW_TWEEN_MS);

    expect(controls.isMoving).toBe(false);
    expect(camera.position.x).toBeCloseTo(-5, 6);
    expect(camera.position.y).toBeCloseTo(0, 6);
    expect(camera.position.z).toBeCloseTo(0, 6);
  });

  it('keeps the distance and the pivot through the turn', () => {
    const { controls } = onTheRight();
    controls.setAxisView('y', false);

    controls.update(0);
    controls.update(VIEW_TWEEN_MS * 0.4);

    expect(controls.distance).toBeCloseTo(5, 10);
    expect(controls.focusPoint.toArray()).toEqual([0, 0, 0]);
  });

  it('goes the shorter way round, however far the orbit has wound on', () => {
    // A camera dragged round a few times carries a large angle. Turning to the
    // raw number would take it most of a turn backwards to reach a view that
    // is a few degrees ahead.
    const { controls } = onTheRight();
    controls.setPose({ target: { x: 0, y: 0, z: 0 }, radius: 5, phi: Math.PI / 2, theta: 5.5 });

    controls.setAxisView('z', false);

    // Forward by the short hop to the next whole turn, not back by the rest.
    expect(controls.pose().theta).toBeCloseTo(2 * Math.PI, 6);
  });

  it('reports where it is heading while it turns, not where it has got to', () => {
    // Walking out of the module mid-turn should leave you at the view you
    // asked for, not at the frame the teardown happened to catch.
    const { controls } = onTheRight();
    controls.setAxisView('y', false);

    controls.update(0);
    controls.update(VIEW_TWEEN_MS * 0.25);

    expect(controls.isMoving).toBe(true);
    expect(controls.pose().phi).toBeCloseTo(0.001, 10);
  });

  it('gives the camera up to the hand that grabs it mid-turn', () => {
    const { controls } = onTheRight();
    controls.setAxisView('x', true);
    controls.update(0);
    controls.update(VIEW_TWEEN_MS / 2);

    controls.onPointerDown(middleDrag());

    // Left where the turn had got to, rather than snapped on to where it was
    // going: the drag carries on from what the user can see.
    expect(controls.isMoving).toBe(false);
    expect(controls.pose().theta).toBeCloseTo(0, 6);
  });

  it('stacks a second press onto where the first one was heading', () => {
    // A held orbit key would otherwise lose every step that lands mid-turn.
    const { controls } = onTheRight();
    const from = controls.pose().theta;

    controls.orbitStep('left');
    controls.orbitStep('left');

    expect(controls.pose().theta).toBeCloseTo(from - 2 * ORBIT_STEP, 10);
  });

  it('puts the camera there on the spot when the turn is switched off', () => {
    const { camera, controls } = onTheRight();
    controls.viewTweenMs = 0;

    controls.setAxisView('x', true);

    expect(controls.isMoving).toBe(false);
    expect(camera.position.x).toBeCloseTo(-5, 6);
  });
});
