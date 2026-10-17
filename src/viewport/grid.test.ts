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

/** The grid plane and the centre lines, the two coplanar objects that make up the ground. */
function groundPlane(grid: ViewportGrid) {
  return grid.group.children as (THREE.Object3D & { material: THREE.Material })[];
}

/** What the grid plane's shader is drawing with. */
function lines(grid: ViewportGrid) {
  const ground = groundPlane(grid)[0] as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  return ground.material.uniforms;
}

describe('ground plane depth behaviour', () => {
  it('writes no depth anywhere on the plane', () => {
    // The grid and the axes both sit at y = 0. Either one writing depth leaves
    // the other testing against a value equal to its own to within float
    // error, which is what flickered as the camera orbited: the X axis
    // alternating between red and the Z axis's cyan.
    for (const line of groundPlane(new ViewportGrid())) {
      expect(line.material.depthWrite).toBe(false);
      // Both have to be in the same pass for render order to sequence them;
      // an opaque one would draw before every transparent one whatever its
      // order says.
      expect(line.material.transparent).toBe(true);
    }
  });

  it('sequences the plane by a fixed order the camera cannot change', () => {
    const [ground, axes] = groundPlane(new ViewportGrid());

    expect(ground.renderOrder).toBeLessThan(axes.renderOrder);

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
    const axes = grid.group.children[1] as THREE.LineSegments;

    // Which hues those are is `axisColors.test.ts`, where they are checked
    // against the gizmo they have to match.
    expect(axes.geometry.getAttribute('color').count).toBe(4);
    expect(axes.geometry.getAttribute('position').count).toBe(4);
  });
});

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
  it('draws a square per unit with a heavy line every tenth at the zoom a unit suits', () => {
    const grid = new ViewportGrid();
    grid.setGrid(SETTINGS);
    grid.update(15, { x: 0, z: 0 });

    expect(lines(grid).spacing.value).toBe(1);
    expect(lines(grid).subdivisions.value).toBe(10);
  });

  it('lets the scale set the size of a square and nothing else', () => {
    // The scale used to set how far the plane reached as well, since it was
    // always a hundred squares across: half the scale was half the plane, and
    // the smallest scales left a patch round the origin with nothing past it.
    const grid = new ViewportGrid();
    grid.setGrid(SETTINGS);
    grid.update(15, { x: 0, z: 0 });
    const reach = groundBox(grid).max.x;

    grid.setGrid({ ...SETTINGS, scale: 0.5 });
    grid.update(15, { x: 0, z: 0 });

    expect(lines(grid).spacing.value).toBe(0.5);
    // Only the heavy square of slack the plane carries for following the
    // camera changes with it.
    expect(groundBox(grid).max.x).toBeCloseTo(reach - 5);
  });

  it('keeps a heavy line under the centre lines, wherever the camera has gone', () => {
    // The lines are measured from the plane's own middle, so that has to sit
    // on a heavy line of the world's for theirs to land on the world's. Laid
    // out by count, it used not to: three subdivisions made 33 heavy squares
    // of a hundred, and with an odd count the middle fell between two lines,
    // so the axes ran down the middle of a row of squares.
    const grid = new ViewportGrid();
    grid.setGrid({ ...SETTINGS, subdivisions: 3 });

    for (const focus of [
      { x: 0, z: 0 },
      { x: 33.3, z: -12.9 },
      { x: -1e4 + 0.2, z: 3e3 },
    ]) {
      grid.update(15, focus);
      const { x, z } = groundPlane(grid)[0].position;

      expect(Math.abs(x / 3 - Math.round(x / 3))).toBeLessThan(1e-9);
      expect(Math.abs(z / 3 - Math.round(z / 3))).toBeLessThan(1e-9);
    }
  });

  it('leaves the centre lines out of it: what they answer to is the zoom', () => {
    // They stand for the world axes, not for a grid square, so neither the
    // scale nor the subdivisions move them. `centre lines through a zoom` is
    // where the length they are actually drawn at comes from.
    const grid = new ViewportGrid();
    const before = extent(groundPlane(grid)[1]);
    grid.setGrid({ ...SETTINGS, scale: 2, subdivisions: 5 });

    expect(extent(groundPlane(grid)[1])).toBe(before);
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
    const uniforms = lines(grid);

    expect(uniforms.opacity.value).toBeCloseTo(0.1);
    expect(uniforms.majorOpacity.value).toBeCloseTo(0.9);
    // In the working space THREE.Color converts to, as every other material
    // in the scene gets its colours.
    expect(uniforms.color.value.getHex()).toBe(new THREE.Color('#123456').getHex());
    expect(uniforms.majorColor.value.getHex()).toBe(new THREE.Color('#abcdef').getHex());
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

    grid.setGrid(SETTINGS);
    grid.update(60, { x: 0, z: 0 });
    const faded = lines(grid).opacity.value;
    expect(faded).toBeLessThan(SETTINGS.opacity);

    // Preferences are applied from somewhere else entirely, and used to write
    // the raw opacity straight over whatever the zoom had settled on.
    grid.setGrid({ ...SETTINGS, majorOpacity: 0.5 });
    expect(lines(grid).opacity.value).toBeCloseTo(faded);
    expect(lines(grid).majorOpacity.value).toBe(0.5);
  });

  it('leaves the heavy lines alone: they are the ones that carry the plane', () => {
    const grid = new ViewportGrid();

    grid.setGrid(SETTINGS);
    grid.update(99, { x: 0, z: 0 });

    expect(lines(grid).majorOpacity.value).toBe(SETTINGS.majorOpacity);
  });
});

/** Where the ground plane itself is drawn, the centre lines left out. */
function groundBox(grid: ViewportGrid): THREE.Box3 {
  grid.group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const line of groundPlane(grid).slice(0, -1)) box.expandByObject(line);
  return box;
}

describe('how far the plane reaches', () => {
  it('runs on well past the view at the zoom the app opens at', () => {
    // The plane used to be a hundred squares across at every zoom. The app
    // opens about seven units out, where a square is a tenth of a unit, so the
    // whole plane was ten units wide and its far corner sat in plain view at
    // the top of the screen: the lines stopped dead and left a hole past it.
    for (const distance of [0.05, 7, 15, 99, 2000]) {
      const grid = new ViewportGrid();
      grid.setGrid(SETTINGS);
      grid.update(distance, { x: 0, z: 0 });
      const box = groundBox(grid);

      expect(box.min.x).toBeLessThanOrEqual(-8 * distance);
      expect(box.max.x).toBeGreaterThanOrEqual(8 * distance);
      expect(box.min.z).toBeLessThanOrEqual(-8 * distance);
      expect(box.max.z).toBeGreaterThanOrEqual(8 * distance);
    }
  });

  it('goes with the camera, so panning away never reaches its edge', () => {
    const grid = new ViewportGrid();
    grid.setGrid(SETTINGS);
    grid.update(7, { x: 400, z: -250 });
    const box = groundBox(grid);

    expect(box.min.x).toBeLessThanOrEqual(400 - 8 * 7);
    expect(box.max.x).toBeGreaterThanOrEqual(400 + 8 * 7);
    expect(box.min.z).toBeLessThanOrEqual(-250 - 8 * 7);
    expect(box.max.z).toBeGreaterThanOrEqual(-250 + 8 * 7);
  });

  it('reaches as far at a fine grid scale as at a coarse one', () => {
    // A hundred squares at a scale of 0.01 was a patch a single unit across.
    for (const scale of [0.001, 0.01, 1, 1000]) {
      const grid = new ViewportGrid();
      grid.setGrid({ ...SETTINGS, scale });
      grid.update(7, { x: 0, z: 0 });

      expect(groundBox(grid).max.x).toBeGreaterThanOrEqual(8 * 7);
    }
  });

  it('has faded out before it ends, so its end is never a line of its own', () => {
    // However far a plane runs, one that stops at full strength draws its
    // edge across the ground, which is the same hole further off.
    const grid = new ViewportGrid();
    const ground = groundPlane(grid)[0];

    for (const subdivisions of [1, 10, 100]) {
      grid.setGrid({ ...SETTINGS, subdivisions });
      for (const focus of [
        { x: 0, z: 0 },
        { x: 4.9, z: -4.9 },
        { x: 4999, z: 251 },
      ]) {
        grid.update(7, focus);
        const { fade, focus: offset } = lines(grid);
        const off = Math.max(Math.abs(offset.value.x), Math.abs(offset.value.y));

        expect(off + fade.value.y).toBeLessThanOrEqual(ground.scale.x);
        // The middle it fades from is the camera's, wherever the plane sits.
        expect(offset.value.x + ground.position.x).toBeCloseTo(focus.x);
        expect(offset.value.y + ground.position.z).toBeCloseTo(focus.z);
      }
    }
  });
});

/** How far one centre line runs out from the origin, in world units. */
function reach(line: THREE.Object3D): number {
  return (extent(line) / 2) * line.scale.x;
}

describe('centre lines through a zoom', () => {
  it('runs them well past the corner of the view, wherever the camera stands', () => {
    const grid = new ViewportGrid();
    const [, axes] = groundPlane(grid);

    for (const distance of [0.0001, 0.01, 1, 100, 5000]) {
      grid.update(distance, { x: 0, z: 0 });
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
    const [, axes] = groundPlane(grid);

    for (const distance of [0.01, 0.5, 1, 100, 5000]) {
      grid.update(distance, { x: 0, z: 0 });
      expect(reach(axes) / distance).toBeLessThanOrEqual(50);
    }
  });

  it('fades them out where the plane fades, from the same middle', () => {
    // Drawn at full strength to the end, they ran on past the faded plane and
    // stopped dead wherever the far plane cut them, in plain view in a picture
    // taken low across the ground.
    const grid = new ViewportGrid();
    const axes = groundPlane(grid)[1] as THREE.LineSegments<
      THREE.BufferGeometry,
      THREE.ShaderMaterial
    >;

    grid.update(7, { x: 12.3, z: -4.5 });
    const { fade, focus } = axes.material.uniforms;

    expect(fade.value.equals(lines(grid).fade.value)).toBe(true);
    expect(focus.value.x).toBeCloseTo(12.3);
    expect(focus.value.y).toBeCloseTo(-4.5);
    // Gone well inside how far they run, so neither their end nor the far
    // plane's cut is ever seen.
    expect(fade.value.y).toBeLessThan(reach(axes) / 2);
  });

  it('keeps a line to see when the camera is sitting on its target', () => {
    // A restored pose can put the camera on the pivot, and a reach taken
    // straight from the distance would scale the lines away to a point.
    const grid = new ViewportGrid();
    const [, axes] = groundPlane(grid);

    grid.update(0, { x: 0, z: 0 });

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
