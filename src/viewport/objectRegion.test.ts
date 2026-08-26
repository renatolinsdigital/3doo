import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { ObjectView } from '@bridge/index';

import { type ObjectEntry, pickObjectsInRegion, rectangleRegion } from './picking';

const SIZE = { width: 200, height: 200 };

/**
 * An orthographic camera whose mapping is easy to reason about: world (x, y)
 * lands at pixel (100 + 10x, 100 - 10y).
 */
function camera(): THREE.Camera {
  const view = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  view.position.set(0, 0, 10);
  view.lookAt(0, 0, 0);
  view.updateMatrixWorld(true);
  view.updateProjectionMatrix();
  return view;
}

/** A square in the z = 0 plane, as much of an ObjectView as the picker reads. */
function square(id: string, half: number, offsetX = 0): ObjectEntry {
  const corners: [number, number][] = [
    [-half + offsetX, -half],
    [half + offsetX, -half],
    [half + offsetX, half],
    [-half + offsetX, half],
  ];

  const vertPositions = new Float32Array(corners.flatMap(([x, y]) => [x, y, 0]));
  const edgePositions = new Float32Array(
    corners.flatMap(([x, y], index) => {
      const [nextX, nextY] = corners[(index + 1) % corners.length];
      return [x, y, 0, nextX, nextY, 0];
    }),
  );

  const view = {
    group: new THREE.Group(),
    vertIds: new Int32Array(corners.map((_, index) => index)),
    vertPositions,
    edgeIds: new Int32Array(corners.map((_, index) => index)),
    edgePositions,
  } as unknown as ObjectView;

  return { id, view };
}

const region = (minX: number, minY: number, maxX: number, maxY: number) => ({
  test: rectangleRegion({ minX, minY, maxX, maxY }),
  bounds: { minX, minY, maxX, maxY },
});

describe('object region select', () => {
  it('takes an object the region covers', () => {
    const box = region(80, 80, 120, 120);

    const hits = pickObjectsInRegion([square('a', 1)], box.test, box.bounds, camera(), SIZE);

    expect(hits).toEqual(['a']);
  });

  it('takes an object the region only touches', () => {
    // A square from (90, 90) to (110, 110) in pixels; this catches one corner.
    const box = region(85, 85, 95, 95);

    const hits = pickObjectsInRegion([square('a', 1)], box.test, box.bounds, camera(), SIZE);

    expect(hits).toEqual(['a']);
  });

  it('takes an object the region cuts across without reaching a corner', () => {
    // The square spans (50, 50) to (150, 150); this band crosses its two
    // vertical edges and contains none of its vertices.
    const box = region(40, 98, 160, 102);

    const hits = pickObjectsInRegion([square('a', 5)], box.test, box.bounds, camera(), SIZE);

    expect(hits).toEqual(['a']);
  });

  it('leaves an object the region misses', () => {
    const box = region(0, 0, 20, 20);

    const hits = pickObjectsInRegion([square('a', 1)], box.test, box.bounds, camera(), SIZE);

    expect(hits).toEqual([]);
  });

  it('takes every object the region reaches, in scene order', () => {
    const box = region(80, 80, 160, 120);

    const hits = pickObjectsInRegion(
      [square('a', 1), square('b', 1, 5), square('c', 1, -20)],
      box.test,
      box.bounds,
      camera(),
      SIZE,
    );

    expect(hits).toEqual(['a', 'b']);
  });
});
