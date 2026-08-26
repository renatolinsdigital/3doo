import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { describe, expect, it } from 'vitest';

import { trimGizmoGuides } from './Viewport';

const AXIS_GUIDES = ['X', 'Y', 'Z'];
const DELTA_GUIDES = ['START', 'END', 'DELTA'];

/**
 * A control with the guide trimming installed, plus a way to read back what the
 * guides do for a given drag axis.
 */
function guarded() {
  const controls = new TransformControls(
    new THREE.PerspectiveCamera(),
    document.createElement('div'),
  );
  const helper = (controls as unknown as { getHelper: () => THREE.Object3D }).getHelper();
  trimGizmoGuides(helper, controls);

  const drag = (axis: string | null) => {
    (controls as unknown as { axis: string | null }).axis = axis;
    (controls as unknown as { dragging: boolean }).dragging = axis !== null;
    helper.updateMatrixWorld(true);

    const shown: Record<string, boolean> = {};
    helper.traverse((child) => {
      const tagged = child as THREE.Object3D & { tag?: string };
      if (tagged.tag !== 'helper') return;
      if (![...AXIS_GUIDES, ...DELTA_GUIDES].includes(child.name)) return;
      // Several modes each contribute a set; visible anywhere counts as shown.
      shown[child.name] = (shown[child.name] ?? false) || child.visible;
    });

    return {
      axisLines: AXIS_GUIDES.some((name) => shown[name]),
      deltaLine: DELTA_GUIDES.some((name) => shown[name]),
      shown,
    };
  };

  return { drag };
}

describe('gizmo guide lines', () => {
  it('keeps both on a drag locked to one axis', () => {
    // The axis line is the track the object is confined to and the delta reads
    // along it — the one case where every part of the narration earns its keep.
    for (const axis of AXIS_GUIDES) {
      const guides = guarded().drag(axis);
      expect(guides.shown[axis]).toBe(true);
      expect(guides.deltaLine).toBe(true);
    }
  });

  it('drops both on a plane handle, which is constrained but not to a line', () => {
    for (const plane of ['XY', 'YZ', 'XZ']) {
      const guides = guarded().drag(plane);
      expect(guides.axisLines).toBe(false);
      expect(guides.deltaLine).toBe(false);
    }
  });

  it('keeps the delta on the centre handle, where nothing else reports the move', () => {
    // Clicking the middle drags on all three at once. Three infinite lines
    // through the model say nothing about where it can go, but how far it has
    // come from its starting point is exactly what there is to know.
    const guides = guarded().drag('XYZ');

    expect(guides.axisLines).toBe(false);
    expect(guides.deltaLine).toBe(true);
  });

  it('counts distinct axes, so a repeated letter is not a second one', () => {
    // Scale's corner handles come through as 'XYZX' and the like.
    expect(guarded().drag('XYZX').axisLines).toBe(false);
  });

  it('does not make the hiding stick once the drag is single-axis again', () => {
    // The wrapper only ever hides; showing is left to the control, which
    // recomputes from scratch each frame. A latched `visible = false` would
    // cost the guide on every later drag.
    const control = guarded();

    expect(control.drag('XZ').shown.X).toBe(false);
    expect(control.drag('X').shown.X).toBe(true);
  });
});
