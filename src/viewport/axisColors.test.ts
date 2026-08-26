import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { describe, expect, it } from 'vitest';

import { AXIS_COLORS, VIEWPORT_COLORS } from '@bridge/index';

import { ViewportGrid } from './grid';
import { paintGizmoAxes } from './Viewport';

/** Every gizmo handle colour after the repaint, keyed by the handles sharing it. */
function gizmoColors(): Map<string, string[]> {
  const controls = new TransformControls(
    new THREE.PerspectiveCamera(),
    document.createElement('div'),
  );
  const helper = (controls as unknown as { getHelper: () => THREE.Object3D }).getHelper();
  paintGizmoAxes(helper);

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
