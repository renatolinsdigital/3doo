import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { CameraController, orbitPhi, upSign } from './CameraController';

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
