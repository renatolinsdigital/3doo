import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { evaluatedMesh, useEditorStore } from '@store/index';
import type { SceneObject, ViewportSettings } from '@store/types';

import { ObjectView } from './ObjectView';

function scene(): { object: SceneObject; settings: ViewportSettings } {
  const store = useEditorStore.getState();
  store.resetScene();
  store.addPrimitive('box');
  const state = useEditorStore.getState();
  const object = state.objects[0];
  return {
    object,
    settings: {
      shading: state.shading,
      backfaceCulling: state.backfaceCulling,
      orthographic: state.orthographic,
      focalLength: state.focalLength,
      clipStart: state.clipStart,
      clipEnd: state.clipEnd,
      navigation: state.navigation,
      overlays: state.overlays,
    },
  };
}

function surfaceMaterial(view: ObjectView, id: string): THREE.Material | THREE.Material[] {
  const solid = view.group.getObjectByName(`${id}:solid`) as THREE.Mesh;
  return solid.material;
}

describe('ObjectView', () => {
  it('keeps its surface materials across an unchanged redraw', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    const state = {
      mode: 'object' as const,
      selectMode: 'vertex' as const,
      isActive: true,
      isSelected: true,
      settings,
    };

    view.update(object, evaluatedMesh(object), state);
    const first = surfaceMaterial(view, object.id);

    // A gizmo drag redraws on every pointer move. Rebuilding the materials
    // there disposes the shader program with them and the next frame has to
    // compile it again, which is what made a drag stutter.
    view.update(object, evaluatedMesh(object), state);
    expect(surfaceMaterial(view, object.id)).toBe(first);
  });

  it('rebuilds them when the shading mode changes', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    const state = {
      mode: 'object' as const,
      selectMode: 'vertex' as const,
      isActive: true,
      isSelected: true,
      settings,
    };

    view.update(object, evaluatedMesh(object), state);
    const first = surfaceMaterial(view, object.id);

    view.update(object, evaluatedMesh(object), {
      ...state,
      settings: { ...settings, shading: 'solid' },
    });

    expect(surfaceMaterial(view, object.id)).not.toBe(first);
  });
});
