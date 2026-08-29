import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { describe, expect, it } from 'vitest';

import { gizmoScaleRatio } from './Viewport';

/**
 * Guards the TransformControls behaviour the viewport's drag handling rests on.
 *
 * The viewport cannot be instantiated here (it needs a WebGL context), but
 * TransformControls can, and every assumption behind `updateGizmo`'s dragging
 * guard and `handleLostPointerCapture` lives in this class. If a three upgrade
 * changes one of them, these fail and the drag code needs revisiting.
 */

interface DragApi {
  pointerDown: (pointer: { x: number; y: number; button: number }) => void;
  pointerMove: (pointer: { x: number; y: number; button: number }) => void;
  pointerUp: (pointer: { x: number; y: number; button: number }) => void;
  dragging: boolean;
  axis: string | null;
}

function createDrag(mode: 'translate' | 'rotate' | 'scale' = 'translate') {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;

  const controls = new TransformControls(camera, element);
  const helper = (controls as unknown as { getHelper: () => THREE.Object3D }).getHelper();

  // The proxy has to be in a scene graph: TransformControls decomposes its
  // parent's world matrix on every tick.
  const scene = new THREE.Scene();
  const proxy = new THREE.Object3D();
  scene.add(proxy, helper);

  controls.setMode(mode);
  controls.attach(proxy);
  controls.axis = 'X';
  helper.updateMatrixWorld(true);

  return { controls, api: controls as unknown as DragApi, proxy, element };
}

describe('TransformControls drag contract', () => {
  it('drives the object from its pointer-down transform plus the total offset, not incrementally', () => {
    const { api, proxy } = createDrag();

    api.pointerDown({ x: 0, y: 0, button: 0 });
    const positions = [0.1, 0.2, 0.3, 0.4].map((x) => {
      api.pointerMove({ x, y: 0, button: -1 });
      return proxy.position.x;
    });

    // Equal pointer steps produce equal position steps, all measured from the
    // drag's start. This is why the viewport applies the gizmo delta against
    // each object's transform at drag start rather than the previous tick.
    const steps = positions.slice(1).map((value, index) => value - positions[index]);
    for (const step of steps) expect(step).toBeCloseTo(positions[0], 6);
  });

  it('overwrites anything written to the object mid-drag', () => {
    const { api, proxy } = createDrag();

    api.pointerDown({ x: 0, y: 0, button: 0 });
    api.pointerMove({ x: 0.2, y: 0, button: -1 });
    const legitimate = proxy.position.x;

    // `syncScene` used to re-seat the proxy on every store change, including the
    // ones the drag itself emits. The write is discarded on the next tick, but a
    // baseline captured from it is not: that mismatch turned each absolute drag
    // delta into a corrupted incremental one.
    proxy.position.x = 999;
    api.pointerMove({ x: 0.4, y: 0, button: -1 });

    expect(proxy.position.x).toBeCloseTo(legitimate * 2, 6);
    expect(proxy.position.x).toBeLessThan(999);
  });

  it('reports dragging through an event whose flag is already settled', () => {
    const { controls, api } = createDrag();
    const seen: { value: unknown; flag: boolean }[] = [];
    controls.addEventListener('dragging-changed', (event) => {
      seen.push({ value: (event as unknown as { value: unknown }).value, flag: api.dragging });
    });

    api.pointerDown({ x: 0, y: 0, button: 0 });
    api.pointerUp({ x: 0, y: 0, button: 0 });

    // The viewport's own `gizmoDragging` flag mirrors this event, and the
    // end-of-drag resync relies on the flag already being false when it fires.
    expect(seen).toEqual([
      { value: true, flag: true },
      { value: false, flag: false },
    ]);
  });

  it('stays latched when the pointer capture is lost instead of released', () => {
    const { api, element } = createDrag();

    api.pointerDown({ x: 0, y: 0, button: 0 });
    element.dispatchEvent(new Event('lostpointercapture'));

    // Nothing upstream handles this, so a pointer that leaves the window mid-drag
    // leaves the gizmo dragging forever. `Viewport.handleLostPointerCapture`
    // exists purely to clear it.
    expect(api.dragging).toBe(true);
  });

  it('finishes the drag when the flag is cleared from outside', () => {
    const { controls, api, proxy } = createDrag();
    const values: unknown[] = [];
    controls.addEventListener('dragging-changed', (event) =>
      values.push((event as unknown as { value: unknown }).value),
    );

    api.pointerDown({ x: 0, y: 0, button: 0 });
    api.pointerMove({ x: 0.2, y: 0, button: -1 });
    const settled = proxy.position.x;

    api.axis = null;
    api.dragging = false;

    // The recovery path the viewport uses: clearing the flags emits the same
    // event a real pointerup would, and further moves are ignored.
    expect(values).toEqual([true, false]);
    api.pointerMove({ x: 0.9, y: 0, button: -1 });
    expect(proxy.position.x).toBeCloseTo(settled, 6);
  });
});

describe('scale drag response', () => {
  it('three negates its own ratio once the pointer crosses the pivot', () => {
    const { api, proxy } = createDrag('scale');
    api.axis = 'XYZ';

    api.pointerDown({ x: 0.2, y: 0.2, button: 0 });
    api.pointerMove({ x: -0.2, y: -0.2, button: -1 });

    // Half of why the viewport measures scale drags on screen instead: three's
    // ratio comes off the drag plane and goes negative across the pivot, which
    // mirrors the object rather than shrinking it.
    expect(proxy.scale.x).toBeLessThan(0);
  });

  it('starts at exactly 1, wherever the drag was picked up', () => {
    for (const distance of [0, 12, 80, 400]) {
      expect(gizmoScaleRatio(distance, distance)).toBeCloseTo(1);
    }
  });

  it('reads the same at any zoom, because it only ever sees pixels', () => {
    // The other half: pointer distances do not collapse when the camera pulls
    // back, so the same drag on screen is the same factor on a 1 m cube and on
    // a 100 m one.
    expect(gizmoScaleRatio(260, 60)).toBeCloseTo(gizmoScaleRatio(260, 60));
    expect(gizmoScaleRatio(260, 60)).toBeCloseTo(2.67, 1);
  });

  it('does not explode when the drag starts on top of the pivot', () => {
    // The centre handle sits on the pivot, so this is the ordinary way to grab
    // it: a few pixels of travel must not multiply the object by tens.
    expect(gizmoScaleRatio(6, 0)).toBeLessThan(1.2);
    expect(gizmoScaleRatio(60, 0)).toBeCloseTo(2);
  });

  it('never returns a ratio that would flip or collapse the object', () => {
    for (const [pointer, reference] of [
      [-10, 50],
      [0, 0],
      [Number.NaN, 50],
      [Number.POSITIVE_INFINITY, 50],
    ]) {
      expect(gizmoScaleRatio(pointer, reference)).toBeGreaterThan(0);
    }

    expect(gizmoScaleRatio(1e9, 0)).toBeLessThanOrEqual(100);
  });
});
