import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { describe, expect, it } from 'vitest';

import { AXIS_COLORS, VIEWPORT_COLORS } from '@bridge/index';

import { ViewportGrid } from './grid';
import { paintGizmoAxes } from './Viewport';

/** A painted gizmo, plus a way to put it mid-drag and read a colour back. */
function painted() {
  const controls = new TransformControls(
    new THREE.PerspectiveCamera(),
    document.createElement('div'),
  );
  const helper = (controls as unknown as { getHelper: () => THREE.Object3D }).getHelper();
  paintGizmoAxes(helper, controls);

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
      const material = (child as Partial<THREE.Mesh>).material as
        (THREE.Material & { color?: THREE.Color }) | undefined;
      if (material?.color) hex = material.color.getHexString();
    });
    return hex;
  };

  return { controls, helper, drag, colorOf };
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
  const axes = grid.group.children[2] as THREE.LineSegments;
  const colors = axes.geometry.getAttribute('color');
  return new THREE.Color(
    colors.getX(vertex),
    colors.getY(vertex),
    colors.getZ(vertex),
  ).getHexString();
}

describe('axis colours', () => {
  it('is one reddish, one yellowish and one bluish hue from the palette', () => {
    expect(AXIS_COLORS.x).toBe(VIEWPORT_COLORS.red);
    expect(AXIS_COLORS.y).toBe(VIEWPORT_COLORS.amber);
    expect(AXIS_COLORS.z).toBe(VIEWPORT_COLORS.cyan);
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
    expect(colors.get(new THREE.Color(AXIS_COLORS.x).getHexString())).toEqual(['X', 'YZ']);
    expect(colors.get(new THREE.Color(AXIS_COLORS.y).getHexString())).toEqual(['Y', 'XZ']);
    expect(colors.get(new THREE.Color(AXIS_COLORS.z).getHexString())).toEqual(['Z', 'XY']);
  });

  it('gives the world centre lines the very same values', () => {
    const grid = new ViewportGrid();

    // The point of the exercise: an axis reads the same whether you are looking
    // at the line through the world or the handle on the object.
    expect(axisLineColor(grid, 0)).toBe(new THREE.Color(AXIS_COLORS.x).getHexString());
    expect(axisLineColor(grid, 2)).toBe(new THREE.Color(AXIS_COLORS.z).getHexString());
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
    const axis = new THREE.Color(AXIS_COLORS.x).getHSL({ h: 0, s: 0, l: 0 });

    expect(lit.h).toBeCloseTo(axis.h, 2);
    expect(lit.l).toBeGreaterThan(axis.l);
  });

  it('puts the axis colour on the guide line running along it', () => {
    // The line saying which way the object can go, which three draws white.
    // Blender's is the colour of the axis it lies on, and so is this.
    const gizmo = painted();

    for (const [axis, color] of [
      ['X', AXIS_COLORS.x],
      ['Y', AXIS_COLORS.y],
      ['Z', AXIS_COLORS.z],
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
