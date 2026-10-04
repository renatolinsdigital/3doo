import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { OPENING_VIEW, axisViewAngles } from './CameraController';
import { SNAPSHOT_VIEWS, snapshotAngles, snapshotCamera } from './snapshot';

const box = new THREE.Box3(new THREE.Vector3(-1, 0, -0.5), new THREE.Vector3(3, 2, 0.5));
const center = box.getCenter(new THREE.Vector3());

/** Every corner of the box in normalised device coordinates. */
function corners(camera: THREE.Camera): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let index = 0; index < 8; index++) {
    points.push(
      new THREE.Vector3(
        index & 1 ? box.max.x : box.min.x,
        index & 2 ? box.max.y : box.min.y,
        index & 4 ? box.max.z : box.min.z,
      ).project(camera),
    );
  }
  return points;
}

describe('snapshot cameras', () => {
  it('stand where Shift and a number put the editor camera', () => {
    expect(snapshotAngles('perspective')).toEqual(OPENING_VIEW);
    expect(snapshotAngles('front')).toEqual(axisViewAngles('z', false));
    expect(snapshotAngles('back')).toEqual(axisViewAngles('z', true));
    expect(snapshotAngles('right')).toEqual(axisViewAngles('x', false));
    expect(snapshotAngles('left')).toEqual(axisViewAngles('x', true));
    expect(snapshotAngles('top')).toEqual(axisViewAngles('y', false));
    expect(snapshotAngles('bottom')).toEqual(axisViewAngles('y', true));
  });

  it('look at the model from the side each view is named for', () => {
    const from = (view: (typeof SNAPSHOT_VIEWS)[number]) =>
      snapshotCamera(view, box, 4 / 3, 'auto')
        .camera.position.clone()
        .sub(center)
        .normalize();

    expect(from('front').z).toBeCloseTo(1);
    expect(from('back').z).toBeCloseTo(-1);
    expect(from('right').x).toBeCloseTo(1);
    expect(from('left').x).toBeCloseTo(-1);
    expect(from('top').y).toBeCloseTo(1);
    expect(from('bottom').y).toBeCloseTo(-1);
    expect(from('perspective').y).toBeGreaterThan(0);
  });

  it('draw the opening view in perspective and the straight-on ones flat, unless told', () => {
    expect(snapshotCamera('perspective', box, 1, 'auto').camera).toBeInstanceOf(
      THREE.PerspectiveCamera,
    );
    expect(snapshotCamera('front', box, 1, 'auto').camera).toBeInstanceOf(THREE.OrthographicCamera);
    expect(snapshotCamera('front', box, 1, 'perspective').camera).toBeInstanceOf(
      THREE.PerspectiveCamera,
    );
    expect(snapshotCamera('perspective', box, 1, 'orthographic').camera).toBeInstanceOf(
      THREE.OrthographicCamera,
    );
  });

  it('fit the whole model in the frame, and fill it, from every view and projection', () => {
    for (const projection of ['perspective', 'orthographic'] as const) {
      for (const aspect of [16 / 9, 1, 9 / 16]) {
        for (const view of SNAPSHOT_VIEWS) {
          const { camera } = snapshotCamera(view, box, aspect, projection);
          const points = corners(camera);
          const reach = Math.max(...points.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));

          expect(reach, `${view} ${projection} ${aspect}`).toBeLessThanOrEqual(1);
          expect(reach, `${view} ${projection} ${aspect}`).toBeGreaterThan(0.8);
          for (const point of points) expect(Math.abs(point.z)).toBeLessThan(1);
        }
      }
    }
  });

  it('frame something sensible for an empty scene', () => {
    const { camera } = snapshotCamera('perspective', new THREE.Box3(), 1, 'auto');
    expect(Number.isFinite(camera.position.length())).toBe(true);
    expect(camera.position.length()).toBeGreaterThan(1);
  });
});
