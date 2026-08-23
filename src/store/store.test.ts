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
    store().toggleObjectLock(activeObject().id);
    store().setMode('edit');
    selectTopFace();

    store().exec('extrude', { offset: 1 }, 'Extrude');

    expect(activeObject().mesh.faces.size).toBe(6);
    expect(store().status).toMatch(/locked/i);
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
});
