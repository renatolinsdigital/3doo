import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { describe, expect, it } from 'vitest';

import { VIEWPORT_COLORS } from '@bridge/index';
import { DEFAULT_PREFERENCES } from '@store/index';

import { ViewportGrid } from './grid';
import { paintGizmoAxes } from './Viewport';

const DEFAULT_AXES = DEFAULT_PREFERENCES.axisColors;

/** A painted gizmo, plus a way to put it mid-drag and read a colour back. */
function painted() {
  const controls = new TransformControls(
    new THREE.PerspectiveCamera(),
    document.createElement('div'),
  );
  const helper = (controls as unknown as { getHelper: () => THREE.Object3D }).getHelper();
  const paint = paintGizmoAxes(helper, controls);

  const drag = (axis: string | null) => {
    (controls as unknown as { axis: string | null }).axis = axis;
    (controls as unknown as { dragging: boolean }).dragging = axis !== null;
    helper.updateMatrixWorld(true);
  };

  /** The colour of the named handle, or of the guide line by that name. */
  const colorOf = (name: string, guide = false) => {
    let hex = '';
    helper.traverse((child) => {
      const isGuide = (child as THREE.Object3D & { tag?: string }).tag === 'helper';
      if (child.name !== name || isGuide !== guide) return;
      // Each handle has a picker by the same name, white and in a hidden group.
      // This used to read those, so the drag tests below were checking a colour
      // that never changes and passed whatever the handles did. Guides are left
      // out of the check: their group is hidden whenever nothing is being dragged.
      if (!guide && !child.parent?.visible) return;
      const material = (child as Partial<THREE.Mesh>).material as
        (THREE.Material & { color?: THREE.Color }) | undefined;
      if (material?.color) hex = material.color.getHexString();
    });
    return hex;
  };

  return { controls, helper, paint, drag, colorOf };
}

/** Every gizmo handle colour after the repaint, keyed by the handles sharing it. */
function gizmoColors(): Map<string, string[]> {
  const { helper } = painted();

  const byColor = new Map<string, string[]>();
  helper.traverse((child) => {
    const material = (child as Partial<THREE.Mesh>).material as
      (THREE.Material & { color?: THREE.Color }) | undefined;
    if (!material?.color || !child.name) return;

    const hex = material.color.getHexString();
    const names = byColor.get(hex) ?? [];
    if (!names.includes(child.name)) names.push(child.name);
    byColor.set(hex, names);
  });
  return byColor;
}

/** The vertex colour of the grid line starting at the given vertex. */
function axisLineColor(grid: ViewportGrid, vertex: number): string {
  const axes = grid.group.children[1] as THREE.LineSegments;
  const colors = axes.geometry.getAttribute('color');
  return new THREE.Color(
    colors.getX(vertex),
    colors.getY(vertex),
    colors.getZ(vertex),
  ).getHexString();
}

describe('axis colours', () => {
  it('defaults to one reddish, one yellowish and one bluish hue from the palette', () => {
    expect(new THREE.Color(DEFAULT_AXES.x).getHex()).toBe(VIEWPORT_COLORS.red);
    expect(new THREE.Color(DEFAULT_AXES.y).getHex()).toBe(VIEWPORT_COLORS.amber);
    expect(new THREE.Color(DEFAULT_AXES.z).getHex()).toBe(VIEWPORT_COLORS.cyan);
  });

  it('paints the gizmo handles off that table instead of raw RGB', () => {
    // Not asserted through the module under test's own constants alone: pure
    // red, green and blue are what TransformControls ships with, so their
    // absence is the evidence the repaint ran.
    const colors = gizmoColors();

    for (const rgb of ['ff0000', '00ff00', '0000ff']) {
      expect(colors.has(rgb)).toBe(false);
    }

    // Three shares each axis material with the plane facing it, so recolouring
    // by hue carries the plane handles along.
    expect(colors.get(new THREE.Color(DEFAULT_AXES.x).getHexString())).toEqual(['X', 'YZ']);
    expect(colors.get(new THREE.Color(DEFAULT_AXES.y).getHexString())).toEqual(['Y', 'XZ']);
    expect(colors.get(new THREE.Color(DEFAULT_AXES.z).getHexString())).toEqual(['Z', 'XY']);
  });

  it('gives the world centre lines the very same values', () => {
    const grid = new ViewportGrid();

    // The point of the exercise: an axis reads the same whether you are looking
    // at the line through the world or the handle on the object.
    expect(axisLineColor(grid, 0)).toBe(new THREE.Color(DEFAULT_AXES.x).getHexString());
    expect(axisLineColor(grid, 2)).toBe(new THREE.Color(DEFAULT_AXES.z).getHexString());
  });

  it('repaints the centre lines from end to end', () => {
    const grid = new ViewportGrid();
    grid.setAxisColors({ x: '#102030', y: '#405060', z: '#708090' });

    expect(axisLineColor(grid, 0)).toBe('102030');
    expect(axisLineColor(grid, 1)).toBe('102030');
    expect(axisLineColor(grid, 2)).toBe('708090');
    expect(axisLineColor(grid, 3)).toBe('708090');
  });
});

describe('a gizmo repainted in other colours', () => {
  const OTHERS = { x: '#102030', y: '#405060', z: '#708090' };

  it('puts each colour on the axis handle and the plane facing it', () => {
    const { paint, colorOf } = painted();
    paint(OTHERS);

    expect(colorOf('X')).toBe('102030');
    expect(colorOf('YZ')).toBe('102030');
    expect(colorOf('Y')).toBe('405060');
    expect(colorOf('XZ')).toBe('405060');
    expect(colorOf('Z')).toBe('708090');
    expect(colorOf('XY')).toBe('708090');
  });

  it('survives the frame, which restores each handle from what three cached', () => {
    // Three caches `_color` on the first update and copies it back on every one
    // after. Writing the colour alone would last until the next frame.
    const { paint, drag, colorOf } = painted();
    drag(null);
    paint(OTHERS);
    drag(null);

    expect(colorOf('X')).toBe('102030');
  });

  it('runs the guide line in the new colour', () => {
    const { paint, drag, colorOf } = painted();
    paint(OTHERS);
    drag('Z');

    expect(colorOf('Z', true)).toBe('708090');
  });

  it('lights the dragged handle from the new colour', () => {
    // Saturated, since the hue of a dark grey does not survive rounding to 8 bits.
    const blue = '#2040e0';
    const { paint, drag, colorOf } = painted();
    paint({ ...OTHERS, x: blue });
    drag('X');

    const lit = new THREE.Color(`#${colorOf('X')}`).getHSL({ h: 0, s: 0, l: 0 });
    const axis = new THREE.Color(blue).getHSL({ h: 0, s: 0, l: 0 });

    expect(lit.h).toBeCloseTo(axis.h, 2);
    expect(lit.l).toBeGreaterThan(axis.l);
  });

  it('shows an axis set to the highlight yellow as yellow, not lit up', () => {
    // The frame hook spots three's highlight by this exact hex and lightens it,
    // so a handle really painted that colour would rest washed out towards
    // white, looking grabbed with nothing near it.
    const { paint, drag, colorOf } = painted();
    drag(null);
    paint({ ...OTHERS, y: '#ffff00' });
    drag(null);

    const resting = colorOf('Y');
    expect(resting).toBe('fffe00');

    drag('Y');
    expect(colorOf('Y')).not.toBe(resting);

    drag(null);
    expect(colorOf('Y')).toBe(resting);
  });
});

describe('the axis being dragged', () => {
  it('never turns the handle yellow', () => {
    // TransformControls paints the picked handle 0xffff00 from inside its own
    // updateMatrixWorld, every frame. Nothing else in the viewport is yellow,
    // so it reads as a colour with a meaning of its own rather than as "this
    // axis, lit up".
    const gizmo = painted();

    for (const axis of ['X', 'Y', 'Z']) {
      gizmo.drag(axis);
      expect(gizmo.colorOf(axis)).not.toBe('ffff00');
    }
  });

  it('lights the handle by lifting its own colour, so the axis still reads', () => {
    const gizmo = painted();
    gizmo.drag('X');

    const lit = new THREE.Color(`#${gizmo.colorOf('X')}`).getHSL({ h: 0, s: 0, l: 0 });
    const axis = new THREE.Color(DEFAULT_AXES.x).getHSL({ h: 0, s: 0, l: 0 });

    expect(lit.h).toBeCloseTo(axis.h, 2);
    expect(lit.l).toBeGreaterThan(axis.l);
  });

  it('puts the axis colour on the guide line running along it', () => {
    // The line saying which way the object can go, which three draws white.
    // Blender's is the colour of the axis it lies on, and so is this.
    const gizmo = painted();

    for (const [axis, color] of [
      ['X', DEFAULT_AXES.x],
      ['Y', DEFAULT_AXES.y],
      ['Z', DEFAULT_AXES.z],
    ] as const) {
      gizmo.drag(axis);
      expect(gizmo.colorOf(axis, true)).toBe(new THREE.Color(color).getHexString());
    }
  });

  it('leaves the guides neutral when the drag is not along one axis', () => {
    // The centre handle moves on all three at once: no axis owns that line.
    const gizmo = painted();
    const white = gizmo.colorOf('X', true);

    gizmo.drag('Z');
    gizmo.drag('XYZ');

    expect(gizmo.colorOf('X', true)).toBe(white);
  });

  it('puts every colour back when the drag ends', () => {
    // The repaint runs on a live material each frame; one that only ever
    // brightened would leave the gizmo lit up long after the pointer let go.
    const gizmo = painted();
    const resting = gizmo.colorOf('Y');

    gizmo.drag('Y');
    gizmo.drag(null);

    expect(gizmo.colorOf('Y')).toBe(resting);
  });
});
