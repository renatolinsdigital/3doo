import { describe, expect, it } from 'vitest';

import { vec3 } from '../math';

import { pivotPosition, pivotReorient, pivotScale } from './pivotTransform';

const noRotation = { rotationAxis: vec3(0, 1, 0), rotationAngle: 0 };
const worldFrame = vec3(0, 0, 0);
const noScale = { scaleRatio: vec3(1, 1, 1), scaleFrame: worldFrame };
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
        scaleFrame: worldFrame,
        scaleRatio: vec3(2, 2, 2),
      });
      expect(result).toEqual(point);
    });

    it('scales a point away from an off-origin pivot', () => {
      // Offset of (2,0,0) from pivot (3,0,0), doubled -> offset (4,0,0).
      const result = pivotPosition(vec3(5, 0, 0), vec3(3, 0, 0), 'scale', {
        ...noMove,
        ...noRotation,
        scaleFrame: worldFrame,
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
        scaleFrame: worldFrame,
        scaleRatio: vec3(2, 0.5, 3),
      });
      expect(result.x).toBeCloseTo(2);
      expect(result.y).toBeCloseTo(0.5);
      expect(result.z).toBeCloseTo(3);
    });

    it('spreads a point along the axes of the handles, not the world', () => {
      // Handles turned a quarter about Y put their X along world -Z, so a
      // stretch along that X carries an offset on world Z and leaves world X.
      const result = pivotPosition(vec3(1, 0, 1), vec3(0, 0, 0), 'scale', {
        ...noMove,
        ...noRotation,
        scaleFrame: vec3(0, Math.PI / 2, 0),
        scaleRatio: vec3(2, 1, 1),
      });
      expect(result.x).toBeCloseTo(1);
      expect(result.y).toBeCloseTo(0);
      expect(result.z).toBeCloseTo(2);
    });
  });
});

describe('pivotScale', () => {
  it('multiplies straight through when the object and the handles agree', () => {
    const result = pivotScale(vec3(1, 2, 3), worldFrame, worldFrame, vec3(2, 1, 0.5));
    expect(result.x).toBeCloseTo(2);
    expect(result.y).toBeCloseTo(2);
    expect(result.z).toBeCloseTo(1.5);
  });

  it('scales a lone turned object along its own axes', () => {
    const turn = vec3(0.4, -1.1, 2.3);
    const result = pivotScale(vec3(1, 1, 1), turn, turn, vec3(3, 1, 1));
    expect(result.x).toBeCloseTo(3);
    expect(result.y).toBeCloseTo(1);
    expect(result.z).toBeCloseTo(1);
  });

  it('stretches a turned object in a group along the world axis dragged', () => {
    // Stood on end by a quarter turn about X, the object's own Z points down
    // world Y. Scaling the group taller has to lengthen that axis, not the
    // object's Y, which now runs along world Z.
    const result = pivotScale(vec3(1, 1, 1), vec3(Math.PI / 2, 0, 0), worldFrame, vec3(1, 2, 1));
    expect(result.x).toBeCloseTo(1);
    expect(result.y).toBeCloseTo(1);
    expect(result.z).toBeCloseTo(2);
  });

  it('keeps an axis lying across the drag at its length', () => {
    // Turned an eighth about Z, the object's X and Y both lean into world X,
    // and its Z is untouched by a stretch along world X.
    const result = pivotScale(vec3(1, 1, 1), vec3(0, 0, Math.PI / 4), worldFrame, vec3(2, 1, 1));
    expect(result.x).toBeCloseTo(Math.sqrt(2.5));
    expect(result.y).toBeCloseTo(Math.sqrt(2.5));
    expect(result.z).toBeCloseTo(1);
  });
});

describe('pivotReorient', () => {
  const noTurn = vec3(0, 0, 0);

  it('leaves a point where it stands when the pivot is the point itself', () => {
    const point = vec3(-5, 0, 0);
    const result = pivotReorient(point, point, noTurn, vec3(0, Math.PI / 4, 0));
    expect(result).toEqual(point);
  });

  it('swings an off-pivot origin round to where the typed turn puts it', () => {
    // The panel case: a box five metres out along -X, turned 45 degrees about
    // Y with the 3D cursor at the origin, lands on the diagonal rather than
    // spinning where it stands.
    const result = pivotReorient(vec3(-5, 0, 0), vec3(0, 0, 0), noTurn, vec3(0, Math.PI / 4, 0));
    expect(result.x).toBeCloseTo(-Math.SQRT1_2 * 5);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(Math.SQRT1_2 * 5);
  });

  it('measures the turn from the orientation the object already had', () => {
    // Typing 90 into a field that already read 45 is another 45 degrees of
    // travel, not 90: the field names where to end up, not how far to go.
    const from = vec3(0, Math.PI / 4, 0);
    const result = pivotReorient(vec3(-5, 0, 0), vec3(0, 0, 0), from, vec3(0, Math.PI / 2, 0));
    const direct = pivotReorient(vec3(-5, 0, 0), vec3(0, 0, 0), noTurn, vec3(0, Math.PI / 4, 0));
    expect(result.x).toBeCloseTo(direct.x);
    expect(result.z).toBeCloseTo(direct.z);
  });

  it('puts a point back where it started when the turn is undone', () => {
    const start = vec3(2, 3, -1);
    const turned = pivotReorient(start, vec3(1, 0, 1), noTurn, vec3(0.3, -0.7, 1.1));
    const back = pivotReorient(turned, vec3(1, 0, 1), vec3(0.3, -0.7, 1.1), noTurn);
    expect(back.x).toBeCloseTo(start.x);
    expect(back.y).toBeCloseTo(start.y);
    expect(back.z).toBeCloseTo(start.z);
  });
});
