import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { bevelEdges, cloneMesh, createBox } from '@kernel/index';

import { axisAmount, offsetAmount } from './Viewport';

describe('offsetAmount', () => {
  it('opens at nothing, wherever the pointer was when the key was pressed', () => {
    // The distance is measured from the start of the drag rather than from the
    // selection, so pressing I with the pointer across the viewport does not
    // begin with the faces already shrunk to nothing.
    for (const reference of [0, 40, 400]) {
      expect(offsetAmount(reference, reference, 0.01)).toBe(0);
    }
  });

  it('grows a bevel as the pointer is pulled away from the selection', () => {
    expect(offsetAmount(140, 40, 0.01)).toBeCloseTo(1);
    expect(offsetAmount(240, 40, 0.01)).toBeCloseTo(2);
  });

  it('grows an inset as the pointer is pushed in toward the selection', () => {
    // The other way round from a bevel, as in Blender: the border ring closes
    // in behind the pointer rather than following it out.
    expect(offsetAmount(140, 240, 0.01, -1)).toBeCloseTo(1);
    expect(offsetAmount(40, 240, 0.01, -1)).toBeCloseTo(2);
  });

  it('closes back to nothing rather than turning inside out', () => {
    // A negative width is a chamfer cut the wrong way, and a negative inset
    // pushes the border out through the face beside it.
    expect(offsetAmount(10, 40, 0.01)).toBe(0);
    expect(offsetAmount(240, 40, 0.01, -1)).toBe(0);
  });

  it('carries the object scale, so the same travel reads the same on screen', () => {
    // The rate is world units per pixel divided by the object's own scale: a
    // model built ten times the size takes a tenth of the object-space width
    // to cover the same pixels.
    expect(offsetAmount(140, 40, 0.01 / 10)).toBeCloseTo(0.1);
  });

  it('answers nothing rather than a width no operator could use', () => {
    expect(offsetAmount(140, 40, Number.NaN)).toBe(0);
    expect(offsetAmount(Number.POSITIVE_INFINITY, 40, 0.01)).toBe(0);
  });
});

describe('axisAmount', () => {
  const travel = (x: number, y: number) => new THREE.Vector2(x, y);
  const along = travel(1, 0);

  it('counts the travel that runs along the axis and ignores the rest', () => {
    // The pointer is free to wander off the line an extrude runs on: what it
    // asks for is how far along that line it has come, not how far it has gone.
    expect(axisAmount(travel(100, 0), along, 0.01)).toBeCloseTo(1);
    expect(axisAmount(travel(100, 400), along, 0.01)).toBeCloseTo(1);
    expect(axisAmount(travel(0, 400), along, 0.01)).toBe(0);
  });

  it('goes negative when the drag comes back past its start', () => {
    // Unlike a bevel or an inset: an extrude pulled the other way sinks the
    // region into the surface, which is a shape worth being able to reach.
    expect(axisAmount(travel(-100, 0), along, 0.01)).toBeCloseTo(-1);
  });

  it('falls back to the vertical when the axis points back at the camera', () => {
    // Nose on, the axis is a dot on screen with no direction to measure along.
    // Canvas y grows downward, so a drag upward is the one that pulls out.
    expect(axisAmount(travel(0, -100), null, 0.01)).toBeCloseTo(1);
    expect(axisAmount(travel(0, 100), null, 0.01)).toBeCloseTo(-1);
  });

  it('answers nothing rather than a distance no operator could use', () => {
    expect(axisAmount(travel(100, 0), along, Number.NaN)).toBe(0);
  });
});

/**
 * What a live preview rests on.
 *
 * The viewport cannot be instantiated here (it needs a WebGL context), but the
 * assumption behind `previewOffset` can be checked without it: a bevel cannot
 * be walked wider, so every pointer move runs the operator again on a copy of
 * the mesh as it stood at the keypress. That only works while the copy carries
 * the selection and the mesh it came from survives the run.
 */
describe('re-running an operator from a copy', () => {
  function selectedBox() {
    const mesh = createBox(2);
    for (const edge of mesh.edges.values()) edge.selected = true;
    mesh.flushSelection('edge');
    return mesh;
  }

  it('carries the selection into the copy', () => {
    // A copy that arrived deselected would chamfer nothing at all, and the
    // preview would show the bare mesh however far the pointer was dragged.
    const mesh = selectedBox();

    expect(cloneMesh(mesh).selectedEdges()).toHaveLength(mesh.selectedEdges().length);
  });

  it('leaves the mesh it copied from untouched, so the next move starts clean', () => {
    const original = selectedBox();
    const faces = original.faces.size;
    const edges = original.selectedEdges().length;

    const copy = cloneMesh(original);
    bevelEdges(copy, copy.selectedEdges(), { width: 0.3 });

    expect(copy.faces.size).toBeGreaterThan(faces);
    expect(original.faces.size).toBe(faces);
    expect(original.selectedEdges()).toHaveLength(edges);
  });

  it('answers the same shape at a width whatever widths came before it', () => {
    const original = selectedBox();
    const bevelled = (width: number) => {
      const copy = cloneMesh(original);
      bevelEdges(copy, copy.selectedEdges(), { width });
      return copy.faces.size;
    };

    const first = bevelled(0.1);
    bevelled(0.05);
    bevelled(0.3);

    // The drag walked out and came back: what is on screen is the width the
    // pointer is at now, not everything it passed through on the way.
    expect(bevelled(0.1)).toBe(first);
  });
});
