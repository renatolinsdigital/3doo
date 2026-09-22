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
    // touch no geometry at all, and every one of those used to pay for it again.
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

    // The mesh is edited in place, so its identity says nothing: the version
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

describe('material slots', () => {
  /** A box with three slots, its six faces spread across all of them. */
  function threeSlotBox() {
    const store = useEditorStore.getState();
    store.resetScene();
    store.addPrimitive('box');
    store.addMaterial();
    store.addMaterial();

    const object = useEditorStore.getState().objects[0];
    const faces = [...object.mesh.faces.values()];
    faces[0].materialIndex = 0;
    faces[1].materialIndex = 1;
    faces[2].materialIndex = 1;
    faces[3].materialIndex = 2;
    faces[4].materialIndex = 2;
    faces[5].materialIndex = 2;
    return object;
  }

  const indices = () =>
    [...useEditorStore.getState().objects[0].mesh.faces.values()].map((face) => face.materialIndex);

  it('renames a slot in place, leaving the faces alone', () => {
    threeSlotBox();
    useEditorStore.getState().updateMaterial(1, { name: 'CHROME' });

    expect(useEditorStore.getState().objects[0].materials[1].name).toBe('CHROME');
    expect(indices()).toEqual([0, 1, 1, 2, 2, 2]);
  });

  it('renumbers the faces past the slot it removes', () => {
    threeSlotBox();
    useEditorStore.getState().removeMaterial(1);

    // Slot 2 slid down into 1, so the faces wearing it follow; the two that
    // wore the deleted slot fall back to the first.
    expect(useEditorStore.getState().objects[0].materials).toHaveLength(2);
    expect(indices()).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('leaves every face pointing at a slot that exists', () => {
    threeSlotBox();
    useEditorStore.getState().removeMaterial(0);

    const object = useEditorStore.getState().objects[0];
    for (const index of indices()) {
      expect(object.materials[index]).toBeDefined();
    }
  });

  it('pulls the active slot back when the one it named goes', () => {
    threeSlotBox();
    useEditorStore.getState().setActiveMaterial(2);
    useEditorStore.getState().removeMaterial(2);

    expect(useEditorStore.getState().objects[0].activeMaterial).toBe(1);
  });

  it('takes the last slot, leaving an object with none', () => {
    const store = useEditorStore.getState();
    store.resetScene();
    store.addPrimitive('box');
    store.removeMaterial(0);

    const object = useEditorStore.getState().objects[0];
    expect(object.materials).toEqual([]);
    expect(object.activeMaterial).toBe(0);
  });

  it('is undoable', () => {
    threeSlotBox();
    useEditorStore.getState().removeMaterial(1);
    useEditorStore.getState().undo();

    expect(useEditorStore.getState().objects[0].materials).toHaveLength(3);
    expect(indices()).toEqual([0, 1, 1, 2, 2, 2]);
  });

  it('ignores a slot that is not there', () => {
    threeSlotBox();
    useEditorStore.getState().removeMaterial(7);

    expect(useEditorStore.getState().objects[0].materials).toHaveLength(3);
  });
});

describe('booleans against an unapplied modifier stack', () => {
  /** A box and a sphere, both selected, the box keeping the result. */
  function pair() {
    const store = useEditorStore.getState();
    store.resetScene();
    // Toasts outlive a scene reset, and these tests are counting them.
    useEditorStore.setState({ toasts: [] });
    store.addPrimitive('box');
    store.addPrimitive('uvSphere');

    const [box, sphere] = useEditorStore.getState().objects;
    useEditorStore.getState().setActiveObject(sphere.id);
    useEditorStore.getState().setActiveObject(box.id, true);
    return { box, sphere };
  }

  const names = () => useEditorStore.getState().objects.map((object) => object.name);

  it('refuses while the active object still has a live stack', async () => {
    const { box } = pair();
    useEditorStore.getState().setActiveObject(box.id, true);
    useEditorStore.getState().addModifier('subdivide');

    await useEditorStore.getState().booleanWithSelected('union');

    // Nothing consumed, and the mesh it would have cut is untouched.
    expect(names()).toEqual(['BOX', 'UV SPHERE']);
    expect(useEditorStore.getState().objects[0].mesh.faces.size).toBe(box.mesh.faces.size);
  });

  it('refuses when it is the cutter carrying the stack', async () => {
    const { box, sphere } = pair();
    useEditorStore.getState().setActiveObject(sphere.id);
    useEditorStore.getState().addModifier('subdivide');
    useEditorStore.getState().setActiveObject(box.id);
    useEditorStore.getState().setActiveObject(sphere.id, true);

    await useEditorStore.getState().booleanWithSelected('difference');

    expect(names()).toEqual(['BOX', 'UV SPHERE']);
  });

  it('says which object is holding it up, and says it as a toast', async () => {
    const { box } = pair();
    useEditorStore.getState().setActiveObject(box.id, true);
    useEditorStore.getState().addModifier('subdivide');

    await useEditorStore.getState().booleanWithSelected('union');

    const toasts = useEditorStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('error');
    expect(toasts[0].message).toMatch(/BOX/);
    expect(toasts[0].message).toMatch(/modifiers/i);
  });

  it('lets a disabled modifier through, since it changes nothing on screen', async () => {
    const { box } = pair();
    useEditorStore.getState().setActiveObject(box.id, true);
    useEditorStore.getState().addModifier('subdivide');

    const modifier = useEditorStore.getState().objects[0].modifiers[0];
    useEditorStore.getState().updateModifier(modifier.id, { enabled: false });

    await useEditorStore.getState().booleanWithSelected('union');

    expect(names()).toEqual(['BOX']);
    expect(useEditorStore.getState().toasts).toHaveLength(0);
  });

  it('goes ahead once the stack has been applied', async () => {
    const { box } = pair();
    useEditorStore.getState().setActiveObject(box.id, true);
    useEditorStore.getState().addModifier('subdivide');

    const modifier = useEditorStore.getState().objects[0].modifiers[0];
    useEditorStore.getState().applyModifierToMesh(modifier.id);
    await useEditorStore.getState().booleanWithSelected('union');

    // The cutter is consumed, so one object is left holding the result.
    expect(names()).toEqual(['BOX']);
    expect(useEditorStore.getState().toasts).toHaveLength(0);
  });
});

describe('cursor snaps', () => {
  /** What the pointer resolved, with only `kind` found. */
  function found(kind: 'point' | 'vertex' | 'edge' | 'face', at = vec3(1, 2, 3)) {
    return { point: null, vertex: null, edge: null, face: null, [kind]: at };
  }

  it('puts the cursor on what the pointer found', () => {
    const store = useEditorStore.getState();
    store.resetScene();

    store.snapCursor('vertex', found('vertex'));

    expect(useEditorStore.getState().cursor).toEqual(vec3(1, 2, 3));
    expect(useEditorStore.getState().status).toBe('Cursor to vertex');
  });

  it('leaves the cursor alone and names what the pointer missed', () => {
    const store = useEditorStore.getState();
    store.resetScene();
    store.setCursor(vec3(0, 1, 0));

    // A face was found, an edge was not: the entry asked for is the one that
    // decides, not whatever else the same pass turned up.
    store.snapCursor('edge', found('face'));

    expect(useEditorStore.getState().cursor).toEqual(vec3(0, 1, 0));
    expect(useEditorStore.getState().status).toBe('No edge close enough to the pointer');
  });

  it('says the pointer is not in the viewport, which only a key can manage', () => {
    const store = useEditorStore.getState();
    store.resetScene();

    store.snapCursor('point', null);

    expect(useEditorStore.getState().status).toContain('pointer into the viewport');
  });
});
