import { afterEach, describe, expect, it, vi } from 'vitest';

import { type BMesh, type Vec3, createBox, createModifier, vec3 } from '@kernel/index';
import type { ImportedObject, LatticeModifier, RemeshModifier } from '@kernel/index';

import type { SceneObject } from '../types';
import { useEditorStore } from '../useEditorStore';

import { evaluatedMesh } from './scene';

/** A fresh scene holding one box, returned as the object the store now holds. */
function boxScene() {
  const store = useEditorStore.getState();
  store.resetScene();
  store.addPrimitive('cube');
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
    store.addPrimitive('cube');
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
    store.addPrimitive('cube');
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
    store.addPrimitive('cube');
    store.addPrimitive('uvSphere');

    const [box, sphere] = useEditorStore.getState().objects;
    useEditorStore.getState().setActiveObject(sphere.id);
    useEditorStore.getState().setActiveObject(box.id, 'add');
    return { box, sphere };
  }

  const names = () => useEditorStore.getState().objects.map((object) => object.name);

  it('refuses while the active object still has a live stack', async () => {
    const { box } = pair();
    useEditorStore.getState().setActiveObject(box.id, 'add');
    useEditorStore.getState().addModifier('subdivide');

    await useEditorStore.getState().booleanWithSelected('union');

    // Nothing consumed, and the mesh it would have cut is untouched.
    expect(names()).toEqual(['CUBE', 'UV SPHERE']);
    expect(useEditorStore.getState().objects[0].mesh.faces.size).toBe(box.mesh.faces.size);
  });

  it('refuses when it is the cutter carrying the stack', async () => {
    const { box, sphere } = pair();
    useEditorStore.getState().setActiveObject(sphere.id);
    useEditorStore.getState().addModifier('subdivide');
    useEditorStore.getState().setActiveObject(box.id);
    useEditorStore.getState().setActiveObject(sphere.id, 'add');

    await useEditorStore.getState().booleanWithSelected('difference');

    expect(names()).toEqual(['CUBE', 'UV SPHERE']);
  });

  it('says which object is holding it up, and says it as a toast', async () => {
    const { box } = pair();
    useEditorStore.getState().setActiveObject(box.id, 'add');
    useEditorStore.getState().addModifier('subdivide');

    await useEditorStore.getState().booleanWithSelected('union');

    const toasts = useEditorStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('error');
    expect(toasts[0].message).toMatch(/CUBE/);
    expect(toasts[0].message).toMatch(/modifiers/i);
  });

  it('lets a disabled modifier through, since it changes nothing on screen', async () => {
    const { box } = pair();
    useEditorStore.getState().setActiveObject(box.id, 'add');
    useEditorStore.getState().addModifier('subdivide');

    const modifier = useEditorStore.getState().objects[0].modifiers[0];
    useEditorStore.getState().updateModifier(modifier.id, { enabled: false });

    await useEditorStore.getState().booleanWithSelected('union');

    expect(names()).toEqual(['CUBE']);
    expect(useEditorStore.getState().toasts).toHaveLength(0);
  });

  it('goes ahead once the stack has been applied', async () => {
    const { box } = pair();
    useEditorStore.getState().setActiveObject(box.id, 'add');
    useEditorStore.getState().addModifier('subdivide');

    const modifier = useEditorStore.getState().objects[0].modifiers[0];
    useEditorStore.getState().applyModifierToMesh(modifier.id);
    await useEditorStore.getState().booleanWithSelected('union');

    // The cutter is consumed, so one object is left holding the result.
    expect(names()).toEqual(['CUBE']);
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

describe('outliner groups', () => {
  /** A fresh scene holding a box, a cylinder and a sphere, in that order. */
  function threeObjects() {
    const store = useEditorStore.getState();
    store.resetScene();
    store.addPrimitive('cube');
    store.addPrimitive('cylinder');
    store.addPrimitive('uvSphere');
    return useEditorStore.getState().objects;
  }

  function group(index = 0) {
    return useEditorStore.getState().groups[index];
  }

  /** Puts the named objects in a folder and hands it back. */
  function groupOf(...ids: string[]) {
    useEditorStore.getState().selectObjects(ids);
    useEditorStore.getState().groupSelected();
    return useEditorStore.getState().groups[useEditorStore.getState().groups.length - 1];
  }

  it('folds the selected objects into a folder of their own', () => {
    const [box, cylinder] = threeObjects();

    const folder = groupOf(box.id, cylinder.id);

    expect(folder.name).toBe('GROUP');
    expect(useEditorStore.getState().objects.map((object) => object.groupId)).toEqual([
      folder.id,
      folder.id,
      null,
    ]);
  });

  it('names each new folder apart from the ones already there', () => {
    const [box, cylinder, sphere] = threeObjects();

    groupOf(box.id);
    groupOf(cylinder.id);
    groupOf(sphere.id);

    expect(useEditorStore.getState().groups.map((entry) => entry.name)).toEqual([
      'GROUP',
      'GROUP.2',
      'GROUP.3',
    ]);
  });

  it('says so rather than making an empty folder', () => {
    threeObjects();
    useEditorStore.getState().clearSelection();

    useEditorStore.getState().groupSelected();

    expect(useEditorStore.getState().groups).toEqual([]);
    expect(useEditorStore.getState().status).toMatch(/select the objects to group/i);
  });

  it('moves objects across when they are grouped again, dropping the folder they empty', () => {
    const [box, cylinder] = threeObjects();
    groupOf(box.id, cylinder.id);

    // The first folder still holds the cylinder, so both survive.
    groupOf(box.id);
    expect(useEditorStore.getState().groups).toHaveLength(2);

    // Now it holds nothing, and nothing can ever be put back into it.
    groupOf(cylinder.id);
    expect(useEditorStore.getState().groups.map((entry) => entry.name)).toEqual([
      'GROUP.2',
      'GROUP.3',
    ]);
  });

  it('selects everything in the folder and nothing else', () => {
    const [box, cylinder, sphere] = threeObjects();
    const folder = groupOf(box.id, cylinder.id);
    useEditorStore.getState().selectObjects([sphere.id]);

    useEditorStore.getState().selectGroup(folder.id);

    expect(useEditorStore.getState().selectedObjectIds).toEqual([box.id, cylinder.id]);
  });

  it('hides the whole folder, then shows it again', () => {
    const [box, cylinder] = threeObjects();
    const folder = groupOf(box.id, cylinder.id);

    useEditorStore.getState().toggleGroupVisibility(folder.id);
    expect(useEditorStore.getState().objects.map((object) => object.visible)).toEqual([
      false,
      false,
      true,
    ]);

    useEditorStore.getState().toggleGroupVisibility(folder.id);
    expect(useEditorStore.getState().objects.every((object) => object.visible)).toBe(true);
  });

  it('hides the rest of a folder one row of which is already hidden', () => {
    const [box, cylinder] = threeObjects();
    const folder = groupOf(box.id, cylinder.id);
    useEditorStore.getState().toggleObjectVisibility(box.id);

    useEditorStore.getState().toggleGroupVisibility(folder.id);

    // Something was still showing, so the folder had something left to hide.
    expect(useEditorStore.getState().objects.map((object) => object.visible)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('locks the whole folder, then unlocks it', () => {
    const [box, cylinder] = threeObjects();
    const folder = groupOf(box.id, cylinder.id);

    useEditorStore.getState().toggleGroupLock(folder.id);
    expect(useEditorStore.getState().objects.map((object) => object.locked)).toEqual([
      true,
      true,
      false,
    ]);

    useEditorStore.getState().toggleGroupLock(folder.id);
    expect(useEditorStore.getState().objects.some((object) => object.locked)).toBe(false);
  });

  it('deletes the folder and everything in it', () => {
    const [box, cylinder, sphere] = threeObjects();
    const folder = groupOf(box.id, cylinder.id);

    useEditorStore.getState().deleteGroup(folder.id);

    expect(useEditorStore.getState().objects.map((object) => object.id)).toEqual([sphere.id]);
    expect(useEditorStore.getState().groups).toEqual([]);
  });

  it('leaves the objects loose when the folder is dropped', () => {
    const [box, cylinder] = threeObjects();
    const folder = groupOf(box.id, cylinder.id);

    useEditorStore.getState().ungroup(folder.id);

    expect(useEditorStore.getState().objects).toHaveLength(3);
    expect(useEditorStore.getState().objects.every((object) => object.groupId === null)).toBe(true);
    expect(useEditorStore.getState().groups).toEqual([]);
  });

  it('takes one object out of the folder, leaving the rest of it alone', () => {
    const [box, cylinder] = threeObjects();
    const folder = groupOf(box.id, cylinder.id);

    useEditorStore.getState().removeFromGroup(box.id);

    expect(useEditorStore.getState().objects.map((object) => object.groupId)).toEqual([
      null,
      folder.id,
      null,
    ]);
    expect(useEditorStore.getState().groups).toHaveLength(1);
  });

  it('drops the folder once its last object leaves', () => {
    const [box] = threeObjects();
    groupOf(box.id);

    useEditorStore.getState().removeFromGroup(box.id);

    expect(useEditorStore.getState().groups).toEqual([]);
  });

  it('joins the folder into the active object, which stays in the folder', () => {
    const [box, cylinder] = threeObjects();
    const folder = groupOf(box.id, cylinder.id);
    useEditorStore.getState().setActiveObject(box.id);

    useEditorStore.getState().joinGroup(folder.id);

    const objects = useEditorStore.getState().objects;
    expect(objects).toHaveLength(2);
    expect(objects[0].id).toBe(box.id);
    // A box and a cylinder folded into one mesh: more than the box's six faces.
    expect(objects[0].mesh.faces.size).toBeGreaterThan(6);
    expect(objects[0].groupId).toBe(folder.id);
  });

  it('will not join a folder down to one unlocked object', () => {
    const [box, cylinder] = threeObjects();
    const folder = groupOf(box.id, cylinder.id);
    useEditorStore.getState().toggleObjectLock(cylinder.id);

    useEditorStore.getState().joinGroup(folder.id);

    expect(useEditorStore.getState().objects).toHaveLength(3);
    expect(useEditorStore.getState().status).toMatch(/nothing to join/i);
  });

  it('trembles the lock rather than joining a folder that is locked outright', () => {
    const [box, cylinder] = threeObjects();
    const folder = groupOf(box.id, cylinder.id);
    useEditorStore.getState().toggleGroupLock(folder.id);

    useEditorStore.getState().joinGroup(folder.id);

    expect(useEditorStore.getState().objects).toHaveLength(3);
    expect(useEditorStore.getState().lockedAttempt?.objectId).toBe(box.id);
  });

  it('drops the folder a delete empties', () => {
    const [box, cylinder] = threeObjects();
    groupOf(box.id, cylinder.id);

    useEditorStore.getState().deleteSelected([box.id, cylinder.id]);

    expect(useEditorStore.getState().groups).toEqual([]);
  });

  it('drops the folder a merge into an outside object empties', () => {
    const [box, cylinder, sphere] = threeObjects();
    groupOf(box.id, cylinder.id);

    // The sphere is loose and keeps the result, so the folder loses both of its
    // objects to it.
    useEditorStore.getState().selectObjects([box.id, cylinder.id, sphere.id]);
    useEditorStore.getState().setActiveObject(sphere.id, 'add');
    useEditorStore.getState().mergeSelected();

    expect(useEditorStore.getState().objects.map((object) => object.id)).toEqual([sphere.id]);
    expect(useEditorStore.getState().groups).toEqual([]);
  });

  it('puts the folders back on undo', () => {
    const [box, cylinder] = threeObjects();
    const folder = groupOf(box.id, cylinder.id);

    useEditorStore.getState().ungroup(folder.id);
    expect(useEditorStore.getState().groups).toEqual([]);

    useEditorStore.getState().undo();

    expect(useEditorStore.getState().groups.map((entry) => entry.name)).toEqual(['GROUP']);
    expect(
      useEditorStore.getState().objects.filter((object) => object.groupId === group().id),
    ).toHaveLength(2);
  });

  it('keeps a folded folder folded through an undo', () => {
    const [box, cylinder] = threeObjects();
    const folder = groupOf(box.id, cylinder.id);
    useEditorStore.getState().toggleGroupCollapsed(folder.id);

    useEditorStore.getState().addPrimitive('cone');
    useEditorStore.getState().undo();

    expect(group().collapsed).toBe(true);
  });

  describe('moving a row', () => {
    const names = () => useEditorStore.getState().objects.map((object) => object.name);

    it('puts a loose object in the folder it lands on, last of its rows', () => {
      const [box, cylinder, sphere] = threeObjects();
      const folder = groupOf(box.id, cylinder.id);

      useEditorStore.getState().moveObject(sphere.id, { kind: 'group', groupId: folder.id });

      expect(names()).toEqual(['CUBE', 'CYLINDER', 'UV SPHERE']);
      expect(useEditorStore.getState().objects.map((object) => object.groupId)).toEqual([
        folder.id,
        folder.id,
        folder.id,
      ]);
    });

    it('sorts the loose rows', () => {
      const [box, , sphere] = threeObjects();

      useEditorStore.getState().moveObject(sphere.id, {
        kind: 'object',
        objectId: box.id,
        after: false,
      });

      expect(names()).toEqual(['UV SPHERE', 'CUBE', 'CYLINDER']);
    });

    it('takes the object into the folder of the row it lands beside', () => {
      const [box, cylinder, sphere] = threeObjects();
      const folder = groupOf(box.id, cylinder.id);

      useEditorStore.getState().moveObject(sphere.id, {
        kind: 'object',
        objectId: box.id,
        after: true,
      });

      expect(names()).toEqual(['CUBE', 'UV SPHERE', 'CYLINDER']);
      expect(useEditorStore.getState().objects[1].groupId).toBe(folder.id);
    });

    it('leaves the object loose when it lands beside a row that is in no folder', () => {
      const [box, cylinder, sphere] = threeObjects();
      const folder = groupOf(box.id, cylinder.id);

      useEditorStore.getState().moveObject(box.id, {
        kind: 'object',
        objectId: sphere.id,
        after: true,
      });

      expect(names()).toEqual(['CYLINDER', 'UV SPHERE', 'CUBE']);
      expect(useEditorStore.getState().objects[2].groupId).toBeNull();
      expect(useEditorStore.getState().groups.map((entry) => entry.id)).toEqual([folder.id]);
    });

    it('drops the folder its last object is dragged out of', () => {
      const [box, cylinder] = threeObjects();
      groupOf(box.id);

      useEditorStore.getState().moveObject(box.id, {
        kind: 'object',
        objectId: cylinder.id,
        after: false,
      });

      expect(useEditorStore.getState().groups).toEqual([]);
    });

    it('records nothing when the row lands where it already was', () => {
      const [box, cylinder] = threeObjects();
      const before = useEditorStore.getState().historyUndo.length;

      useEditorStore.getState().moveObject(box.id, {
        kind: 'object',
        objectId: cylinder.id,
        after: false,
      });

      expect(names()).toEqual(['CUBE', 'CYLINDER', 'UV SPHERE']);
      expect(useEditorStore.getState().historyUndo).toHaveLength(before);
    });

    it('puts the order back on undo', () => {
      const [box, , sphere] = threeObjects();

      useEditorStore.getState().moveObject(sphere.id, {
        kind: 'object',
        objectId: box.id,
        after: false,
      });
      useEditorStore.getState().undo();

      expect(names()).toEqual(['CUBE', 'CYLINDER', 'UV SPHERE']);
    });
  });
});

describe('imported images', () => {
  const asset = () => ({
    id: 'asset-1',
    name: 'ref.png',
    type: 'image/png',
    width: 800,
    height: 400,
    blob: null,
  });

  it('lands at the world origin, not at the 3D cursor', () => {
    const store = useEditorStore.getState();
    store.resetScene();
    store.setCursor(vec3(3, 4, 5));

    store.addImage(asset());

    const object = useEditorStore.getState().objects[0];
    expect(object.transform.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(object.name).toBe('REF.PNG');
    expect(object.image).toEqual({ assetId: 'asset-1' });
  });

  it('is a plane the size of the picture, and an ordinary object otherwise', () => {
    const store = useEditorStore.getState();
    store.resetScene();

    store.addImage(asset());

    const object = useEditorStore.getState().objects[0];
    expect(object.mesh.faces.size).toBe(1);
    expect(object.mesh.verts.size).toBe(4);
    expect(object.primitive).toBeNull();
    expect(useEditorStore.getState().assets['asset-1']).toBeDefined();
  });

  it('keeps the asset when the object is deleted, so undo can bring it back', () => {
    const store = useEditorStore.getState();
    store.resetScene();
    store.addImage(asset());

    useEditorStore.getState().deleteSelected();
    expect(useEditorStore.getState().objects).toHaveLength(0);

    useEditorStore.getState().undo();

    const state = useEditorStore.getState();
    expect(state.objects[0].image).toEqual({ assetId: 'asset-1' });
    expect(state.assets['asset-1']).toBeDefined();
  });

  it('drops every asset with the scene', () => {
    const store = useEditorStore.getState();
    store.resetScene();
    store.addImage(asset());

    useEditorStore.getState().resetScene();

    expect(useEditorStore.getState().assets).toEqual({});
  });
});

describe('imported meshes', () => {
  const chair = (): ImportedObject[] => [
    { name: 'Seat', mesh: createBox(1), position: vec3() },
    { name: 'Leg', mesh: createBox(0.2), position: vec3(0, -1, 0) },
  ];

  it('arrives as one step to undo, named after the file', () => {
    const store = useEditorStore.getState();
    store.resetScene();
    const before = useEditorStore.getState().historyUndo.length;

    store.addImportedObjects(chair(), 'chair.fbx');

    const state = useEditorStore.getState();
    expect(state.historyUndo).toHaveLength(before + 1);
    expect(state.historyUndo[0]).toBe('Import chair.fbx');
    expect(state.status).toBe('Imported chair.fbx');

    state.undo();
    expect(useEditorStore.getState().objects).toHaveLength(0);
  });

  it('selects everything the file held, so it moves as one', () => {
    const store = useEditorStore.getState();
    store.resetScene();

    store.addImportedObjects(chair(), 'chair.fbx');

    const state = useEditorStore.getState();
    expect(state.objects.map((object) => object.name)).toEqual(['SEAT', 'LEG']);
    expect(state.selectedObjectIds).toEqual(state.objects.map((object) => object.id));
    expect(state.activeObjectId).toBe(state.objects[1].id);
    expect(state.objects.every((object) => object.primitive === null)).toBe(true);
  });

  it('lands at the 3D cursor, each object keeping its place', () => {
    const store = useEditorStore.getState();
    store.resetScene();
    store.setCursor(vec3(3, 4, 5));

    store.addImportedObjects(chair(), 'chair.fbx');

    const [seat, leg] = useEditorStore.getState().objects;
    expect(seat.transform.position).toEqual({ x: 3, y: 4, z: 5 });
    expect(leg.transform.position).toEqual({ x: 3, y: 3, z: 5 });
  });
});

describe('what counts as changing the project', () => {
  const clean = () => {
    useEditorStore.getState().resetScene();
    useEditorStore.getState().addPrimitive('cube');
    useEditorStore.getState().markSaved();
    return useEditorStore.getState().objects[0];
  };

  it('starts clean, and an empty new scene is clean too', () => {
    useEditorStore.getState().resetScene();
    expect(useEditorStore.getState().dirty).toBe(false);
  });

  it('counts a rename, which moves no geometry at all', () => {
    const object = clean();

    useEditorStore.getState().renameObject(object.id, 'LAMP POST');

    expect(useEditorStore.getState().dirty).toBe(true);
  });

  it('counts a move, a delete and a new object', () => {
    const object = clean();
    useEditorStore.getState().patchActiveObject({ transform: { ...object.transform } });
    expect(useEditorStore.getState().dirty).toBe(true);

    useEditorStore.getState().markSaved();
    useEditorStore.getState().deleteSelected();
    expect(useEditorStore.getState().dirty).toBe(true);

    useEditorStore.getState().markSaved();
    useEditorStore.getState().addPrimitive('cone');
    expect(useEditorStore.getState().dirty).toBe(true);
  });

  it('counts undo, which is a change like any other', () => {
    clean();
    useEditorStore.getState().addPrimitive('cone');
    useEditorStore.getState().markSaved();

    useEditorStore.getState().undo();

    expect(useEditorStore.getState().dirty).toBe(true);
  });

  it('does not count selecting an object, which is what looking around does', () => {
    const object = clean();

    useEditorStore.getState().setActiveObject(null);
    useEditorStore.getState().setActiveObject(object.id);

    expect(useEditorStore.getState().dirty).toBe(false);
  });

  it('does not count folding a panel away', () => {
    clean();

    useEditorStore.getState().togglePanel('OUTLINER');

    expect(useEditorStore.getState().dirty).toBe(false);
  });

  it('forgets what was stored once a write of it fails, or a new scene starts', () => {
    clean();
    useEditorStore.getState().markSaved(42);
    useEditorStore.getState().markDirty();
    expect(useEditorStore.getState().savedFingerprint).toBeNull();

    useEditorStore.getState().markSaved(42);
    useEditorStore.getState().resetScene();
    expect(useEditorStore.getState().savedFingerprint).toBeNull();
  });
});

describe('ids across page loads', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  /** The store as a page load would build it at `time`: counters back at zero. */
  async function pageLoadAt(time: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(time));
    vi.resetModules();
    return (await import('../useEditorStore')).useEditorStore;
  }

  it('never hands a new object the id of one a file brought in', async () => {
    // Saved yesterday, in a tab whose counter started where this one's does.
    const yesterday = await pageLoadAt('2026-09-25T10:00:00Z');
    yesterday.getState().addPrimitive('cone');
    const saved = yesterday.getState().snapshotDocument();

    const today = await pageLoadAt('2026-09-26T10:00:00Z');
    today.getState().loadProjectDocument(saved, true);
    today.getState().addPrimitive('cube');

    // Sharing an id, the viewport drew one mesh for both and the cone vanished.
    const ids = today.getState().objects.map((object) => object.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('never gives a new modifier the id of one the object already has', async () => {
    const yesterday = await pageLoadAt('2026-09-25T10:00:00Z');
    yesterday.getState().addPrimitive('cone');
    yesterday.getState().addModifier('mirror');
    const saved = yesterday.getState().snapshotDocument();

    const today = await pageLoadAt('2026-09-26T10:00:00Z');
    today.getState().loadProjectDocument(saved, true);
    today.getState().addModifier('mirror');

    const ids = today.getState().objects[0].modifiers.map((modifier) => modifier.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('brings back both of two objects a damaged file holds under one id', () => {
    const store = useEditorStore.getState();
    store.resetScene();
    store.addPrimitive('cone');
    store.addPrimitive('torus');
    const saved = useEditorStore.getState().snapshotDocument();
    saved.objects[1].id = saved.objects[0].id;

    useEditorStore.getState().loadProjectDocument(saved, true);

    const { objects } = useEditorStore.getState();
    expect(objects.map((object) => object.name)).toEqual(['CONE', 'TORUS']);
    expect(objects[0].id).toBe(saved.objects[0].id);
    expect(objects[1].id).not.toBe(objects[0].id);
  });
});

describe('lattice cages', () => {
  /** A box with a LATTICE on it, and the cage that came with it. */
  function latticeScene() {
    boxScene();
    useEditorStore.getState().addModifier('lattice');
    const [object, cage] = useEditorStore.getState().objects;
    return { object, cage, modifier: object.modifiers[0] as LatticeModifier };
  }

  /** What the box draws now, its stack run against the scene as it stands. */
  function shape() {
    const state = useEditorStore.getState();
    return evaluatedMesh(state.objects[0], vec3(), state.meshVersion, state.objects);
  }

  const positions = (mesh: BMesh) => [...mesh.verts.values()].map((vert) => ({ ...vert.co }));

  /** Drags the cage's top layer of points up, the way edit mode would. */
  function pullTopUp(cage: SceneObject) {
    for (const vert of cage.mesh.verts.values()) {
      if (vert.co.y > 0.4) vert.co = { ...vert.co, y: vert.co.y + 0.5 };
    }
    useEditorStore.getState().touchMesh();
  }

  function expectSamePoints(actual: readonly Vec3[], expected: readonly Vec3[]) {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((point, index) => {
      expect(point.x).toBeCloseTo(expected[index].x, 9);
      expect(point.y).toBeCloseTo(expected[index].y, 9);
      expect(point.z).toBeCloseTo(expected[index].z, 9);
    });
  }

  it('arrives with a cage fitted round the mesh, next to it in the outliner', () => {
    const { object, cage, modifier } = latticeScene();

    expect(cage.lattice).toEqual({ resolution: { x: 3, y: 3, z: 3 } });
    expect(cage.name).toBe(`${object.name}.CAGE`);
    expect(modifier.objectId).toBe(cage.id);

    // Centred on the box and reaching past it on every side.
    const box = object.mesh.boundingBox();
    expect(cage.transform.position).toEqual(object.transform.position);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(cage.transform.scale[axis]).toBeGreaterThan(box.max[axis] - box.min[axis]);
    }

    // One step, so one undo takes both away.
    useEditorStore.getState().undo();
    const after = useEditorStore.getState().objects;
    expect(after).toHaveLength(1);
    expect(after[0].modifiers).toHaveLength(0);
  });

  it('leaves the mesh alone while the cage is at rest, wherever the cage stands', () => {
    const { object, cage } = latticeScene();

    useEditorStore.getState().setObjectTransform(cage.id, { position: vec3(0.3, 0.2, 0) });

    expectSamePoints(positions(shape()), positions(object.mesh));
  });

  it('reshapes the mesh as the points of the cage move', () => {
    const { object, cage, modifier } = latticeScene();
    useEditorStore.getState().updateModifier(modifier.id, { interpolation: 'linear' });
    const before = object.mesh.boundingBox();

    pullTopUp(cage);

    const after = shape().boundingBox();
    expect(after.max.y).toBeGreaterThan(before.max.y + 0.1);
    expect(after.min.y).toBeCloseTo(before.min.y, 9);
    // The base mesh is the one edit mode works on, and it has not moved.
    expect(object.mesh.boundingBox()).toEqual(before);
  });

  it('lets the points of a cage move and refuses anything that adds or removes one', () => {
    const { cage } = latticeScene();
    const store = useEditorStore.getState();
    store.setActiveObject(cage.id);
    cage.mesh.selectAll();

    expect(store.exec('extrude', { offset: 1 })).toBeNull();
    expect(store.exec('delete', { mode: 'verts' })).toBeNull();
    expect(cage.mesh.verts.size).toBe(27);

    expect(store.exec('translate', { offset: { x: 0, y: 0.1, z: 0 } })).not.toBeNull();
    expect([...cage.mesh.verts.values()][0].co.y).toBeCloseTo(-0.4, 9);
  });

  it('keeps the shape it gives when its grid is rebuilt at another resolution', () => {
    const { cage, modifier } = latticeScene();
    useEditorStore.getState().updateModifier(modifier.id, { interpolation: 'linear' });
    // A shear: a linear pull, which any grid holds exactly.
    for (const vert of cage.mesh.verts.values()) {
      vert.co = { ...vert.co, x: vert.co.x + vert.co.y };
    }
    useEditorStore.getState().touchMesh();
    const before = positions(shape());

    useEditorStore.getState().setLatticeResolution(cage.id, { x: 5, y: 4, z: 2 });

    const rebuilt = useEditorStore.getState().objects[1];
    expect(rebuilt.lattice?.resolution).toEqual({ x: 5, y: 4, z: 2 });
    expect(rebuilt.mesh.verts.size).toBe(40);
    expectSamePoints(positions(shape()), before);
  });

  it('gives its shape back after a pass through a grid too coarse to hold it', () => {
    const { cage } = latticeScene();
    // The middle layer alone: a 2 point axis keeps only the ends, so it drops this.
    for (const vert of cage.mesh.verts.values()) {
      if (Math.abs(vert.co.y) < 0.1) vert.co = { ...vert.co, x: vert.co.x * 1.5 };
    }
    useEditorStore.getState().touchMesh();
    const shaped = positions(cage.mesh);
    const before = positions(shape());

    const store = useEditorStore.getState();
    store.setLatticeResolution(cage.id, { x: 3, y: 2, z: 3 });
    store.setLatticeResolution(cage.id, { x: 3, y: 10, z: 3 });
    // Through a save and undo's snapshot too, which is where the memory lives.
    store.loadProjectDocument(store.snapshotDocument());
    store.setLatticeResolution(cage.id, { x: 3, y: 3, z: 3 });

    expect(positions(useEditorStore.getState().objects[1].mesh)).toEqual(shaped);
    expectSamePoints(positions(shape()), before);
  });

  it('remembers the grid as it stands once a point is moved by hand', () => {
    const { cage } = latticeScene();
    pullTopUp(cage);
    const store = useEditorStore.getState();
    store.setLatticeResolution(cage.id, { x: 3, y: 5, z: 3 });

    const fine = useEditorStore.getState().objects[1];
    const [first] = fine.mesh.verts.values();
    first.co = { ...first.co, x: first.co.x - 0.2 };
    store.touchMesh();
    const shaped = positions(fine.mesh);

    store.setLatticeResolution(cage.id, { x: 3, y: 2, z: 3 });
    store.setLatticeResolution(cage.id, { x: 3, y: 5, z: 3 });

    expect(positions(useEditorStore.getState().objects[1].mesh)).toEqual(shaped);
  });

  it('forgets its shape when reset, even on a grid too coarse to show it', () => {
    const { object, cage } = latticeScene();
    for (const vert of cage.mesh.verts.values()) {
      if (Math.abs(vert.co.y) < 0.1) vert.co = { ...vert.co, x: vert.co.x * 1.5 };
    }
    useEditorStore.getState().touchMesh();
    const store = useEditorStore.getState();
    store.setLatticeResolution(cage.id, { x: 3, y: 2, z: 3 });

    store.resetLattice(cage.id);
    expect(useEditorStore.getState().status).toBe(`Reset ${cage.name}`);
    store.setLatticeResolution(cage.id, { x: 3, y: 3, z: 3 });

    expect(useEditorStore.getState().objects[1].lattice?.shape).toBeUndefined();
    expectSamePoints(positions(shape()), positions(object.mesh));
  });

  it('lets the mesh go when the cage is reset, and says so when there is nothing to reset', () => {
    const { object, cage } = latticeScene();
    pullTopUp(cage);

    useEditorStore.getState().resetLattice(cage.id);
    expectSamePoints(positions(shape()), positions(object.mesh));

    const steps = useEditorStore.getState().historyUndo.length;
    useEditorStore.getState().resetLattice(cage.id);
    expect(useEditorStore.getState().historyUndo).toHaveLength(steps);
    expect(useEditorStore.getState().status).toBe(`${cage.name} is already at rest`);
  });

  it('comes back from a saved project still a cage, still shaping its mesh', () => {
    const { cage } = latticeScene();
    pullTopUp(cage);
    const pulled = positions(shape());

    const store = useEditorStore.getState();
    store.loadProjectDocument(store.snapshotDocument());

    expect(useEditorStore.getState().objects[1].lattice).toEqual({
      resolution: { x: 3, y: 3, z: 3 },
    });
    expectSamePoints(positions(shape()), pulled);
  });

  it('bakes the pull into the mesh when applied, and takes the cage away with it', () => {
    const { object, cage, modifier } = latticeScene();
    pullTopUp(cage);
    const pulled = positions(shape());
    useEditorStore.getState().selectObjects([cage.id, object.id]);

    useEditorStore.getState().applyModifierToMesh(modifier.id);

    const state = useEditorStore.getState();
    expect(state.objects.map((candidate) => candidate.id)).toEqual([object.id]);
    expect(state.objects[0].modifiers).toHaveLength(0);
    expect(state.selectedObjectIds).not.toContain(cage.id);
    expect(state.status).toBe(`Applied LATTICE and deleted ${cage.name}`);
    expectSamePoints(positions(state.objects[0].mesh), pulled);

    // One step, so one undo brings the cage back still shaping the mesh.
    state.undo();
    expect(useEditorStore.getState().objects.map((candidate) => candidate.id)).toEqual([
      object.id,
      cage.id,
    ]);
    expectSamePoints(positions(shape()), pulled);
  });

  it('keeps the cage when applied while another lattice still reads it', () => {
    const { object, cage, modifier } = latticeScene();
    const store = useEditorStore.getState();
    store.duplicateSelected();
    store.setActiveObject(object.id);

    store.applyModifierToMesh(modifier.id);

    const state = useEditorStore.getState();
    expect(state.objects.some((candidate) => candidate.id === cage.id)).toBe(true);
    expect(state.status).toBe('Applied LATTICE');
  });

  it('keeps its own origin and scale, and takes no modifiers', () => {
    const { cage } = latticeScene();
    const store = useEditorStore.getState();
    store.setActiveObject(cage.id);

    store.applyTransformToSelected();
    expect(useEditorStore.getState().objects[1].transform).toEqual(cage.transform);

    store.addModifier('mirror');
    expect(useEditorStore.getState().objects[1].modifiers).toHaveLength(0);
  });
});
