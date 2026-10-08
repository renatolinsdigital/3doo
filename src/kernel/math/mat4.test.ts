import { describe, expect, it } from 'vitest';

import {
  composeMatrix,
  degToRad,
  inverseMatrix,
  inverseTransformDirection,
  inverseTransformOffset,
  inverseTransformPoint,
  sub,
  transformPoint,
  vec3,
} from './index';

const transform = {
  position: vec3(3, -2, 7),
  rotation: vec3(degToRad(20), degToRad(-55), degToRad(140)),
  scale: vec3(2, 0.5, 3),
};

describe('inverseMatrix', () => {
  it('undoes composeMatrix', () => {
    const local = vec3(1.5, -4, 0.25);
    const world = transformPoint(composeMatrix(transform), local);

    const back = transformPoint(inverseMatrix(transform), world);

    expect(back.x).toBeCloseTo(local.x, 6);
    expect(back.y).toBeCloseTo(local.y, 6);
    expect(back.z).toBeCloseTo(local.z, 6);
  });
});

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

describe('inverseTransformOffset', () => {
  it('undoes the rotation as well as the scale', () => {
    const local = vec3(0.4, -1.2, 2);
    const world = sub(
      transformPoint(composeMatrix(transform), local),
      transformPoint(composeMatrix(transform), vec3()),
    );

    const back = inverseTransformOffset(transform, world);

    expect(back.x).toBeCloseTo(local.x, 6);
    expect(back.y).toBeCloseTo(local.y, 6);
    expect(back.z).toBeCloseTo(local.z, 6);
  });

  it('keeps the distance travelled rather than normalising it', () => {
    const turned = {
      position: vec3(3, -2, 7),
      rotation: vec3(0, degToRad(90), 0),
      scale: vec3(1, 1, 1),
    };

    // A move along world X on an object turned a quarter turn about Y: the same
    // metre, now along the object's own Z.
    const back = inverseTransformOffset(turned, vec3(1, 0, 0));

    expect(back.x).toBeCloseTo(0, 6);
    expect(back.y).toBeCloseTo(0, 6);
    expect(back.z).toBeCloseTo(1, 6);
  });

  it('ignores the object position', () => {
    const moved = { ...transform, position: vec3(100, -80, 12) };

    const here = inverseTransformOffset(transform, vec3(1, 2, 3));
    const there = inverseTransformOffset(moved, vec3(1, 2, 3));

    expect(there.x).toBeCloseTo(here.x, 9);
    expect(there.y).toBeCloseTo(here.y, 9);
    expect(there.z).toBeCloseTo(here.z, 9);
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
