import { beforeEach, describe, expect, it } from 'vitest';

import { exportFBXAscii, exportOBJ, parseProject, stringifyProject } from '@kernel/index';

import { evaluatedMesh } from './slices/scene';
import { useEditorStore } from './useEditorStore';

function store() {
  return useEditorStore.getState();
}

function activeObject() {
  const state = store();
  const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
  if (!object) throw new Error('No active object');
  return object;
}

/** Selects the face pointing along +Y, the way a click in the viewport would. */
function selectTopFace() {
  const mesh = activeObject().mesh;
  mesh.deselectAll();
  for (const face of mesh.faces.values()) {
    if (face.normal.y > 0.99) face.selected = true;
  }
  mesh.flushSelection('face');
}

describe('editor store', () => {
  beforeEach(() => {
    store().resetScene();
  });

  it('adds a primitive and makes it active', () => {
    store().addPrimitive('box');

    const state = store();
    expect(state.objects).toHaveLength(1);
    expect(state.activeObjectId).toBe(state.objects[0].id);
    expect(state.objects[0].mesh.faces.size).toBe(6);
  });

  it('keeps primitive parameters live until an operation commits', () => {
    store().addPrimitive('cylinder', { segments: 8 });
    expect(activeObject().mesh.faces.size).toBe(10);

    store().updatePrimitiveParams({ segments: 16 });
    expect(activeObject().mesh.faces.size).toBe(18);

    store().setMode('edit');
    selectTopFace();
    store().exec('extrude', { offset: 1 }, 'Extrude');

    // A structural edit ends the live-parameter phase.
    expect(activeObject().primitive).toBeNull();
  });

  it('refuses edit mode with nothing selected', () => {
    store().setMode('edit');
    expect(store().mode).toBe('object');
    expect(store().status).toMatch(/Select an object/i);
  });

  it('runs an operator and reports it in the status bar', () => {
    store().addPrimitive('box');
    store().setMode('edit');
    selectTopFace();

    store().exec('extrude', { offset: 2 }, 'Extrude');

    expect(activeObject().mesh.faces.size).toBe(10);
    expect(store().status).toContain('Extruded');
    expect(store().lastOperator?.name).toBe('extrude');
  });

  it('undoes and redoes a modelling operation', () => {
    store().addPrimitive('box');
    store().setMode('edit');
    selectTopFace();
    store().exec('extrude', { offset: 1 }, 'Extrude');
    expect(activeObject().mesh.faces.size).toBe(10);

    store().undo();
    expect(activeObject().mesh.faces.size).toBe(6);
    expect(store().status).toContain('Undo');

    store().redo();
    expect(activeObject().mesh.faces.size).toBe(10);
  });

  it('undoes across several operations in order', () => {
    store().addPrimitive('box');
    store().setMode('edit');
    selectTopFace();
    store().exec('extrude', { offset: 1 }, 'Extrude');
    store().exec('inset', { thickness: 0.2 }, 'Inset');
    const afterInset = activeObject().mesh.faces.size;

    store().undo();
    expect(activeObject().mesh.faces.size).toBe(10);
    store().undo();
    expect(activeObject().mesh.faces.size).toBe(6);

    expect(afterInset).toBeGreaterThan(10);
    expect(store().canUndo).toBe(true); // the primitive add is still on the stack
  });

  it('will not edit a locked object', () => {
    store().addPrimitive('box');
    const id = activeObject().id;
    store().toggleObjectLock(id);
    store().setMode('edit');
    selectTopFace();

    store().exec('extrude', { offset: 1 }, 'Extrude');

    expect(activeObject().mesh.faces.size).toBe(6);
    expect(store().status).toBe('Object is locked');
    expect(store().lockedAttempt).toEqual({ objectId: id, token: expect.any(Number) });
  });

  it('will not move a locked object via setObjectTransform', () => {
    store().addPrimitive('box');
    const id = activeObject().id;
    const originalPosition = activeObject().transform.position;
    store().toggleObjectLock(id);

    store().setObjectTransform(id, { position: { x: 5, y: 5, z: 5 } });

    expect(activeObject().transform.position).toEqual(originalPosition);
    expect(store().status).toBe('Object is locked');
    expect(store().lockedAttempt).toEqual({ objectId: id, token: expect.any(Number) });
  });

  it('bumps the lockedAttempt token on every repeated denial, even for the same object', () => {
    store().addPrimitive('box');
    const id = activeObject().id;
    store().toggleObjectLock(id);

    store().setObjectTransform(id, { position: { x: 1, y: 0, z: 0 } });
    const firstToken = store().lockedAttempt?.token ?? 0;
    store().setObjectTransform(id, { position: { x: 2, y: 0, z: 0 } });
    const secondToken = store().lockedAttempt?.token ?? 0;

    expect(firstToken).toBeGreaterThan(0);
    expect(secondToken).toBeGreaterThan(firstToken);
  });

  it('skips locked objects in a batched setObjectTransforms call', () => {
    store().addPrimitive('box');
    const locked = store().objects[0].id;
    const lockedPosition = store().objects[0].transform.position;
    store().toggleObjectLock(locked);
    store().addPrimitive('cylinder');
    const unlocked = store().objects[1].id;

    store().setObjectTransforms([
      { id: locked, transform: { position: { x: 9, y: 9, z: 9 } } },
      { id: unlocked, transform: { position: { x: 1, y: 2, z: 3 } } },
    ]);

    const objects = store().objects;
    expect(objects.find((o) => o.id === locked)?.transform.position).toEqual(lockedPosition);
    expect(objects.find((o) => o.id === unlocked)?.transform.position).toEqual({
      x: 1,
      y: 2,
      z: 3,
    });
  });

  it('refuses to "dissolve" a lone face instead of claiming a no-op succeeded', () => {
    store().addPrimitive('box');
    store().setMode('edit');
    selectTopFace();

    store().exec('dissolve', { mode: 'faces' }, 'Dissolve');

    expect(activeObject().mesh.faces.size).toBe(6);
    expect(store().status).toMatch(/two or more adjacent faces/i);
  });

  it('dissolves two adjacent faces into one and says how many went in', () => {
    store().addPrimitive('box');
    store().setMode('edit');

    const mesh = activeObject().mesh;
    mesh.deselectAll();
    for (const face of mesh.faces.values()) {
      if (face.normal.y > 0.99 || face.normal.x > 0.99) face.selected = true;
    }
    mesh.flushSelection('face');

    store().exec('dissolve', { mode: 'faces' }, 'Dissolve');

    expect(activeObject().mesh.faces.size).toBe(5);
    expect(store().status).toBe('Dissolved 2 faces');
  });

  it('does not claim a delete happened with an empty selection', () => {
    store().addPrimitive('box');
    store().setMode('edit');
    activeObject().mesh.deselectAll();

    store().exec('delete', { mode: 'faces' }, 'Delete');

    expect(activeObject().mesh.faces.size).toBe(6);
    expect(store().status).toMatch(/nothing selected/i);
  });

  it('refuses to fold a face when dissolving a sharp cube edge', () => {
    store().addPrimitive('box');
    store().setMode('edit');
    store().setSelectMode('edge');

    const mesh = activeObject().mesh;
    mesh.deselectAll();
    [...mesh.edges.values()][0].selected = true;
    mesh.flushSelection('edge');

    store().exec('dissolve', { mode: 'edges' }, 'Dissolve');

    expect(activeObject().mesh.faces.size).toBe(6);
    expect(store().status).toMatch(/too sharp/i);
  });

  it('still merges coplanar faces, which is what edge dissolve is for', () => {
    store().addPrimitive('plane');
    store().setMode('edit');
    store().setSelectMode('vertex');

    const mesh = activeObject().mesh;
    const [a, , c] = mesh.faceVerts([...mesh.faces.values()][0]);
    mesh.deselectAll();
    a.selected = true;
    c.selected = true;
    mesh.flushSelection('vertex');
    store().exec('connect', {}, 'Connect');
    expect(activeObject().mesh.faces.size).toBe(2);

    const seam = activeObject().mesh.findEdge(a, c);
    activeObject().mesh.deselectAll();
    if (seam) seam.selected = true;
    activeObject().mesh.flushSelection('edge');
    store().setSelectMode('edge');

    store().exec('dissolve', { mode: 'edges' }, 'Dissolve');

    expect(activeObject().mesh.faces.size).toBe(1);
    expect(store().status).toBe('Dissolved 1 edge(s)');
  });

  it('reports a failed operator without corrupting the scene', () => {
    store().addPrimitive('box');
    store().exec('doesNotExist', {}, 'Bogus');

    expect(store().status).toMatch(/Unknown operator/);
    expect(activeObject().mesh.validate()).toEqual([]);
  });

  it('duplicates as an independent copy and as a linked one', () => {
    store().addPrimitive('box');
    const original = activeObject();

    store().duplicateSelected(false);
    // Compared as a boolean on purpose: a failing identity assertion on a BMesh
    // would make the reporter walk the cyclic half-edge graph to build a diff.
    expect(activeObject().mesh === original.mesh).toBe(false);

    store().setActiveObject(original.id);
    store().duplicateSelected(true);
    expect(activeObject().mesh === original.mesh).toBe(true);
  });

  it('joins two objects into one mesh', () => {
    store().addPrimitive('box');
    const first = activeObject().id;
    store().addPrimitive('box');
    store().setActiveObject(first);
    store().setActiveObject(activeObject().id, false);

    useEditorStore.setState({ selectedObjectIds: store().objects.map((object) => object.id) });
    store().joinSelected();

    expect(store().objects).toHaveLength(1);
    expect(store().objects[0].mesh.faces.size).toBe(12);
  });

  it('evaluates modifiers without touching the base mesh', () => {
    store().addPrimitive('box');
    store().addModifier('array');

    const object = activeObject();
    expect(object.mesh.faces.size).toBe(6);
    expect(evaluatedMesh(object).faces.size).toBe(18);
  });

  it('bakes a modifier into the mesh on apply', () => {
    store().addPrimitive('box');
    store().addModifier('array');
    const modifierId = activeObject().modifiers[0].id;

    store().applyModifierToMesh(modifierId);

    expect(activeObject().modifiers).toHaveLength(0);
    expect(activeObject().mesh.faces.size).toBe(18);
  });

  it('round-trips the scene through a project file', () => {
    store().addPrimitive('box');
    store().addModifier('mirror');
    store().setProjectName('demo');

    const text = stringifyProject(store().snapshotDocument());
    store().resetScene();
    expect(store().objects).toHaveLength(0);

    store().loadProjectDocument(parseProject(text));

    expect(store().projectName).toBe('demo');
    expect(store().objects).toHaveLength(1);
    expect(store().objects[0].modifiers[0].type).toBe('mirror');
    expect(store().objects[0].mesh.validate()).toEqual([]);
  });

  it('exports the evaluated mesh so modifiers reach the file', () => {
    store().addPrimitive('box');
    store().addModifier('array');

    const object = activeObject();
    const exportable = [
      {
        name: object.name,
        mesh: evaluatedMesh(object),
        transform: object.transform,
        materials: object.materials,
      },
    ];

    const { obj } = exportOBJ(exportable);
    const fbx = exportFBXAscii(exportable);

    expect(obj.split('\n').filter((line) => line.startsWith('f '))).toHaveLength(18);
    expect(fbx).toContain('FBXVersion: 7400');
  });

  it('carries the selection across select-mode changes', () => {
    store().addPrimitive('box');
    store().setMode('edit');
    selectTopFace();
    expect(activeObject().mesh.selectedVerts()).toHaveLength(4);

    store().setSelectMode('vertex');
    expect(activeObject().mesh.selectedVerts()).toHaveLength(4);

    store().setSelectMode('face');
    expect(activeObject().mesh.selectedFaces()).toHaveLength(1);
  });

  it('bumps the mesh version so the viewport resyncs', () => {
    const before = store().meshVersion;
    store().addPrimitive('box');
    expect(store().meshVersion).toBeGreaterThan(before);

    const afterAdd = store().meshVersion;
    store().setMode('edit');
    selectTopFace();
    store().exec('subdivide', { cuts: 1 }, 'Subdivide');
    expect(store().meshVersion).toBeGreaterThan(afterAdd);
  });

  it('selects every object in the scene, the object-mode equivalent of edit-mode select all', () => {
    store().addPrimitive('box');
    store().addPrimitive('cylinder');
    store().setActiveObject(null);
    expect(store().selectedObjectIds).toHaveLength(0);

    store().selectAllObjects();

    expect(store().selectedObjectIds).toHaveLength(2);
    expect(store().selectedObjectIds).toEqual(store().objects.map((object) => object.id));
    expect(store().status).toMatch(/Selected all 2 object/);
  });

  it('leaves an empty scene alone when selecting all objects', () => {
    store().selectAllObjects();
    expect(store().selectedObjectIds).toEqual([]);
    expect(store().activeObjectId).toBeNull();
  });

  it('patches several objects in a single call, for a multi-object gizmo drag', () => {
    store().addPrimitive('box');
    const first = store().objects[0].id;
    store().addPrimitive('cylinder');
    const second = store().objects[1].id;
    const versionBefore = store().meshVersion;

    store().setObjectTransforms([
      { id: first, transform: { position: { x: 1, y: 2, z: 3 } } },
      { id: second, transform: { position: { x: -1, y: -2, z: -3 } } },
    ]);

    const objects = store().objects;
    expect(objects.find((o) => o.id === first)?.transform.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(objects.find((o) => o.id === second)?.transform.position).toEqual({
      x: -1,
      y: -2,
      z: -3,
    });
    // One store update for the whole batch, not one per object.
    expect(store().meshVersion).toBe(versionBefore + 1);
  });

  it('ignores a patch for an object that is not in the scene', () => {
    store().addPrimitive('box');
    const id = store().objects[0].id;
    const originalPosition = store().objects[0].transform.position;

    store().setObjectTransforms([{ id: 'not-a-real-id', transform: { position: { x: 9, y: 9, z: 9 } } }]);

    expect(store().objects.find((o) => o.id === id)?.transform.position).toEqual(originalPosition);
  });

  it('does nothing on an empty patch list', () => {
    store().addPrimitive('box');
    const versionBefore = store().meshVersion;

    store().setObjectTransforms([]);

    expect(store().meshVersion).toBe(versionBefore);
  });
});
