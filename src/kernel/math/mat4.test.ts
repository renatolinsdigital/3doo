import { describe, expect, it } from 'vitest';

import {
  composeMatrix,
  degToRad,
  inverseTransformDirection,
  inverseTransformPoint,
  transformPoint,
  vec3,
} from './index';

const transform = {
  position: vec3(3, -2, 7),
  rotation: vec3(degToRad(20), degToRad(-55), degToRad(140)),
  scale: vec3(2, 0.5, 3),
};

describe('inverseTransformPoint', () => {
  it('undoes composeMatrix', () => {
    const local = vec3(1.5, -4, 0.25);
    const world = transformPoint(composeMatrix(transform), local);

    const back = inverseTransformPoint(transform, world);

    expect(back.x).toBeCloseTo(local.x, 6);
    expect(back.y).toBeCloseTo(local.y, 6);
    expect(back.z).toBeCloseTo(local.z, 6);
  });

  it('maps the object position to the local origin', () => {
    const back = inverseTransformPoint(transform, transform.position);
    expect(back.x).toBeCloseTo(0, 9);
    expect(back.y).toBeCloseTo(0, 9);
    expect(back.z).toBeCloseTo(0, 9);
  });

  it('survives a zeroed scale axis instead of dividing by it', () => {
    const flat = { ...transform, scale: vec3(1, 0, 1) };
    expect(inverseTransformPoint(flat, vec3(1, 1, 1)).y).toBe(0);
  });
});

describe('inverseTransformDirection', () => {
  it('rotates a world direction into the local frame without stretching it', () => {
    const local = vec3(0, 0, 1);
    // A direction ignores translation, so push it through the rotation only.
    const rotationOnly = { ...transform, position: vec3(), scale: vec3(1, 1, 1) };
    const world = transformPoint(composeMatrix(rotationOnly), local);

    const back = inverseTransformDirection(transform, world);

    expect(back.x).toBeCloseTo(local.x, 6);
    expect(back.y).toBeCloseTo(local.y, 6);
    expect(back.z).toBeCloseTo(local.z, 6);
  });

  it('returns a unit vector even under a non-uniform scale', () => {
    const result = inverseTransformDirection(transform, vec3(4, -9, 2));
    const length = Math.hypot(result.x, result.y, result.z);
    expect(length).toBeCloseTo(1, 9);
  });
});
