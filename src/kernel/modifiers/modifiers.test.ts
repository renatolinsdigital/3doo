import { describe, expect, it } from 'vitest';

import { createBox, createPlane } from '../primitives';

import { evaluateModifiers, createModifier } from './index';
import type { ArrayModifier, MirrorModifier, SolidifyModifier } from './types';

function mirror(overrides: Partial<MirrorModifier> = {}): MirrorModifier {
  return { ...(createModifier('mirror') as MirrorModifier), ...overrides };
}

describe('mirror modifier', () => {
  it('doubles geometry across the X axis', () => {
    const plane = createPlane(2);
    // Move the plane fully into +X so the mirror has something to reflect.
    for (const vert of plane.verts.values()) vert.co = { ...vert.co, x: vert.co.x + 2 };

    const result = evaluateModifiers(plane, [mirror({ merge: false })]);

    expect(result.faces.size).toBe(2);
    expect(result.verts.size).toBe(8);
    expect(result.boundingBox().min.x).toBeCloseTo(-3);
    expect(result.boundingBox().max.x).toBeCloseTo(3);
    expect(result.validate()).toEqual([]);
  });

  it('welds the seam when merge is on', () => {
    const plane = createPlane(2);
    for (const vert of plane.verts.values()) {
      vert.co = { ...vert.co, x: Math.max(0, vert.co.x) };
    }

    const result = evaluateModifiers(plane, [mirror({ merge: true, mergeThreshold: 0.01 })]);

    expect(result.verts.size).toBe(6);
    expect(result.faces.size).toBe(2);
    expect(result.validate()).toEqual([]);
  });

  it('keeps the mirrored half facing outward', () => {
    const cube = createBox(2);
    for (const vert of cube.verts.values()) vert.co = { ...vert.co, x: vert.co.x + 3 };

    const result = evaluateModifiers(cube, [mirror({ merge: false })]);

    for (const face of result.faces.values()) {
      const center = result.faceCenter(face);
      const origin = center.x > 0 ? { x: 3, y: 0, z: 0 } : { x: -3, y: 0, z: 0 };
      const outward =
        (center.x - origin.x) * face.normal.x +
        (center.y - origin.y) * face.normal.y +
        (center.z - origin.z) * face.normal.z;
      expect(outward).toBeGreaterThan(0);
    }
  });

  it('leaves the mesh alone when no axis is enabled', () => {
    const cube = createBox(2);
    const result = evaluateModifiers(cube, [
      mirror({ axes: { x: false, y: false, z: false } }),
    ]);
    expect(result.faces.size).toBe(6);
  });
});

describe('array modifier', () => {
  it('repeats the mesh along the relative offset', () => {
    const cube = createBox(2);
    const modifier = createModifier('array') as ArrayModifier;

    const result = evaluateModifiers(cube, [{ ...modifier, count: 3 }]);

    expect(result.faces.size).toBe(18);
    expect(result.verts.size).toBe(24);
    expect(result.boundingBox().max.x).toBeCloseTo(5);
    expect(result.validate()).toEqual([]);
  });

  it('welds copies together when merge is on', () => {
    const cube = createBox(2);
    const modifier = createModifier('array') as ArrayModifier;

    const result = evaluateModifiers(cube, [
      { ...modifier, count: 2, merge: true, mergeThreshold: 0.01 },
    ]);

    expect(result.verts.size).toBe(12);
    expect(result.validate()).toEqual([]);
  });

  it('is a no-op at a count of one', () => {
    const cube = createBox(2);
    const modifier = createModifier('array') as ArrayModifier;
    expect(evaluateModifiers(cube, [{ ...modifier, count: 1 }]).faces.size).toBe(6);
  });
});

describe('solidify modifier', () => {
  it('turns an open plane into a closed slab', () => {
    const plane = createPlane(2);
    const modifier = createModifier('solidify') as SolidifyModifier;

    const result = evaluateModifiers(plane, [{ ...modifier, thickness: 0.5 }]);

    expect(result.faces.size).toBe(6);
    expect(result.verts.size).toBe(8);
    expect([...result.edges.values()].every((edge) => edge.loops.length === 2)).toBe(true);
    expect(result.validate()).toEqual([]);
  });

  it('offsets by the requested thickness', () => {
    const plane = createPlane(2);
    const modifier = createModifier('solidify') as SolidifyModifier;

    const result = evaluateModifiers(plane, [{ ...modifier, thickness: 0.4 }]);
    const box = result.boundingBox();

    expect(box.max.y - box.min.y).toBeCloseTo(0.4);
  });

  it('centres the shell with even offset', () => {
    const plane = createPlane(2);
    const modifier = createModifier('solidify') as SolidifyModifier;

    const result = evaluateModifiers(plane, [
      { ...modifier, thickness: 0.4, evenOffset: true },
    ]);
    const box = result.boundingBox();

    expect(box.max.y).toBeCloseTo(0.2);
    expect(box.min.y).toBeCloseTo(-0.2);
  });
});

describe('modifier stack', () => {
  it('leaves the base mesh untouched', () => {
    const cube = createBox(2);
    const before = cube.faces.size;

    evaluateModifiers(cube, [createModifier('array'), createModifier('mirror')]);

    expect(cube.faces.size).toBe(before);
    expect(cube.verts.size).toBe(8);
  });

  it('applies modifiers in order', () => {
    const cube = createBox(2);
    const array = { ...(createModifier('array') as ArrayModifier), count: 2 };

    const stacked = evaluateModifiers(cube, [array, mirror({ merge: false })]);

    // Array doubles to 12 faces, mirror doubles again to 24.
    expect(stacked.faces.size).toBe(24);
  });

  it('skips disabled modifiers', () => {
    const cube = createBox(2);
    const array = { ...(createModifier('array') as ArrayModifier), count: 4, enabled: false };
    expect(evaluateModifiers(cube, [array]).faces.size).toBe(6);
  });

  it('welds a mesh through the weld modifier', () => {
    const cube = createBox(2);
    const weld = createModifier('weld');
    const result = evaluateModifiers(cube, [
      { ...weld, ...(weld.type === 'weld' ? { threshold: 5 } : {}) },
    ]);
    expect(result.verts.size).toBeLessThan(8);
  });
});
