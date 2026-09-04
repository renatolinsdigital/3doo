import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { vec3 } from '@kernel/index';

import { DEFAULT_BASIS, type CameraBasis, pinnedAxes, projectViewAxes } from './viewAxes';

/** The basis a camera standing at `eye` and looking at the origin ends up with. */
function basisLookingFrom(eye: THREE.Vector3): CameraBasis {
  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(eye);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const toward = new THREE.Vector3();
  camera.matrixWorld.extractBasis(right, up, toward);
  return {
    right: vec3(right.x, right.y, right.z),
    up: vec3(up.x, up.y, up.z),
    toward: vec3(toward.x, toward.y, toward.z),
  };
}

const markFor = (basis: CameraBasis, axis: 'x' | 'y' | 'z', negative = false) => {
  const mark = projectViewAxes(basis).find(
    (candidate) => candidate.axis === axis && candidate.negative === negative,
  );
  if (!mark) throw new Error(`no mark for ${axis}`);
  return mark;
};

describe('projectViewAxes', () => {
  it('puts the axis pointing at the camera in the middle of the widget', () => {
    // Looking from +Z, which is the front view: Z points straight out of the
    // screen, so it has nowhere left to go but the centre.
    const mark = markFor(DEFAULT_BASIS, 'z');

    expect(mark.x).toBeCloseTo(0);
    expect(mark.y).toBeCloseTo(0);
    expect(mark.depth).toBeCloseTo(1);
  });

  it('lays the other two axes out the way the screen has them', () => {
    const x = markFor(DEFAULT_BASIS, 'x');
    const y = markFor(DEFAULT_BASIS, 'y');

    expect(x.x).toBeCloseTo(1);
    expect(x.y).toBeCloseTo(0);
    // Up on screen is a smaller y in SVG, which is the flip this projection
    // exists to do once rather than at every call site.
    expect(y.x).toBeCloseTo(0);
    expect(y.y).toBeCloseTo(-1);
    expect(x.depth).toBeCloseTo(0);
    expect(y.depth).toBeCloseTo(0);
  });

  it('reads the depth off a real camera, from the top', () => {
    const basis = basisLookingFrom(new THREE.Vector3(0, 5, 0));

    expect(markFor(basis, 'y').depth).toBeCloseTo(1);
    expect(markFor(basis, 'y', true).depth).toBeCloseTo(-1);
    expect(markFor(basis, 'x').depth).toBeCloseTo(0);
  });

  it('sorts back to front, so painting in order puts the near end on top', () => {
    const marks = projectViewAxes(DEFAULT_BASIS);

    expect(marks[0]).toMatchObject({ axis: 'z', negative: true });
    expect(marks[marks.length - 1]).toMatchObject({ axis: 'z', negative: false });
    for (let i = 1; i < marks.length; i += 1) {
      expect(marks[i].depth).toBeGreaterThanOrEqual(marks[i - 1].depth);
    }
  });

  it('gives both ends of all three axes and nothing else', () => {
    expect(projectViewAxes(DEFAULT_BASIS)).toHaveLength(6);
  });
});

describe('pinnedAxes', () => {
  it('lights the one axis a transform is pinned to', () => {
    expect(pinnedAxes('x', false)).toEqual(['x']);
  });

  it('lights the two an excluded axis leaves free', () => {
    expect(pinnedAxes('x', true)).toEqual(['y', 'z']);
  });

  it('lights everything when nothing is pinned', () => {
    expect(pinnedAxes(null, false)).toBeNull();
  });
});
