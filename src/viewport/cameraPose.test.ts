import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { CameraController } from './CameraController';

function controller() {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
  return new CameraController(camera, document.createElement('div'));
}

describe('camera pose handover', () => {
  it('round-trips the view a viewport was left at', () => {
    // Switching module tears the viewport down and builds another, so what the
    // user navigated to has to survive as plain data in the store.
    const left = controller();
    left.onWheel(new WheelEvent('wheel', { deltaY: -400 }));
    left.setAxisView('x', false);

    const pose = left.pose();
    const arrived = controller();
    arrived.setPose(pose);

    expect(arrived.pose()).toEqual(pose);
    expect(arrived.distance).toBeCloseTo(left.distance, 10);
    expect(arrived.focusPoint.toArray()).toEqual(left.focusPoint.toArray());
  });

  it('puts the camera itself where the pose says', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
    const controls = new CameraController(camera, document.createElement('div'));

    controls.setPose({ target: { x: 1, y: 2, z: 3 }, radius: 10, phi: Math.PI / 2, theta: 0 });

    // phi at the equator and theta at zero puts the eye straight out on +z.
    expect(camera.position.x).toBeCloseTo(1, 6);
    expect(camera.position.y).toBeCloseTo(2, 6);
    expect(camera.position.z).toBeCloseTo(13, 6);
  });
});
