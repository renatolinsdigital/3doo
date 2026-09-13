import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { MIN_OBJECT_SIZE } from '@kernel/index';

import {
  CameraController,
  MAX_ORBIT_DISTANCE,
  MIN_ORBIT_DISTANCE,
  orbitPhi,
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
