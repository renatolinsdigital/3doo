import { describe, expect, it } from 'vitest';

import { vec3 } from '../math';

import { pivotPosition } from './pivotTransform';

const noRotation = { rotationAxis: vec3(0, 1, 0), rotationAngle: 0 };
const noScale = { scaleRatio: vec3(1, 1, 1) };
const noMove = { translation: vec3(0, 0, 0) };

describe('pivotPosition', () => {
  describe('move', () => {
    it('translates a point by the delta regardless of pivot', () => {
      const result = pivotPosition(vec3(1, 2, 3), vec3(9, 9, 9), 'move', {
        ...noRotation,
        ...noScale,
        translation: vec3(1, 0, -1),
      });
      expect(result).toEqual(vec3(2, 2, 2));
    });
  });

  describe('rotate', () => {
    it('leaves a point unmoved when the pivot is the point itself (single-object case)', () => {
      const point = vec3(3, 4, 5);
      const result = pivotPosition(point, point, 'rotate', {
        ...noMove,
        ...noScale,
        rotationAxis: vec3(0, 1, 0),
        rotationAngle: Math.PI / 2,
      });
      expect(result.x).toBeCloseTo(point.x);
      expect(result.y).toBeCloseTo(point.y);
      expect(result.z).toBeCloseTo(point.z);
    });

    it('orbits a point 90° around a Y-axis pivot', () => {
      // Offset (1,0,0) from the origin, rotated +90° about Y.
      const result = pivotPosition(vec3(1, 0, 0), vec3(0, 0, 0), 'rotate', {
        ...noMove,
        ...noScale,
        rotationAxis: vec3(0, 1, 0),
        rotationAngle: Math.PI / 2,
      });
      expect(result.x).toBeCloseTo(0, 5);
      expect(result.y).toBeCloseTo(0, 5);
      expect(result.z).toBeCloseTo(-1, 5);
    });

    it('orbits a point around an off-origin pivot, not the world origin', () => {
      // Same relative offset as above, but centred on (5,0,5): must land at
      // pivot + rotated-offset, not at the world-origin answer.
      const result = pivotPosition(vec3(6, 0, 5), vec3(5, 0, 5), 'rotate', {
        ...noMove,
        ...noScale,
        rotationAxis: vec3(0, 1, 0),
        rotationAngle: Math.PI / 2,
      });
      expect(result.x).toBeCloseTo(5, 5);
      expect(result.y).toBeCloseTo(0, 5);
      expect(result.z).toBeCloseTo(4, 5);
    });

    it('is a no-op at zero rotation', () => {
      const result = pivotPosition(vec3(2, 3, 4), vec3(0, 0, 0), 'rotate', {
        ...noMove,
        ...noScale,
        rotationAxis: vec3(0, 1, 0),
        rotationAngle: 0,
      });
      expect(result.x).toBeCloseTo(2);
      expect(result.y).toBeCloseTo(3);
      expect(result.z).toBeCloseTo(4);
    });
  });

  describe('scale', () => {
    it('leaves a point unmoved when the pivot is the point itself', () => {
      const point = vec3(7, -2, 3);
      const result = pivotPosition(point, point, 'scale', {
        ...noMove,
        ...noRotation,
        scaleRatio: vec3(2, 2, 2),
      });
      expect(result).toEqual(point);
    });

    it('scales a point away from an off-origin pivot', () => {
      // Offset of (2,0,0) from pivot (3,0,0), doubled -> offset (4,0,0).
      const result = pivotPosition(vec3(5, 0, 0), vec3(3, 0, 0), 'scale', {
        ...noMove,
        ...noRotation,
        scaleRatio: vec3(2, 1, 1),
      });
      expect(result.x).toBeCloseTo(7);
      expect(result.y).toBeCloseTo(0);
      expect(result.z).toBeCloseTo(0);
    });

    it('supports independent non-uniform axis ratios', () => {
      const result = pivotPosition(vec3(1, 1, 1), vec3(0, 0, 0), 'scale', {
        ...noMove,
        ...noRotation,
        scaleRatio: vec3(2, 0.5, 3),
      });
      expect(result.x).toBeCloseTo(2);
      expect(result.y).toBeCloseTo(0.5);
      expect(result.z).toBeCloseTo(3);
    });
  });
});
