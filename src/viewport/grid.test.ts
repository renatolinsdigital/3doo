import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { GridSettings } from './grid';
import {
  SNAP_ROTATE_STEP,
  SNAP_SCALE_STEP,
  ViewportGrid,
  gridLevel,
  snapAmounts,
  snapTo,
} from './grid';

/** The three coplanar line objects that make up the ground plane. */
function groundPlane(grid: ViewportGrid) {
  return grid.group.children as (THREE.Object3D & { material: THREE.Material })[];
}

describe('ground plane depth behaviour', () => {
  it('writes no depth anywhere on the plane', () => {
    // The fine grid, the coarse grid and the axes all sit at y = 0. Any one of
    // them writing depth leaves the others testing against a value equal to
    // their own to within float error, which is what flickered as the camera
    // orbited: the X axis alternating between red and the Z axis's cyan.
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

  it('carries a colour per endpoint of both centre lines', () => {
    const grid = new ViewportGrid();
    const axes = grid.group.children[2] as THREE.LineSegments;

    // Which hues those are is `axisColors.test.ts`, where they are checked
    // against the gizmo they have to match.
    expect(axes.geometry.getAttribute('color').count).toBe(4);
    expect(axes.geometry.getAttribute('position').count).toBe(4);
  });
});

/** The lines of one grid, as `GridHelper` lays them: one more than the cells. */
function cells(line: THREE.Object3D): number {
  const geometry = (line as THREE.LineSegments).geometry;
  return geometry.getAttribute('position').count / 4 - 1;
}

/** How far the lines reach, corner to corner along X. */
function extent(line: THREE.Object3D): number {
  const geometry = (line as THREE.LineSegments).geometry;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  return box ? box.max.x - box.min.x : 0;
}

const SETTINGS: GridSettings = {
  scale: 1,
  subdivisions: 10,
  color: '#3a2a28',
  opacity: 0.3,
  majorColor: '#b8452f',
  majorOpacity: 0.65,
};

describe('grid divisions', () => {
  it('starts at a square per unit with a heavy line every tenth', () => {
    const [fine, coarse] = groundPlane(new ViewportGrid());

    expect(cells(fine)).toBe(100);
    expect(cells(coarse)).toBe(10);
    expect(extent(fine)).toBe(100);
  });

  it('holds the square count and lets the scale set how far the plane reaches', () => {
    // Sizing by extent instead would thin the grid out to a handful of huge
    // squares, or a wall of tiny ones, as the scale moved.
    const grid = new ViewportGrid();
    grid.setGrid({ ...SETTINGS, scale: 0.5 });
    const [fine] = groundPlane(grid);

    expect(cells(fine)).toBe(100);
    expect(extent(fine)).toBe(50);
  });

  it('lands every heavy line on a division, whatever the subdivision count', () => {
    // 100 does not divide by 7, and a coarse grid that did not line up with the
    // fine one would draw its heavy lines through the middle of squares.
    const grid = new ViewportGrid();
    grid.setGrid({ ...SETTINGS, subdivisions: 7 });
    const [fine, coarse] = groundPlane(grid);

    expect(cells(fine) % cells(coarse)).toBe(0);
    expect(cells(fine) / cells(coarse)).toBe(7);
    expect(extent(fine)).toBe(extent(coarse));
  });

  it('leaves the centre lines out of it: what they answer to is the zoom', () => {
    // They stand for the world axes, not for a grid square, so neither the
    // scale nor the subdivisions move them. `centre lines through a zoom` is
    // where the length they are actually drawn at comes from.
    const grid = new ViewportGrid();
    const before = extent(groundPlane(grid)[2]);
    grid.setGrid({ ...SETTINGS, scale: 2, subdivisions: 5 });

    expect(extent(groundPlane(grid)[2])).toBe(before);
  });

  it('paints each set from its own colour and opacity', () => {
    const grid = new ViewportGrid();
    grid.setGrid({
      ...SETTINGS,
      color: '#123456',
      opacity: 0.1,
      majorColor: '#abcdef',
      majorOpacity: 0.9,
    });
    const [fine, coarse] = groundPlane(grid);

    expect(fine.material.opacity).toBeCloseTo(0.1);
    expect(coarse.material.opacity).toBeCloseTo(0.9);
    // GridHelper bakes the colour into the geometry, so that is where it has to
    // be read back from, in the working space THREE.Color converts it to.
    const expected = new THREE.Color('#123456');
    const colors = (fine as THREE.LineSegments).geometry.getAttribute('color');
    expect(colors.getX(0)).toBeCloseTo(expected.r);
    expect(colors.getY(0)).toBeCloseTo(expected.g);
    expect(colors.getZ(0)).toBeCloseTo(expected.b);
  });

  it('leaves a hidden plane hidden when the settings change', () => {
    // The overlay toggles and the preferences are set from different places,
    // and rebuilt lines that came back visible would ignore the overlay switch.
    const grid = new ViewportGrid();
    grid.setVisibility(false, false);
    grid.setGrid({ ...SETTINGS, scale: 4, color: '#000000' });

    for (const line of groundPlane(grid)) expect(line.visible).toBe(false);
  });
});

describe('fine lines through a zoom', () => {
  it('steps the grid by powers of ten, so the lines stay where they are', () => {
    expect(gridLevel(10).step).toBe(1);
    expect(gridLevel(99).step).toBe(1);
    expect(gridLevel(101).step).toBe(10);
  });

  it('draws the fine lines at full strength where they are widest apart', () => {
    // The near end of a decade: about seven squares across the view, which is
    // the whole point of drawing them.
    expect(gridLevel(10).fade).toBe(1);
    expect(gridLevel(100).fade).toBe(1);
  });

  it('eases them off over the crowded half of the decade', () => {
    // Ten to one across a decade, from seven lines on screen to seventy. A flat
    // alpha over that is what made the plane look like it kept gaining weight
    // and then losing it again at the step. Nothing happens while there is
    // still room: a grid that started dimming immediately would spend most of
    // its life half faded.
    expect(gridLevel(30).fade).toBe(1);
    expect(gridLevel(60).fade).toBeLessThan(1);
    expect(gridLevel(90).fade).toBeLessThan(gridLevel(60).fade);
    expect(gridLevel(99).fade).toBeLessThan(0.05);
  });

  it('leaves nothing to pop when the step lands', () => {
    // Either side of the boundary the fine lines are gone and back at full, and
    // the lines actually on screen through it are the heavy ones, which do not
    // move. Without the fade a grid ten times as dense vanished in one frame.
    expect(gridLevel(99.9).fade).toBeCloseTo(0, 2);
    expect(gridLevel(100.1).fade).toBeCloseTo(1, 2);
  });

  it('stays a fraction at any distance, however far in or out', () => {
    for (const distance of [0, 0.0001, 0.5, 1, 1e6, Number.MAX_SAFE_INTEGER]) {
      const { step, fade } = gridLevel(distance);
      expect(fade).toBeGreaterThanOrEqual(0);
      expect(fade).toBeLessThanOrEqual(1);
      expect(step).toBeGreaterThan(0);
    }
  });

  it('writes the faded strength onto the material, and keeps it across a settings change', () => {
    const grid = new ViewportGrid();
    const [fine, coarse] = groundPlane(grid);

    grid.setGrid(SETTINGS);
    grid.update(60);
    const faded = fine.material.opacity;
    expect(faded).toBeLessThan(SETTINGS.opacity);

    // Preferences are applied from somewhere else entirely, and used to write
    // the raw opacity straight over whatever the zoom had settled on.
    grid.setGrid({ ...SETTINGS, majorOpacity: 0.5 });
    expect(fine.material.opacity).toBeCloseTo(faded);
    expect(coarse.material.opacity).toBe(0.5);
  });

  it('leaves the heavy lines alone: they are the ones that carry the plane', () => {
    const grid = new ViewportGrid();
    const [, coarse] = groundPlane(grid);

    grid.setGrid(SETTINGS);
    grid.update(99);

    expect(coarse.material.opacity).toBe(SETTINGS.majorOpacity);
  });
});

/** How far one centre line runs out from the origin, in world units. */
function reach(line: THREE.Object3D): number {
  return (extent(line) / 2) * line.scale.x;
}

describe('centre lines through a zoom', () => {
  it('runs them well past the corner of the view, wherever the camera stands', () => {
    const grid = new ViewportGrid();
    const [, , axes] = groundPlane(grid);

    for (const distance of [0.0001, 0.01, 1, 100, 5000]) {
      grid.update(distance);
      expect(reach(axes)).toBeGreaterThanOrEqual(distance * 10);
    }
  });

  it('and no further, so the clip has the precision to place them', () => {
    // Fifty units long at every zoom, which is what they used to be, is
    // thousands of view widths once the camera is close in. All but a sliver of
    // the line is then clipped away before it is drawn, float32 has too little
    // left to say where that sliver lands, and the axis comes out a few pixels
    // off the grid's own centre line underneath it: two lines where there is
    // one. Below a millimetre the reach stops following the zoom down, so the
    // bound is read from the distances the zoom is actually taken at.
    const grid = new ViewportGrid();
    const [, , axes] = groundPlane(grid);

    for (const distance of [0.01, 0.5, 1, 100, 5000]) {
      grid.update(distance);
      expect(reach(axes) / distance).toBeLessThanOrEqual(50);
    }
  });

  it('keeps a line to see when the camera is sitting on its target', () => {
    // A restored pose can put the camera on the pivot, and a reach taken
    // straight from the distance would scale the lines away to a point.
    const grid = new ViewportGrid();
    const [, , axes] = groundPlane(grid);

    grid.update(0);

    expect(reach(axes)).toBeGreaterThan(0);
  });
});

describe('what snapping quantises to', () => {
  it('hands back nothing at all while it is switched off', () => {
    expect(snapAmounts(false, 1, 1)).toBeNull();
  });

  it('refuses a step of nothing rather than rounding every value to zero', () => {
    // Nothing in the UI offers one, but a preferences file or a hand-edited
    // storage blob can, and a step of zero would pin every transform in place.
    expect(snapAmounts(true, 0, 1)).toBeNull();
    expect(snapAmounts(true, -1, 1)).toBeNull();
    expect(snapAmounts(true, 1, 0)).toBeNull();
  });

  it('lands a move on one whole grid scale at a step of 1', () => {
    expect(snapAmounts(true, 1, 1)?.translate).toBeCloseTo(1);
    expect(snapAmounts(true, 1, 2)?.translate).toBeCloseTo(2);
  });

  it('multiplies that scale by the step asked for, preset or typed', () => {
    expect(snapAmounts(true, 0.1, 1)?.translate).toBeCloseTo(0.1);
    expect(snapAmounts(true, 0.25, 1)?.translate).toBeCloseTo(0.25);
    expect(snapAmounts(true, 0.03, 1)?.translate).toBeCloseTo(0.03);
    expect(snapAmounts(true, 0.1, 2)?.translate).toBeCloseTo(0.2);
  });

  it('scales the turn and the scale by that same step', () => {
    // Neither is a distance, so no grid square sets them: what the step divides
    // is the modelling increment itself.
    const half = snapAmounts(true, 0.5, 1);

    expect(half?.rotate).toBeCloseTo(SNAP_ROTATE_STEP / 2);
    expect(half?.scale).toBeCloseTo(SNAP_SCALE_STEP / 2);
  });

  it('leaves every amount alone when the camera moves', () => {
    // The plane on screen rescales by ten through a zoom. The snap deliberately
    // does not follow it: a step that changed by ten as you pulled back could
    // not be relied on to put anything anywhere.
    expect(gridLevel(10).step).not.toBe(gridLevel(1000).step);
    expect(snapAmounts(true, 1, 1)?.translate).toBeCloseTo(1);
  });

  it('puts a whole turn on the round angles a modeller reaches for', () => {
    for (const degrees of [15, 30, 45, 90, 180]) {
      const angle = (degrees * Math.PI) / 180;
      expect(snapTo(angle, SNAP_ROTATE_STEP)).toBeCloseTo(angle);
    }
  });
});

describe('snapTo', () => {
  it('rounds onto the nearest multiple, either way', () => {
    expect(snapTo(0.4, 0.25)).toBeCloseTo(0.5);
    expect(snapTo(-0.4, 0.25)).toBeCloseTo(-0.5);
    expect(snapTo(0.1, 0.25)).toBe(0);
  });

  it('leaves the value alone when there is no step to round onto', () => {
    expect(snapTo(1.234, 0)).toBe(1.234);
  });
});
