import * as THREE from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { describe, expect, it } from 'vitest';

import { vec3 } from '@kernel/index';
import { DEFAULT_PREFERENCES, evaluatedMesh, useEditorStore } from '@store/index';
import type { SceneObject, ViewportSettings } from '@store/types';

import { ObjectView } from './ObjectView';

const SELECTION_LINE = {
  color: DEFAULT_PREFERENCES.selectionLineColor,
  width: DEFAULT_PREFERENCES.selectionLineWidth,
};

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
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
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
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
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

describe('ObjectView selection outline', () => {
  function outlineOf(view: ObjectView, id: string): LineSegments2 {
    return view.group.getObjectByName(`${id}:outline`) as LineSegments2;
  }

  function outlineMaterial(view: ObjectView, id: string): LineMaterial {
    return outlineOf(view, id).material as LineMaterial;
  }

  // The outline is instanced quads, one per segment, so the segment count is on
  // `instanceStart` — `position` holds the quad the shader expands, not the line.
  function segmentCount(line: LineSegments2): number {
    return line.geometry.getAttribute('instanceStart')?.count ?? 0;
  }

  it('traces the silhouette of a selected object, and nothing when deselected', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    const base = {
      mode: 'object' as const,
      selectMode: 'vertex' as const,
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      settings,
    };

    view.update(object, evaluatedMesh(object), base);
    const outline = outlineOf(view, object.id);

    // A cube face on: the four edges of the square it shows, not all twelve.
    expect(outline.visible).toBe(true);
    expect(segmentCount(outline)).toBe(4);

    view.update(object, evaluatedMesh(object), { ...base, isSelected: false, isActive: false });
    expect(outline.visible).toBe(false);
  });

  it('stays out of edit mode, where the wireframe and elements carry selection', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), {
      mode: 'edit',
      selectMode: 'vertex',
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      settings,
    });

    expect(outlineOf(view, object.id).visible).toBe(false);
  });

  it('marks the active object more strongly than the rest of the selection', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    const base = {
      mode: 'object' as const,
      selectMode: 'vertex' as const,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      settings,
    };

    view.update(object, evaluatedMesh(object), { ...base, isActive: true });
    const active = outlineMaterial(view, object.id).color.getHex();

    view.update(object, evaluatedMesh(object), { ...base, isActive: false });
    const selected = outlineMaterial(view, object.id).color.getHex();

    expect(active).not.toBe(selected);
  });

  it('takes its width and colour from the preference it is given', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), {
      mode: 'object',
      selectMode: 'vertex',
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: { color: '#3de0d0', width: 5 },
      settings,
    });

    const material = outlineMaterial(view, object.id);
    expect(material.linewidth).toBe(5);
    expect(material.color.getHexString()).toBe('3de0d0');
  });

  it('sizes the line against the viewport, which the shader cannot know on its own', () => {
    const { object } = scene();
    const view = new ObjectView(object.id);

    view.setResolution(1280, 720);

    expect(outlineMaterial(view, object.id).resolution.toArray()).toEqual([1280, 720]);
  });

  it('re-traces from a new camera position without a rebuild', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), {
      mode: 'object',
      selectMode: 'vertex',
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      settings,
    });
    expect(segmentCount(outlineOf(view, object.id))).toBe(4);

    // Orbiting to a corner puts six edges on the silhouette; nothing in the
    // scene changed, so only this path can pick that up.
    view.refreshOutline(vec3(10, 10, 10));

    expect(segmentCount(outlineOf(view, object.id))).toBe(6);
  });
});
