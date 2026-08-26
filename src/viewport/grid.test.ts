import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { ViewportGrid } from './grid';

/** The three coplanar line objects that make up the ground plane. */
function groundPlane(grid: ViewportGrid) {
  return grid.group.children as (THREE.Object3D & { material: THREE.Material })[];
}

describe('ground plane depth behaviour', () => {
  it('writes no depth anywhere on the plane', () => {
    // The fine grid, the coarse grid and the axes all sit at y = 0. Any one of
    // them writing depth leaves the others testing against a value equal to
    // their own to within float error, which is what flickered as the camera
    // orbited — the X axis alternating between red and the Z axis's cyan.
    for (const line of groundPlane(new ViewportGrid())) {
      expect(line.material.depthWrite).toBe(false);
      // All three have to be in the same pass for render order to sequence
      // them; an opaque one would draw before every transparent one whatever
      // its order says.
      expect(line.material.transparent).toBe(true);
    }
  });

  it('sequences the plane by a fixed order the camera cannot change', () => {
    const [fine, coarse, axes] = groundPlane(new ViewportGrid());

    expect(fine.renderOrder).toBeLessThan(coarse.renderOrder);
    expect(coarse.renderOrder).toBeLessThan(axes.renderOrder);

    // Behind the selection overlays, which start at 0 and climb (see
    // `ObjectView`): the ground plane is background, whatever the distance
    // sort would otherwise make of it.
    expect(axes.renderOrder).toBeLessThan(0);
  });

  it('still depth-tests, so the plane stays behind solid geometry', () => {
    for (const line of groundPlane(new ViewportGrid())) {
      expect(line.material.depthTest).toBe(true);
    }
  });

  it('keeps the axes on their two colours', () => {
    const grid = new ViewportGrid();
    const axes = grid.group.children[2] as THREE.LineSegments;
    const colors = axes.geometry.getAttribute('color');

    expect(colors.count).toBe(4);
    // Red along X, cyan along Z — one colour per endpoint, two per line.
    expect(colors.getX(0)).toBeCloseTo(0.9);
    expect(colors.getZ(2)).toBeCloseTo(0.82);
  });
});
