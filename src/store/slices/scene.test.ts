import { describe, expect, it } from 'vitest';

import { createModifier, vec3 } from '@kernel/index';
import type { RemeshModifier } from '@kernel/index';

import { useEditorStore } from '../useEditorStore';

import { evaluatedMesh } from './scene';

/** A fresh scene holding one box, returned as the object the store now holds. */
function boxScene() {
  const store = useEditorStore.getState();
  store.resetScene();
  store.addPrimitive('box');
  return useEditorStore.getState().objects[0];
}

function active() {
  const state = useEditorStore.getState();
  return { object: state.objects[0], version: state.meshVersion };
}

describe('evaluated display mesh', () => {
  it('hands back the base mesh untouched when the stack is empty', () => {
    const object = boxScene();
    expect(evaluatedMesh(object, vec3(), 0) === object.mesh).toBe(true);
  });

  it('runs the stack once and holds the result while nothing changes', () => {
    boxScene();
    useEditorStore.getState().addModifier('remesh');

    const { object, version } = active();
    const first = evaluatedMesh(object, vec3(), version);
    const second = evaluatedMesh(object, vec3(), version);

    // The very same mesh, not an equal one. A REMESH is the better part of a
    // second, and the viewport re-syncs on selection and shading changes that
    // touch no geometry at all — every one of those used to pay for it again.
    expect(second === first).toBe(true);
    expect(first === object.mesh).toBe(false);
  });

  it('runs it again when a modifier setting changes', () => {
    boxScene();
    useEditorStore.getState().addModifier('remesh');

    const before = active();
    const first = evaluatedMesh(before.object, vec3(), before.version);

    const modifier = before.object.modifiers[0] as RemeshModifier;
    useEditorStore.getState().updateModifier(modifier.id, { targetFaces: 400 });

    const after = active();
    const second = evaluatedMesh(after.object, vec3(), after.version);

    expect(second === first).toBe(false);
    expect(second.faces.size).not.toBe(first.faces.size);
  });

  it('runs it again when the geometry underneath moves', () => {
    boxScene();
    useEditorStore.getState().addModifier('subdivide');

    const before = active();
    const first = evaluatedMesh(before.object, vec3(), before.version);

    // The mesh is edited in place, so its identity says nothing — the version
    // is the only thing that reports a vertex has moved.
    for (const vert of before.object.mesh.verts.values())
      vert.co = { ...vert.co, x: vert.co.x * 2 };
    useEditorStore.getState().touchMesh();

    const after = active();
    const second = evaluatedMesh(after.object, vec3(), after.version);

    expect(second === first).toBe(false);
    expect(second.boundingBox().max.x).toBeGreaterThan(first.boundingBox().max.x);
  });

  it('evaluates fresh for a caller with no version to key on', () => {
    boxScene();
    useEditorStore.getState().addModifier('subdivide');

    const { object } = active();
    // Export takes this path: it must never be handed a cached result that a
    // later edit has already made stale.
    expect(evaluatedMesh(object) === evaluatedMesh(object)).toBe(false);
  });

  it('keeps the base mesh out of the stack it feeds', () => {
    boxScene();
    useEditorStore.getState().addModifier('remesh');

    const { object, version } = active();
    const display = evaluatedMesh(object, vec3(), version);

    expect(display.faces.size).toBeGreaterThan(6);
    expect(object.mesh.faces.size).toBe(6);
  });

  it('adds a remesh through the store with its defaults ready to tweak', () => {
    const defaults = createModifier('remesh') as RemeshModifier;

    expect(defaults.method).toBe('voxel');
    expect(defaults.adaptive).toBe(true);
    expect(defaults.targetFaces).toBeGreaterThan(0);
  });
});
