import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { bevelEdges, cloneMesh, createBox } from '@kernel/index';

import { axisAmount, inwardDirection, offsetAmount } from './Viewport';

const at = (x: number, y: number) => new THREE.Vector2(x, y);

describe('inwardDirection', () => {
  it('points from the pointer at the selection', () => {
    const inward = inwardDirection(at(100, 200), at(300, 200));

    expect(inward?.x).toBeCloseTo(1);
    expect(inward?.y).toBeCloseTo(0);
  });

  it('comes back a unit vector, so travel along it reads in pixels', () => {
    expect(inwardDirection(at(0, 0), at(300, 400))?.length()).toBeCloseTo(1);
  });

  it('answers nothing when the pointer is already sitting on the selection', () => {
    // The direction is fixed for the whole drag, and one read off four pixels
    // would pin it to a line picked out of noise.
    expect(inwardDirection(at(100, 200), at(102, 203))).toBeNull();
  });
});

describe('axisAmount', () => {
  const along = at(1, 0);

  it('counts the travel that runs along the line and ignores the rest', () => {
    // The pointer is free to wander off the line: what it asks for is how far
    // along that line it has come, not how far it has gone.
    expect(axisAmount(at(100, 0), along, 0.01)).toBeCloseTo(1);
    expect(axisAmount(at(100, 400), along, 0.01)).toBeCloseTo(1);
    expect(axisAmount(at(0, 400), along, 0.01)).toBe(0);
  });

  it('goes negative when the drag comes back past its start', () => {
    expect(axisAmount(at(-100, 0), along, 0.01)).toBeCloseTo(-1);
  });

  it('falls back to the vertical when there is no line to measure along', () => {
    // An extrude nose-on to the camera, or a drag that began on top of the
    // selection. Canvas y grows downward, so a drag upward is the one that
    // reads as pulling out.
    expect(axisAmount(at(0, -100), null, 0.01)).toBeCloseTo(1);
    expect(axisAmount(at(0, 100), null, 0.01)).toBeCloseTo(-1);
  });

  it('answers nothing rather than a distance no operator could use', () => {
    expect(axisAmount(at(100, 0), along, Number.NaN)).toBe(0);
    expect(axisAmount(at(Number.POSITIVE_INFINITY, 0), along, 0.01)).toBe(0);
  });
});

describe('offsetAmount', () => {
  /** The selection lies off to the right of where the drag began. */
  const inward = at(1, 0);

  it('opens at nothing, wherever the pointer was when the key was pressed', () => {
    // The travel is measured from the start of the drag rather than from the
    // selection, so pressing I with the pointer across the viewport does not
    // begin with the faces already shrunk to nothing.
    for (const kind of ['bevel', 'inset', 'extrude'] as const) {
      expect(offsetAmount(kind, at(0, 0), inward, 0.01)).toBe(0);
    }
  });

  it('opens a bevel and an inset as the pointer is pushed in toward the selection', () => {
    // One gesture for the pair: push in toward the geometry being cut.
    expect(offsetAmount('bevel', at(100, 0), inward, 0.01)).toBeCloseTo(1);
    expect(offsetAmount('inset', at(200, 0), inward, 0.01)).toBeCloseTo(2);
  });

  it('goes on opening once the pointer has swept past the selection', () => {
    // Travel along the way in, not distance from the selection: a pointer that
    // has crossed the middle has not started closing the cut again, which is
    // what a radius would have it do.
    expect(offsetAmount('inset', at(400, 0), inward, 0.01)).toBeCloseTo(4);
  });

  it('closes a bevel or an inset back to nothing rather than turning it inside out', () => {
    // A negative width is a chamfer cut backward, and a negative inset pushes
    // the border out through the face beside it.
    expect(offsetAmount('bevel', at(-100, 0), inward, 0.01)).toBe(0);
    expect(offsetAmount('inset', at(-100, 0), inward, 0.01)).toBe(0);
  });

  it('lets an extrude through to the other side of zero', () => {
    // Where the region sinks into the surface instead of rising off it.
    expect(offsetAmount('extrude', at(-100, 0), inward, 0.01)).toBeCloseTo(-1);
  });

  it('carries the object scale, so the same travel reads the same on screen', () => {
    // The rate is world units per pixel divided by the object's own scale: a
    // model built ten times the size takes a tenth of the object-space width
    // to cover the same pixels.
    expect(offsetAmount('bevel', at(100, 0), inward, 0.01 / 10)).toBeCloseTo(0.1);
  });

  it('answers nothing rather than a width no operator could use', () => {
    expect(offsetAmount('bevel', at(100, 0), inward, Number.NaN)).toBe(0);
    expect(offsetAmount('extrude', at(Number.POSITIVE_INFINITY, 0), inward, 0.01)).toBe(0);
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
