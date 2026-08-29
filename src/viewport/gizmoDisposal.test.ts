import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { describe, expect, it } from 'vitest';

/**
 * Guards the assumptions behind `Viewport.disposeGizmo`.
 *
 * TransformControls cannot be released through its own dispose() in this three
 * version, so the viewport disconnects it and frees the helper by hand. If
 * either assumption changes, these tests fail and the workaround can go.
 */
function createControls(): TransformControls {
  return new TransformControls(new THREE.PerspectiveCamera(), document.createElement('div'));
}

describe('TransformControls disposal', () => {
  it('is not an Object3D, so it cannot traverse itself', () => {
    const controls = createControls();
    expect(controls).not.toBeInstanceOf(THREE.Object3D);
    expect((controls as unknown as { traverse?: unknown }).traverse).toBeUndefined();
  });

  it('throws from its own dispose(), the bug the viewport works around', () => {
    const controls = createControls();
    expect(() => controls.dispose()).toThrow(/traverse is not a function/);
  });

  it('exposes the disconnect() and getHelper() the workaround uses instead', () => {
    const controls = createControls();
    const api = controls as unknown as {
      disconnect?: () => void;
      getHelper?: () => THREE.Object3D;
    };

    expect(typeof api.disconnect).toBe('function');
    expect(typeof api.getHelper).toBe('function');

    const helper = api.getHelper?.();
    expect(helper).toBeInstanceOf(THREE.Object3D);
    expect(() => {
      api.disconnect?.();
      helper?.traverse(() => {});
    }).not.toThrow();
  });
});
