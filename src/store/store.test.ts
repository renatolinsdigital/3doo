import { beforeEach, describe, expect, it } from 'vitest';

import {
  MIN_OBJECT_SIZE,
  type Edge,
  type Vec3,
  add,
  dot,
  edgeLength,
  exportFBX,
  exportOBJ,
  parseProject,
  stringifyProject,
  vec3,
} from '@kernel/index';

import { activeObject as selectActiveObject, displayCenter, evaluatedMesh } from './slices/scene';
import { useEditorStore } from './useEditorStore';

function store() {
  return useEditorStore.getState();
}

function activeObject() {
  const object = selectActiveObject(store());
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

/** Moves the whole mesh in object space, the way an edit-mode drag of it does. */
function driftMesh(delta: Vec3) {
  for (const vert of activeObject().mesh.verts.values()) vert.co = add(vert.co, delta);
  store().touchMesh();
}

describe('editor store', () => {
  beforeEach(() => {
    store().resetScene();
  });

  it('adds a primitive and makes it active', () => {
    store().addPrimitive('cube');

    const state = store();
    expect(state.objects).toHaveLength(1);
    expect(state.activeObjectId).toBe(state.objects[0].id);
    expect(state.objects[0].mesh.faces.size).toBe(6);
  });

  it('reaches for the move tool, so the new primitive has a gizmo to grab', () => {
    store().setActiveTool('select');

    store().addPrimitive('cube');

    expect(store().activeTool).toBe('move');
    // The add is what the status line says; switching tool must not bury it.
    expect(store().status).toBe('Added CUBE');
  });

  it('says how to start a cut when the knife is picked up', () => {
    store().addPrimitive('cube');
    store().setMode('edit');

    store().setActiveTool('knife');

    expect(store().activeTool).toBe('knife');
    expect(store().status).toBe('KNIFE: click on the mesh to start a cut');
  });

  it('puts the knife down on the way out of edit mode, and keeps any other tool', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setActiveTool('knife');

    store().setMode('object');
    expect(store().activeTool).toBe('select');

    store().setMode('edit');
    store().setActiveTool('rotate');
    store().setMode('object');
    expect(store().activeTool).toBe('rotate');
  });

  it('does not tell a knife cut that a click confirms it', () => {
    store().addPrimitive('cube');
    store().setMode('edit');

    store().beginModal('knife');

    expect(store().modal).toMatchObject({ kind: 'knife' });
    expect(store().status).toContain('Enter to cut');
    expect(store().status).not.toContain('click or Enter to confirm');
  });

  it('keeps the active tool when an operator only moves the selection around', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    expect(store().activeTool).toBe('move');

    store().exec('selectAll', {}, 'Select all');

    // The tool is the user's own choice, and picking more geometry is not a
    // request to change it. The gizmo simply reseats on the new selection.
    expect(store().activeTool).toBe('move');
    expect(store().status).toBe('Selected all');
  });

  it('leaves the handles up for an operator that edits geometry', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().exec('selectAll', {}, 'Select all');
    store().setActiveTool('move');

    store().exec('extrude', { offset: 1 }, 'Extrude');

    expect(store().activeTool).toBe('move');
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

  it('ends live parameters when a material is assigned to faces', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    selectTopFace();

    store().assignMaterialToSelection();

    // Rebuilding from the parameters would drop the per-face assignment, so the
    // parameters are what gives way.
    expect(activeObject().primitive).toBeNull();
  });

  it('keeps parameters live through anything that leaves the mesh alone', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;

    store().setObjectTransform(id, { position: { x: 2, y: 0, z: 0 } });
    store().addModifier('array');
    store().renameObject(id, 'CRATE');

    // Moving the object, stacking a modifier and renaming all leave the mesh
    // exactly as the parameters describe it.
    expect(activeObject().primitive?.kind).toBe('cube');
  });

  it('refuses edit mode with nothing selected', () => {
    store().setMode('edit');
    expect(store().mode).toBe('object');
    expect(store().status).toMatch(/Select an object/i);
    expect(store().toasts).toHaveLength(1);
    expect(store().toasts[0].message).toMatch(/Select an object/i);
  });

  it('opens edit mode on a mesh with nothing selected', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().exec('selectAll', {}, 'Select all');
    expect(activeObject().mesh.selectedFaces()).toHaveLength(6);

    // The flags live on the geometry, so they were still there on the way back
    // in and lit up faces nobody had picked this time round.
    store().setMode('object');
    store().setMode('edit');

    const mesh = activeObject().mesh;
    expect(mesh.selectedVerts()).toHaveLength(0);
    expect(mesh.selectedEdges()).toHaveLength(0);
    expect(mesh.selectedFaces()).toHaveLength(0);
  });

  it('runs an operator and reports it in the status bar', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    selectTopFace();

    store().exec('extrude', { offset: 2 }, 'Extrude');

    expect(activeObject().mesh.faces.size).toBe(10);
    expect(store().status).toContain('Extruded');
    expect(store().lastOperator?.name).toBe('extrude');
  });

  it('undoes and redoes a modelling operation', () => {
    store().addPrimitive('cube');
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

  it('still knows the first-selected vertex after an undo', () => {
    store().addPrimitive('cube');
    store().setMode('edit');

    const mesh = activeObject().mesh;
    mesh.deselectAll();
    const top = [...mesh.faces.values()].find((face) => face.normal.y > 0.99);
    if (!top) throw new Error('No top face');
    // Click the corners newest-first, the reverse of the order the mesh
    // created them, so merging at the first pick cannot coincide with the
    // iteration order `selectedVerts()` hands the operator.
    const picked = [...mesh.faceVerts(top)].sort((a, b) => b.id - a.id);
    for (const vert of picked) mesh.selectVert(vert);
    mesh.flushSelection('vertex');
    const expected = { ...picked[0].co };

    store().exec('merge', { mode: 'first' }, 'Merge');
    expect(activeObject().mesh.selectedVerts()).toHaveLength(1);
    expect(activeObject().mesh.selectedVerts()[0].co).toEqual(expected);

    store().undo();
    store().exec('merge', { mode: 'first' }, 'Merge');
    expect(activeObject().mesh.selectedVerts()).toHaveLength(1);
    expect(activeObject().mesh.selectedVerts()[0].co).toEqual(expected);
  });

  it('undoes across several operations in order', () => {
    store().addPrimitive('cube');
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
    store().addPrimitive('cube');
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
    store().addPrimitive('cube');
    const id = activeObject().id;
    const originalPosition = activeObject().transform.position;
    store().toggleObjectLock(id);

    store().setObjectTransform(id, { position: { x: 5, y: 5, z: 5 } });

    expect(activeObject().transform.position).toEqual(originalPosition);
    expect(store().status).toBe('Object is locked');
    expect(store().lockedAttempt).toEqual({ objectId: id, token: expect.any(Number) });
  });

  it('bumps the lockedAttempt token on every repeated denial, even for the same object', () => {
    store().addPrimitive('cube');
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
    store().addPrimitive('cube');
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
    store().addPrimitive('cube');
    store().setMode('edit');
    selectTopFace();

    store().exec('dissolve', { mode: 'faces' }, 'Dissolve');

    expect(activeObject().mesh.faces.size).toBe(6);
    expect(store().status).toMatch(/two or more adjacent faces/i);
  });

  it('dissolves two adjacent faces into one and says how many went in', () => {
    store().addPrimitive('cube');
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
    store().addPrimitive('cube');
    store().setMode('edit');
    activeObject().mesh.deselectAll();

    store().exec('delete', { mode: 'faces' }, 'Delete');

    expect(activeObject().mesh.faces.size).toBe(6);
    expect(store().status).toMatch(/nothing selected/i);
  });

  it('starts a slide on whichever element the select mode is showing', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('edge');
    store().exec('selectAll', {}, 'Select all');

    store().beginSlide();

    expect(store().modal).toMatchObject({ kind: 'slide', element: 'edge' });
  });

  it('turns a slide away in face mode, where there is no one rail to run along', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('face');
    store().exec('selectAll', {}, 'Select all');

    store().beginSlide();

    expect(store().modal).toBeNull();
    expect(store().status).toMatch(/vertex or edge select/i);
  });

  it('turns a slide away with nothing selected, and says so', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('vertex');
    activeObject().mesh.deselectAll();

    store().beginSlide();

    expect(store().modal).toBeNull();
    expect(store().status).toMatch(/select vertices to slide/i);
  });

  it('starts a bevel off the keyboard when there are edges to chamfer', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('edge');
    store().exec('selectAll', {}, 'Select all');

    store().beginOffset('bevel');

    // Nothing is cut yet: the width opens at zero and the pointer drags it out.
    expect(store().modal).toMatchObject({ kind: 'bevel', value: { x: 0 } });
    expect(activeObject().mesh.faces.size).toBe(6);
  });

  it('turns a bevel away with no edges selected, and says so', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('edge');
    activeObject().mesh.deselectAll();

    store().beginOffset('bevel');

    expect(store().modal).toBeNull();
    expect(store().status).toMatch(/select edges to bevel/i);
  });

  it('turns an inset away with no faces selected, and says so', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    activeObject().mesh.deselectAll();

    store().beginOffset('inset');

    expect(store().modal).toBeNull();
    expect(store().status).toMatch(/select faces to inset/i);
  });

  it('turns an inset away in object mode, where there is no face to shrink', () => {
    store().addPrimitive('cube');

    store().beginOffset('inset');

    expect(store().modal).toBeNull();
    expect(store().status).toMatch(/edit mode/i);
  });

  it('starts an extrude off the keyboard, adding nothing until the pointer moves', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('face');
    store().exec('selectAll', {}, 'Select all');

    store().beginOffset('extrude');

    expect(store().modal).toMatchObject({ kind: 'extrude', value: { x: 0 } });
    expect(activeObject().mesh.faces.size).toBe(6);
  });

  it('turns an extrude away with nothing selected, and says so', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    activeObject().mesh.deselectAll();

    store().beginOffset('extrude');

    expect(store().modal).toBeNull();
    expect(store().status).toMatch(/select faces or edges to extrude/i);
  });

  it('turns a slide away in object mode, where there is no mesh element to move', () => {
    store().addPrimitive('cube');

    store().beginSlide();

    expect(store().modal).toBeNull();
    expect(store().status).toMatch(/edit mode/i);
  });

  it('refuses to fold a face when dissolving a sharp cube edge', () => {
    store().addPrimitive('cube');
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

  it('refuses to fold a face when dissolving a cube corner vertex', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('vertex');

    const mesh = activeObject().mesh;
    mesh.deselectAll();
    [...mesh.verts.values()][0].selected = true;
    mesh.flushSelection('vertex');

    store().exec('dissolve', { mode: 'verts' }, 'Dissolve');

    expect(activeObject().mesh.faces.size).toBe(6);
    expect(activeObject().mesh.verts.size).toBe(8);
    expect(store().status).toMatch(/too sharp/i);
  });

  it('still dissolves a vertex whose faces are coplanar', () => {
    store().addPrimitive('grid', { segments: 2 });
    store().setMode('edit');
    store().setSelectMode('vertex');

    const mesh = activeObject().mesh;
    const interior = [...mesh.verts.values()].filter((vert) => mesh.vertFaces(vert).length === 4);
    expect(interior).toHaveLength(1);
    mesh.deselectAll();
    interior[0].selected = true;
    mesh.flushSelection('vertex');

    store().exec('dissolve', { mode: 'verts' }, 'Dissolve');

    expect(activeObject().mesh.verts.size).toBe(8);
    expect(store().status).toBe('Dissolved 1 vertex(es)');
  });

  it('subdivides the selected edge in edge mode, where it used to refuse', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('edge');

    const mesh = activeObject().mesh;
    mesh.deselectAll();
    [...mesh.edges.values()][0].selected = true;
    mesh.flushSelection('edge');

    store().exec('subdivide', { cuts: 1, smooth: 0 }, 'Subdivide');

    expect(activeObject().mesh.verts.size).toBe(9);
    expect(activeObject().mesh.faces.size).toBe(6);
    expect(store().status).toBe('Split 1 edge(s), adding 1 vertex(es)');
  });

  it('still subdivides faces in face mode', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    // Explicit: resetScene leaves selectMode as the previous test left it.
    store().setSelectMode('face');
    selectTopFace();

    store().exec('subdivide', { cuts: 1, smooth: 0 }, 'Subdivide');

    // Four out of the face itself, four out of the one across the cube, and
    // two out of each face the two rings run through on the way.
    expect(activeObject().mesh.faces.size).toBe(4 + 4 + 4 * 2);
    expect(store().status).toMatch(/Subdivided 1 face/);
  });

  it('dissolves a vertex sitting in the middle of an edge', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('edge');

    const mesh = activeObject().mesh;
    mesh.deselectAll();
    [...mesh.edges.values()][0].selected = true;
    mesh.flushSelection('edge');
    store().exec('subdivide', { cuts: 1 }, 'Subdivide');
    expect(activeObject().mesh.verts.size).toBe(9);

    const live = activeObject().mesh;
    const midpoint = [...live.verts.values()].find((vert) => vert.edges.length === 2);
    expect(midpoint).toBeDefined();
    live.deselectAll();
    if (midpoint) midpoint.selected = true;
    live.flushSelection('vertex');
    store().setSelectMode('vertex');

    store().exec('dissolve', { mode: 'verts' }, 'Dissolve');

    expect(activeObject().mesh.verts.size).toBe(8);
    expect(activeObject().mesh.faces.size).toBe(6);
    expect(store().status).toBe('Dissolved 1 vertex(es)');
  });

  it('flags the vertices an edge subdivide just created', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('edge');

    const mesh = activeObject().mesh;
    mesh.deselectAll();
    [...mesh.edges.values()][0].selected = true;
    mesh.flushSelection('edge');
    const before = new Set([...mesh.verts.values()].map((vert) => vert.id));

    store().exec('subdivide', { cuts: 2 }, 'Subdivide');

    const flagged = store().recentVerts;
    expect(flagged?.objectId).toBe(activeObject().id);
    expect(flagged?.vertIds).toHaveLength(2);
    // Exactly the new ones, not anything that was already there.
    for (const id of flagged?.vertIds ?? []) expect(before.has(id)).toBe(false);

    store().clearRecentVerts();
    expect(store().recentVerts).toBeNull();
  });

  it('leaves the flag empty for operators that create no vertices', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('face');
    selectTopFace();

    store().exec('shade', { smooth: true }, 'Shade smooth');

    expect(store().recentVerts).toBeNull();
  });

  it('reports a failed operator without corrupting the scene', () => {
    store().addPrimitive('cube');
    store().exec('doesNotExist', {}, 'Bogus');

    expect(store().status).toMatch(/Unknown operator/);
    expect(activeObject().mesh.validate()).toEqual([]);
  });

  it('duplicates as an independent copy and as a linked one', () => {
    store().addPrimitive('cube');
    const original = activeObject();

    store().duplicateSelected(false);
    // Compared as a boolean on purpose: a failing identity assertion on a BMesh
    // would make the reporter walk the cyclic half-edge graph to build a diff.
    expect(activeObject().mesh === original.mesh).toBe(false);

    store().setActiveObject(original.id);
    store().duplicateSelected(true);
    expect(activeObject().mesh === original.mesh).toBe(true);
  });

  it('steps the select tool through its region shapes', () => {
    store().setActiveTool('select');

    expect(store().selectShape).toBe('box');
    store().cycleSelectShape();
    expect(store().selectShape).toBe('circle');
    store().cycleSelectShape();
    expect(store().selectShape).toBe('lasso');
    store().cycleSelectShape();
    expect(store().selectShape).toBe('box');
  });

  it('picks the select tool up before it starts changing shapes', () => {
    store().setActiveTool('move');
    store().setSelectShape('circle');
    store().setActiveTool('move');

    store().cycleSelectShape();

    // Arriving from another tool, V should not also change what a drag draws.
    expect(store().activeTool).toBe('select');
    expect(store().selectShape).toBe('circle');

    store().cycleSelectShape();
    expect(store().selectShape).toBe('lasso');
  });

  it('selects every object a region drag touched', () => {
    store().addPrimitive('cube');
    store().addPrimitive('cylinder');
    store().addPrimitive('uvSphere');
    const [box, cylinder, sphere] = store().objects;

    store().selectObjects([box.id, cylinder.id]);

    expect(store().selectedObjectIds).toEqual([box.id, cylinder.id]);
    // The last one named goes active, the way the last one clicked would.
    expect(store().activeObjectId).toBe(cylinder.id);
    expect(store().selectedObjectIds).not.toContain(sphere.id);
  });

  it('adds to the selection when a region drag holds shift', () => {
    store().addPrimitive('cube');
    store().addPrimitive('cylinder');
    const [box, cylinder] = store().objects;
    store().selectObjects([box.id]);

    store().selectObjects([cylinder.id], 'add');

    expect(store().selectedObjectIds).toEqual([box.id, cylinder.id]);
  });

  it('drops what a region drag caught when it holds shift and ctrl', () => {
    store().addPrimitive('cube');
    store().addPrimitive('cylinder');
    store().addPrimitive('uvSphere');
    const [box, cylinder, sphere] = store().objects;
    store().selectObjects([box.id, cylinder.id, sphere.id]);

    store().selectObjects([cylinder.id], 'subtract');

    expect(store().selectedObjectIds).toEqual([box.id, sphere.id]);
  });

  it('hands the active slot to a survivor when the drag drops the one holding it', () => {
    store().addPrimitive('cube');
    store().addPrimitive('cylinder');
    const [box, cylinder] = store().objects;
    store().selectObjects([box.id, cylinder.id]);
    expect(store().activeObjectId).toBe(cylinder.id);

    store().selectObjects([cylinder.id], 'subtract');

    // An outliner drawing a deselected row as the active one is the bug this
    // stops: whatever is left standing takes it.
    expect(store().activeObjectId).toBe(box.id);
  });

  it('adds a clicked object without turning an already selected one off', () => {
    store().addPrimitive('cube');
    store().addPrimitive('cylinder');
    const [box, cylinder] = store().objects;
    store().selectObjects([box.id, cylinder.id]);

    store().setActiveObject(cylinder.id, 'add');

    // Shift used to toggle, so shift-clicking a selection to make it active
    // deselected it instead. Subtract is Shift+Ctrl's job now.
    expect(store().selectedObjectIds).toEqual([box.id, cylinder.id]);
    expect(store().activeObjectId).toBe(cylinder.id);
  });

  it('drops one clicked object on shift and ctrl, leaving the rest', () => {
    store().addPrimitive('cube');
    store().addPrimitive('cylinder');
    const [box, cylinder] = store().objects;
    store().selectObjects([box.id, cylinder.id]);

    store().setActiveObject(cylinder.id, 'subtract');

    expect(store().selectedObjectIds).toEqual([box.id]);
    expect(store().activeObjectId).toBe(box.id);
  });

  it('clears the selection when a region drag touched nothing', () => {
    store().addPrimitive('cube');
    store().selectAllObjects();

    store().selectObjects([]);

    // The same as clicking empty space, rather than leaving the last one behind.
    expect(store().selectedObjectIds).toEqual([]);
    expect(store().activeObjectId).toBeNull();
  });

  it('clears the object selection, leaving the tool picked up', () => {
    store().addPrimitive('cube');
    store().addPrimitive('cylinder');
    store().selectAllObjects();
    store().setActiveTool('move');

    store().clearSelection();

    expect(store().selectedObjectIds).toEqual([]);
    expect(store().activeObjectId).toBeNull();
    // The handles go away because there is nothing left to hang them off, not
    // because the tool changed: the next object picked gets them straight back.
    expect(store().activeTool).toBe('move');
  });

  it('clears the mesh selection in edit mode, keeping the object', () => {
    store().addPrimitive('cube');
    const object = activeObject();
    store().setMode('edit');
    store().exec('selectAll', {}, 'Select all');
    store().setActiveTool('rotate');

    store().clearSelection();

    expect(object.mesh.selectedVerts()).toEqual([]);
    expect(store().activeObjectId).toBe(object.id);
    expect(store().activeTool).toBe('rotate');
  });

  it('leaves undo alone when a selection is cleared', () => {
    store().addPrimitive('cube');
    const before = store().objects.length;

    store().clearSelection();
    store().undo();

    // Escape is a way out of a state, not an edit: the undo behind it is still
    // the one that added the box.
    expect(store().objects).toHaveLength(before - 1);
  });

  it('hands the active object on when it is deselected', () => {
    store().addPrimitive('cube');
    store().addPrimitive('cylinder');
    store().selectAllObjects();
    const [box, cylinder] = store().objects;
    useEditorStore.setState({ activeObjectId: cylinder.id });

    store().deselectObject(cylinder.id);

    // Left active, a deselected object still draws as the active row and stays
    // the target of everything that reads activeObjectId.
    expect(store().selectedObjectIds).toEqual([box.id]);
    expect(store().activeObjectId).toBe(box.id);
  });

  it('leaves the rest of the selection alone when one object is deselected', () => {
    store().addPrimitive('cube');
    store().addPrimitive('cylinder');
    store().selectAllObjects();
    const [box] = store().objects;

    store().deselectObject(box.id);
    store().deselectObject(box.id);

    expect(store().selectedObjectIds).toHaveLength(1);
  });

  it('holds a linked duplicate on one mesh through an undo', () => {
    store().addPrimitive('cube');
    store().setActiveObject(activeObject().id);
    store().duplicateSelected(true);

    // Undo of something later, so both objects are still in the scene: history
    // restores through the project format, which is where the link used to be
    // dropped and the copy quietly went its own way.
    store().exec('recalculateNormals', { outside: true }, 'Recalculate normals');
    store().undo();

    const [original, copy] = store().objects;
    expect(store().objects).toHaveLength(2);
    expect(original.mesh === copy.mesh).toBe(true);
  });

  it('merges the selection into one object, each part where it stood', () => {
    store().addPrimitive('cube');
    const first = activeObject().id;
    store().addPrimitive('cube');
    const second = activeObject().id;
    store().setObjectTransform(second, { position: { x: 3, y: 0, z: 0 } });
    useEditorStore.setState({ selectedObjectIds: [first, second], activeObjectId: first });

    store().mergeSelected();

    expect(store().objects).toHaveLength(1);
    const joined = activeObject();
    expect(joined.id).toBe(first);
    expect(joined.mesh.faces.size).toBe(12);
    // Carried through world space: the second box keeps its 3 m offset instead
    // of landing back on the target's origin. The origin then moves onto the
    // middle of what the merge made, halfway between the two boxes.
    const box = joined.mesh.boundingBox();
    expect(box.min.x).toBeCloseTo(-2);
    expect(box.max.x).toBeCloseTo(2);
    expect(joined.transform.position.x).toBeCloseTo(1.5);
  });

  it('merges a linked duplicate into its own original', () => {
    store().addPrimitive('cube');
    const original = activeObject().id;
    store().setActiveObject(original);
    store().duplicateSelected(true);
    const copy = activeObject().id;
    store().setObjectTransform(copy, { position: { x: 3, y: 0, z: 0 } });
    useEditorStore.setState({ selectedObjectIds: [original, copy], activeObjectId: original });

    store().mergeSelected();

    // Source and target are one mesh instance here, so the copy has to be read
    // out before the merge starts writing into it.
    expect(store().objects).toHaveLength(1);
    expect(activeObject().mesh.faces.size).toBe(12);
    expect(activeObject().materials).toHaveLength(1);
  });

  it('separates a merged mesh back into one object per loose part', () => {
    store().addPrimitive('cube');
    const first = activeObject().id;
    store().addPrimitive('cube');
    const second = activeObject().id;
    store().setObjectTransform(second, { position: { x: 3, y: 0, z: 0 } });
    useEditorStore.setState({ selectedObjectIds: [first, second], activeObjectId: first });
    store().mergeSelected();

    store().separateLooseParts();

    expect(store().objects).toHaveLength(2);
    for (const object of store().objects) expect(object.mesh.faces.size).toBe(6);
    // The two boxes were 3 m apart when merged and stay 3 m apart after: the
    // parts come out where the geometry sits, not stacked on the origin. Each
    // one carries its own origin, on the middle of its own box.
    const centres = store().objects.map((object) => object.transform.position.x);
    expect(Math.abs(centres[0] - centres[1])).toBeCloseTo(3);
    for (const object of store().objects) {
      const box = object.mesh.boundingBox();
      expect(box.min.x).toBeCloseTo(-0.5);
      expect(box.max.x).toBeCloseTo(0.5);
    }
    expect(store().selectedObjectIds).toHaveLength(2);
  });

  it('puts the origin on the middle of what a boolean left behind', async () => {
    store().addPrimitive('cube');
    const target = activeObject().id;
    store().addPrimitive('cube');
    const cutter = activeObject().id;
    store().setObjectTransform(cutter, { position: { x: 0.5, y: 0, z: 0 } });
    useEditorStore.setState({ selectedObjectIds: [target, cutter], activeObjectId: target });

    await store().booleanWithSelected('difference');

    // Half the box is gone, so the origin moves a quarter of a metre to sit in
    // the middle of the half that is left. Nothing moves on screen: that half
    // still runs from -0.5 to 0 in world space.
    const object = activeObject();
    const box = object.mesh.boundingBox();
    expect(object.transform.position.x).toBeCloseTo(-0.25);
    expect(box.min.x).toBeCloseTo(-0.25);
    expect(box.max.x).toBeCloseTo(0.25);
  });

  it.each([
    ['folds an uncoloured cutter material into the first slot', null, 1],
    ['keeps a slot for a cutter material given a colour', { r: 0, g: 0, b: 1 }, 2],
  ] as const)('%s', async (_, cutterColor, slots) => {
    // Every primitive arrives wearing a fresh default, so each cut used to
    // leave one more grey slot on the target and grey walls in the hole.
    store().addPrimitive('cube');
    const target = activeObject().id;
    store().updateMaterial(0, { color: { r: 1, g: 1, b: 0 } });
    store().addPrimitive('cube');
    const cutter = activeObject().id;
    if (cutterColor) store().updateMaterial(0, { color: cutterColor });
    store().setObjectTransform(cutter, { position: { x: 0.5, y: 0, z: 0 } });
    useEditorStore.setState({ selectedObjectIds: [target, cutter], activeObjectId: target });

    await store().booleanWithSelected('difference');

    const object = activeObject();
    expect(object.materials).toHaveLength(slots);
    const worn = new Set([...object.mesh.faces.values()].map((face) => face.materialIndex));
    expect(worn).toEqual(new Set(Array.from({ length: slots }, (_, slot) => slot)));
  });

  it('says so rather than acting when the mesh is one piece', () => {
    store().addPrimitive('cube');
    const before = store().objects.length;

    store().separateLooseParts();

    expect(store().objects).toHaveLength(before);
    expect(store().status).toMatch(/one connected piece/);
  });

  it('refuses to separate a mesh another object shares', () => {
    store().addPrimitive('cube');
    store().setActiveObject(activeObject().id);
    store().duplicateSelected(true);

    store().separateLooseParts();

    expect(store().objects).toHaveLength(2);
    expect(store().status).toContain('single-user');
  });

  it('leaves objects outside the merge unchanged when they share the mesh', () => {
    store().addPrimitive('cube');
    const original = activeObject().id;
    store().setActiveObject(original);
    store().duplicateSelected(true);
    const linked = activeObject().id;
    store().addPrimitive('cube');
    const loner = activeObject().id;
    store().setObjectTransform(loner, { position: { x: 3, y: 0, z: 0 } });

    // Merge the loner into the original, which a third object still shares.
    useEditorStore.setState({ selectedObjectIds: [original, loner], activeObjectId: original });
    store().mergeSelected();

    const untouched = store().objects.find((object) => object.id === linked);
    expect(untouched?.mesh.faces.size).toBe(6);
    expect(activeObject().mesh.faces.size).toBe(12);
  });

  it('carries linked objects along when a primitive is rebuilt', () => {
    store().addPrimitive('cube');
    store().setActiveObject(activeObject().id);
    store().duplicateSelected(true);
    store().setActiveObject(store().objects[0].id);

    store().updatePrimitiveParams({ size: 4 });

    const [original, copy] = store().objects;
    expect(original.mesh === copy.mesh).toBe(true);
    expect(copy.mesh.boundingBox().max.x).toBeCloseTo(2);
  });

  it('leaves the copy selected and under the move gizmo', () => {
    store().addPrimitive('cube');
    const original = activeObject().id;

    store().duplicateSelected(false);

    // The copy sits exactly on top of the original, so the gizmo it needs to be
    // dragged off with has to be there without a tool change first.
    expect(store().activeObjectId).not.toBe(original);
    expect(store().selectedObjectIds).toEqual([store().activeObjectId]);
    expect(store().activeTool).toBe('move');
  });

  it('bakes rotation and scale into the mesh, leaving the object where it sits', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    store().setObjectTransform(id, { scale: { x: 2, y: 2, z: 2 }, position: { x: 3, y: 0, z: 0 } });
    useEditorStore.setState({ selectedObjectIds: [id] });

    store().applyTransformToSelected();

    const object = activeObject();
    expect(object.transform.scale).toEqual({ x: 1, y: 1, z: 1 });
    expect(object.transform.position).toEqual({ x: 3, y: 0, z: 0 });
    // The default box spans ±0.5, so twice that once the scale lives in the mesh.
    const xs = [...object.mesh.verts.values()].map((vert) => vert.co.x);
    expect(Math.max(...xs)).toBeCloseTo(1);
  });

  it('holds a shrinking object at the size floor', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;

    store().setObjectTransform(id, { scale: { x: 1e-9, y: 1e-9, z: 1e-9 } });

    // The default box is 1 m across, so its scale is its size in metres.
    expect(activeObject().transform.scale.x).toBeCloseTo(MIN_OBJECT_SIZE, 12);
  });

  it('holds the floor in a batched setObjectTransforms call too', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;

    store().setObjectTransforms([{ id, transform: { scale: { x: 0, y: 0, z: 0 } } }]);

    expect(activeObject().transform.scale.x).toBeCloseTo(MIN_OBJECT_SIZE, 12);
  });

  it('says so the first time the floor catches a shrinking object', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    useEditorStore.setState({ toasts: [] });

    store().setObjectTransform(id, { scale: { x: 1e-9, y: 1e-9, z: 1e-9 } });

    const toasts = store().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('warning');
    expect(toasts[0].message).toContain('size limit');
    expect(store().status).toContain('size limit');
  });

  it('stays quiet for the rest of a drag that is already at the floor', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    useEditorStore.setState({ toasts: [] });

    // What a drag looks like from here on: a smaller scale every pointer tick,
    // every one of them held at the same floor.
    for (const factor of [1e-9, 1e-10, 1e-11]) {
      store().setObjectTransform(id, { scale: { x: factor, y: factor, z: factor } });
    }

    expect(store().toasts).toHaveLength(1);
  });

  it('warns again once the object has been scaled back off the floor', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    useEditorStore.setState({ toasts: [] });

    store().setObjectTransform(id, { scale: { x: 1e-9, y: 1e-9, z: 1e-9 } });
    store().setObjectTransform(id, { scale: { x: 1, y: 1, z: 1 } });
    store().setObjectTransform(id, { scale: { x: 1e-9, y: 1e-9, z: 1e-9 } });

    // Same wording both times, so it renews the toast instead of stacking one.
    expect(store().toasts).toHaveLength(1);
    expect(store().toasts[0].issued).toBe(2);
  });

  it('says nothing when a scale the floor never touched goes through', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    useEditorStore.setState({ toasts: [] });

    store().setObjectTransform(id, { scale: { x: 0.5, y: 0.5, z: 0.5 } });

    expect(store().toasts).toHaveLength(0);
  });

  it('reports a whole batch held at the floor as one warning', () => {
    store().addPrimitive('cube');
    const first = activeObject().id;
    store().addPrimitive('cube');
    const second = activeObject().id;
    useEditorStore.setState({ toasts: [] });

    store().setObjectTransforms([
      { id: first, transform: { scale: { x: 0, y: 0, z: 0 } } },
      { id: second, transform: { scale: { x: 0, y: 0, z: 0 } } },
    ]);

    const toasts = store().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('2 objects');
  });

  it('will not build a primitive finer than the size floor', () => {
    store().addPrimitive('cube');

    store().updatePrimitiveParams({ size: 0 });

    expect(activeObject().primitive?.params.size).toBe(MIN_OBJECT_SIZE);
  });

  it('says so when a primitive length is dialled past the floor', () => {
    store().addPrimitive('cube');
    useEditorStore.setState({ toasts: [] });

    store().updatePrimitiveParams({ size: 0 });
    store().updatePrimitiveParams({ size: 0 });

    const toasts = store().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('size limit');
  });

  it('counts the scale and the length dials apart', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    useEditorStore.setState({ toasts: [] });

    // Already held at the floor by scale, which says nothing about what the
    // SIZE field is allowed to do next.
    store().setObjectTransform(id, { scale: { x: 1e-9, y: 1e-9, z: 1e-9 } });
    store().updatePrimitiveParams({ size: 0 });

    expect(store().toasts).toHaveLength(2);
  });

  it('flips the winding when a mirrored scale is baked in', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    store().setObjectTransform(id, { scale: { x: -1, y: 1, z: 1 } });
    useEditorStore.setState({ selectedObjectIds: [id] });

    store().applyTransformToSelected();

    // Mirroring reverses the winding, so without the flip every face of the
    // box would end up pointing into it. The box sits on the origin, so an
    // outward normal is one that agrees with its own face centre.
    const mesh = activeObject().mesh;
    const outward = [...mesh.faces.values()].every(
      (face) => dot(face.normal, mesh.faceCenter(face)) > 0,
    );
    expect(outward).toBe(true);
  });

  it('refuses to bake into a mesh that two objects share', () => {
    store().addPrimitive('cube');
    store().setActiveObject(activeObject().id);
    store().duplicateSelected(true);

    const ids = store().objects.map((object) => object.id);
    for (const id of ids) store().setObjectTransform(id, { scale: { x: 2, y: 2, z: 2 } });
    useEditorStore.setState({ selectedObjectIds: ids });

    store().applyTransformToSelected();

    expect(store().objects.every((object) => object.transform.scale.x === 2)).toBe(true);
    expect(store().status).toContain('single-user');
  });

  it('evaluates modifiers without touching the base mesh', () => {
    store().addPrimitive('cube');
    store().addModifier('array');

    const object = activeObject();
    expect(object.mesh.faces.size).toBe(6);
    expect(evaluatedMesh(object).faces.size).toBe(18);
  });

  it('centres on the whole array, not the first copy', () => {
    store().addPrimitive('cube');
    const before = displayCenter(activeObject(), evaluatedMesh(activeObject()));
    expect(before.x).toBeCloseTo(0);

    store().addModifier('array');

    // Default array is 3 copies of a 1 m box along +X, spanning -0.5..2.5. The
    // gizmo sits on the origin and stays where it was; this is what the cursor
    // snaps to and what the camera frames, which follow the shape instead.
    const after = displayCenter(activeObject(), evaluatedMesh(activeObject()));
    expect(after.x).toBeCloseTo(1);
    expect(after.y).toBeCloseTo(0);
    expect(after.z).toBeCloseTo(0);
  });

  it('carries the centre through the object transform', () => {
    store().addPrimitive('cube');
    store().addModifier('array');
    const object = activeObject();
    store().setObjectTransforms([
      { id: object.id, transform: { position: { x: 10, y: 0, z: 0 } } },
    ]);

    const center = displayCenter(activeObject(), evaluatedMesh(activeObject()));
    expect(center.x).toBeCloseTo(11);
  });

  it('puts the origin back on the geometry an edit walked away from', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    store().setObjectTransforms([{ id, transform: { position: { x: 4, y: 0, z: 0 } } }]);
    driftMesh(vec3(0, 3, 0));

    store().originToGeometry();

    // The origin is where the gizmo and the marker sit, so both land back on
    // the box, and the box itself has not moved a millimetre.
    const object = activeObject();
    expect(object.transform.position.x).toBeCloseTo(4);
    expect(object.transform.position.y).toBeCloseTo(3);
    expect(object.mesh.boundingBox().max.y).toBeCloseTo(0.5);
  });

  it('carries the origin through the object rotation and scale', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    store().setObjectTransforms([{ id, transform: { scale: { x: 2, y: 2, z: 2 } } }]);
    driftMesh(vec3(1, 0, 0));

    store().originToGeometry();

    // The mesh moved 1 in object space under a 2x scale, so the origin owes 2.
    expect(activeObject().transform.position.x).toBeCloseTo(2);
  });

  it('leaves a centred origin alone and says so', () => {
    store().addPrimitive('cube');
    store().originToGeometry();

    expect(activeObject().transform.position.x).toBeCloseTo(0);
    expect(store().status).toContain('already');
    // Nothing changed, so nothing was recorded: one step back is the add.
    store().undo();
    expect(store().objects).toHaveLength(0);
  });

  it('refuses to move the origin of a linked mesh', () => {
    store().addPrimitive('cube');
    driftMesh(vec3(0, 3, 0));
    store().duplicateSelected(true);
    store().selectAllObjects();

    store().originToGeometry();

    expect(store().objects.every((object) => object.transform.position.y === 0)).toBe(true);
    expect(store().status).toContain('single-user');
  });

  it('steps back from an origin move', () => {
    store().addPrimitive('cube');
    driftMesh(vec3(0, 3, 0));

    store().originToGeometry();
    expect(activeObject().transform.position.y).toBeCloseTo(3);

    store().undo();
    expect(activeObject().transform.position.y).toBeCloseTo(0);
    expect(activeObject().mesh.boundingBox().max.y).toBeCloseTo(3.5);
  });

  it('moves every selected origin onto the cursor and leaves the geometry where it stands', () => {
    store().addPrimitive('cube');
    const first = activeObject().id;
    store().setObjectTransforms([{ id: first, transform: { position: { x: 2, y: 0, z: 0 } } }]);
    store().addPrimitive('cube');
    const second = activeObject().id;
    store().setObjectTransforms([{ id: second, transform: { position: { x: 6, y: 0, z: 0 } } }]);
    store().selectAllObjects();
    store().setCursor({ x: 0, y: 1, z: 0 });

    store().originToCursor();

    // Both land on the one point, which is what gives a set of parts a shared
    // hinge, and each box keeps the world position it had.
    const [near, far] = store().objects;
    expect(near.transform.position).toEqual({ x: 0, y: 1, z: 0 });
    expect(far.transform.position).toEqual({ x: 0, y: 1, z: 0 });
    expect(near.mesh.boundingBox().max.x).toBeCloseTo(2.5);
    expect(near.mesh.boundingBox().max.y).toBeCloseTo(-0.5);
    expect(far.mesh.boundingBox().max.x).toBeCloseTo(6.5);
  });

  it('reads the cursor through the object scale when it moves the origin', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    store().setObjectTransforms([{ id, transform: { scale: { x: 2, y: 2, z: 2 } } }]);
    store().setCursor({ x: 4, y: 0, z: 0 });

    store().originToCursor();

    // The origin gained 4 in world under a 2x scale, so the vertices owe 2.
    expect(activeObject().transform.position.x).toBeCloseTo(4);
    expect(activeObject().mesh.boundingBox().max.x).toBeCloseTo(-1.5);
  });

  it('leaves an origin already on the cursor alone and says so', () => {
    store().addPrimitive('cube');

    store().originToCursor();

    expect(store().status).toContain('already');
    // Nothing changed, so nothing was recorded: one step back is the add.
    store().undo();
    expect(store().objects).toHaveLength(0);
  });

  it('refuses to move the origin of a linked mesh onto the cursor', () => {
    store().addPrimitive('cube');
    store().duplicateSelected(true);
    store().selectAllObjects();
    store().setCursor({ x: 3, y: 0, z: 0 });

    store().originToCursor();

    expect(store().objects.every((object) => object.transform.position.x === 0)).toBe(true);
    expect(store().status).toContain('single-user');
  });

  it('moves the cursor onto the selection and the selection back onto it', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    store().setObjectTransforms([{ id, transform: { position: { x: 4, y: 1, z: -2 } } }]);

    store().cursorToSelection();
    expect(store().cursor.x).toBeCloseTo(4);
    expect(store().cursor.y).toBeCloseTo(1);
    expect(store().cursor.z).toBeCloseTo(-2);

    store().setCursor({ x: 0, y: 5, z: 0 });
    store().selectionToCursor();
    expect(activeObject().transform.position.y).toBeCloseTo(5);
    expect(activeObject().transform.position.x).toBeCloseTo(0);
  });

  it('carries an edit-mode selection to the cursor along world axes, not local ones', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    // A quarter turn about Y, so the object's own X points along world -Z. A
    // world offset applied straight to the vertices lands the selection there
    // instead of on the cursor.
    store().setObjectTransforms([{ id, transform: { rotation: vec3(0, Math.PI / 2, 0) } }]);
    store().setMode('edit');
    store().exec('selectAll', {}, 'Select all');
    store().setCursor({ x: 3, y: 0, z: 0 });

    store().selectionToCursor();

    const object = activeObject();
    const moved = displayCenter(object, evaluatedMesh(object, store().cursor, store().meshVersion));
    expect(moved.x).toBeCloseTo(3, 6);
    expect(moved.y).toBeCloseTo(0, 6);
    expect(moved.z).toBeCloseTo(0, 6);
  });

  it('separates the selection origin from the middle of its geometry', () => {
    store().addPrimitive('cube');
    driftMesh(vec3(0, 3, 0));

    store().cursorToSelection();
    expect(store().cursor.y).toBeCloseTo(3);

    // The edit moved the mesh and left the origin behind, which is the whole
    // reason the two entries are not one entry.
    store().cursorToSelectionOrigin();
    expect(store().cursor.y).toBeCloseTo(0);
  });

  it('takes the median of the origins across a multi-object selection', () => {
    store().addPrimitive('cube');
    const first = activeObject().id;
    store().setObjectTransforms([{ id: first, transform: { position: { x: 2, y: 0, z: 0 } } }]);
    store().addPrimitive('cube');
    const second = activeObject().id;
    store().setObjectTransforms([{ id: second, transform: { position: { x: 6, y: 0, z: 0 } } }]);
    store().selectAllObjects();

    store().cursorToSelectionOrigin();

    expect(store().cursor.x).toBeCloseTo(4);
  });

  it('reads the edited object off its own origin, not off the picked vertices', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    store().setObjectTransforms([{ id, transform: { position: { x: 0, y: 7, z: 0 } } }]);
    store().setMode('edit');
    selectTopFace();

    store().cursorToSelectionOrigin();

    // The face sits half a metre above the origin; vertices are not objects and
    // have no origin between them, so the object's own is what answers.
    expect(store().cursor.y).toBeCloseTo(7);
  });

  it('says so rather than snapping to the origin when nothing is selected', () => {
    store().addPrimitive('cube');
    store().setActiveObject(null);

    store().cursorToSelection();

    expect(store().cursor).toEqual({ x: 0, y: 0, z: 0 });
    expect(store().status).toBe('Nothing selected');
  });

  it('mirrors about the cursor once the modifier is pointed at it', () => {
    store().addPrimitive('cube');
    store().setCursor({ x: 5, y: 0, z: 0 });
    store().addModifier('mirror');
    const modifier = activeObject().modifiers[0];
    store().updateModifier(modifier.id, { origin: 'cursor' });

    // Box spans -0.5..0.5; reflected across x = 5 the copy lands at 9.5..10.5.
    const display = evaluatedMesh(activeObject(), store().cursor);
    expect(display.boundingBox().max.x).toBeCloseTo(10.5);
  });

  it('measures the cursor plane in the frame the object itself uses', () => {
    store().addPrimitive('cube');
    const id = activeObject().id;
    store().setObjectTransforms([{ id, transform: { scale: { x: 2, y: 2, z: 2 } } }]);
    store().setCursor({ x: 4, y: 0, z: 0 });
    store().addModifier('mirror');
    const modifier = activeObject().modifiers[0];
    store().updateModifier(modifier.id, { origin: 'cursor' });

    // The object is drawn at twice size, so the cursor at world x = 4 is x = 2
    // in the local space the modifier works in, and the copy lands at 3.5..4.5.
    const display = evaluatedMesh(activeObject(), store().cursor);
    expect(display.boundingBox().max.x).toBeCloseTo(4.5);
  });

  it('keeps the mirrored half in step with the vertices it copies', () => {
    store().addPrimitive('cube');
    store().addModifier('mirror');

    const before = evaluatedMesh(activeObject(), store().cursor, store().meshVersion);
    expect(before.boundingBox().max.x).toBeCloseTo(0.5);

    driftMesh({ x: 3, y: 0, z: 0 });

    // The stack result is memoised on the mesh version, so an edit that moves
    // vertices has to bump it or the copy would sit where they used to be.
    const after = evaluatedMesh(activeObject(), store().cursor, store().meshVersion);
    expect(after.boundingBox().min.x).toBeCloseTo(-3.5);
    expect(after.boundingBox().max.x).toBeCloseTo(3.5);
  });

  it('bakes a modifier into the mesh on apply', () => {
    store().addPrimitive('cube');
    store().addModifier('array');
    const modifierId = activeObject().modifiers[0].id;

    store().applyModifierToMesh(modifierId);

    expect(activeObject().modifiers).toHaveLength(0);
    expect(activeObject().mesh.faces.size).toBe(18);
  });

  it('round-trips the scene through a project file', () => {
    store().addPrimitive('cube');
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
    store().addPrimitive('cube');
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
    const fbx = exportFBX(exportable);

    expect(obj.split('\n').filter((line) => line.startsWith('f '))).toHaveLength(18);
    expect(new TextDecoder().decode(fbx.subarray(0, 18))).toBe('Kaydara FBX Binary');
  });

  it('carries the selection across select-mode changes', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    selectTopFace();
    expect(activeObject().mesh.selectedVerts()).toHaveLength(4);

    store().setSelectMode('vertex');
    expect(activeObject().mesh.selectedVerts()).toHaveLength(4);

    store().setSelectMode('face');
    expect(activeObject().mesh.selectedFaces()).toHaveLength(1);
  });

  it('takes nothing new along on a select-mode change', () => {
    store().addPrimitive('cylinder');
    store().setMode('edit');
    store().setSelectMode('face');

    // Every side face, caps left out: the selection a drag across the whole
    // cylinder takes now that touching one is enough.
    const mesh = activeObject().mesh;
    mesh.deselectAll();
    const sides = [...mesh.faces.values()].filter((face) => Math.abs(face.normal.y) < 0.5);
    for (const face of sides) face.selected = true;
    mesh.flushSelection('face');
    expect(mesh.selectedFaces()).toHaveLength(sides.length);

    // Both caps are ringed by vertices the side faces already own, so deriving
    // the faces afresh from them used to hand back the whole cylinder.
    store().setSelectMode('vertex');
    store().setSelectMode('face');

    expect(mesh.selectedFaces()).toHaveLength(sides.length);
  });

  it('keeps vertices that never closed a face when face mode comes and goes', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('vertex');

    const mesh = activeObject().mesh;
    mesh.deselectAll();
    const pair = [...mesh.verts.values()].slice(0, 2);
    for (const vert of pair) vert.selected = true;
    mesh.flushSelection('vertex');

    store().setSelectMode('face');
    store().setSelectMode('vertex');

    expect(mesh.selectedVerts()).toHaveLength(2);
  });

  it('bumps the mesh version so the viewport resyncs', () => {
    const before = store().meshVersion;
    store().addPrimitive('cube');
    expect(store().meshVersion).toBeGreaterThan(before);

    const afterAdd = store().meshVersion;
    store().setMode('edit');
    selectTopFace();
    store().exec('subdivide', { cuts: 1 }, 'Subdivide');
    expect(store().meshVersion).toBeGreaterThan(afterAdd);
  });

  it('selects every object in the scene, the object-mode equivalent of edit-mode select all', () => {
    store().addPrimitive('cube');
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
    store().addPrimitive('cube');
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
    store().addPrimitive('cube');
    const id = store().objects[0].id;
    const originalPosition = store().objects[0].transform.position;

    store().setObjectTransforms([
      { id: 'not-a-real-id', transform: { position: { x: 9, y: 9, z: 9 } } },
    ]);

    expect(store().objects.find((o) => o.id === id)?.transform.position).toEqual(originalPosition);
  });

  it('does nothing on an empty patch list', () => {
    store().addPrimitive('cube');
    const versionBefore = store().meshVersion;

    store().setObjectTransforms([]);

    expect(store().meshVersion).toBe(versionBefore);
  });
});

describe('the 3D cursor as an edit of its own', () => {
  beforeEach(() => {
    store().resetScene();
  });

  it('undoes the cursor move and leaves the model where it stands', () => {
    store().addPrimitive('cube');
    const id = store().objects[0].id;
    store().setObjectTransform(id, { position: vec3(-5, 0, 0) });
    store().recordHistory('Move object');
    store().setObjectTransform(id, { position: vec3(-2, 0, 0) });

    store().setCursor(vec3(1, 2, 3), 'Cursor placed');
    store().undo();

    // The cursor rides in the document, so undo always put it back. What it had
    // no entry of its own for was the placement: Ctrl+Z used to take the move
    // before it as well, and the box went back to -5 along with the cursor.
    expect(store().cursor).toEqual(vec3(0, 0, 0));
    expect(store().objects[0].transform.position).toEqual(vec3(-2, 0, 0));
    expect(store().status).toBe('Undo: Cursor placed');
  });

  it('names the placement it undoes, however the cursor got there', () => {
    store().addPrimitive('cube');
    store().setObjectTransform(store().objects[0].id, { position: vec3(4, 0, 0) });

    store().cursorToSelection();

    expect(store().historyUndo[0]).toBe('Cursor to selection');
    expect(store().cursor.x).toBeCloseTo(4);
  });

  it('records nothing for a placement that lands where the cursor already is', () => {
    store().addPrimitive('cube');
    const steps = store().historyUndo.length;

    store().setCursor(vec3(0, 0, 0), 'Cursor to world origin');

    // Shift+C twice is one placement and one no-op, and the no-op must not bury
    // the edit behind it.
    expect(store().historyUndo.length).toBe(steps);
    expect(store().status).toBe('Cursor to world origin');
  });
});

describe('history timeline', () => {
  beforeEach(() => {
    store().resetScene();
    store().setPreferences({ historySize: 50 });
  });

  it('lists what each step would take back, newest first', () => {
    store().addPrimitive('cube');
    store().addPrimitive('cylinder');

    expect(store().historyUndo).toEqual(['Add CYLINDER', 'Add CUBE']);
    expect(store().historyRedo).toEqual([]);
  });

  it('travels several steps in one move and can come back', () => {
    store().addPrimitive('cube');
    store().addPrimitive('cylinder');
    store().addPrimitive('cone');

    store().undoTimes(3);

    expect(store().objects).toHaveLength(0);
    expect(store().status).toBe('Undo 3 steps, back to: Add CUBE');
    expect(store().historyRedo).toEqual(['Add CUBE', 'Add CYLINDER', 'Add CONE']);

    store().redoTimes(2);

    expect(store().objects).toHaveLength(2);
    expect(store().status).toBe('Redo 2 steps, up to: Add CYLINDER');
    expect(store().historyUndo).toEqual(['Add CYLINDER', 'Add CUBE']);
  });

  it('stops at the end of the timeline rather than running off it', () => {
    store().addPrimitive('cube');

    store().undoTimes(10);

    expect(store().objects).toHaveLength(0);
    expect(store().canUndo).toBe(false);
    expect(store().status).toBe('Undo: Add CUBE');
  });

  it('leaves the project name alone, which no step recorded', () => {
    store().addPrimitive('cube');
    store().setProjectName('LAMP POST');

    store().undo();

    // The name says which file SAVE writes over, so taking it back along with
    // an unrelated step would quietly grey SAVE out.
    expect(store().objects).toHaveLength(0);
    expect(store().projectName).toBe('LAMP POST');

    store().setProjectName('CRATE');
    store().redo();

    expect(store().objects).toHaveLength(1);
    expect(store().projectName).toBe('CRATE');
  });

  it('drops the oldest steps when the size is lowered', () => {
    for (let step = 0; step < 12; step++) store().addPrimitive('cube');
    expect(store().historyUndo).toHaveLength(12);

    store().setPreferences({ historySize: 10 });

    // Lowering it is how the memory those snapshots hold is handed back, so the
    // trim happens on the slider rather than at the next edit.
    expect(store().historyUndo).toHaveLength(10);

    store().setPreferences({ historySize: 50 });
    expect(store().historyUndo).toHaveLength(10);
  });
});

describe('edge length', () => {
  beforeEach(() => {
    store().resetScene();
    store().addPrimitive('cube');
    store().setMode('edit');
  });

  /** Selects two edges of the active mesh that share no vertex. */
  function selectDisjointEdges(): Edge[] {
    const mesh = activeObject().mesh;
    const edges = [...mesh.edges.values()];
    const ends = [edges[0].v0.id, edges[0].v1.id];
    const apart = edges.find((edge) => !ends.includes(edge.v0.id) && !ends.includes(edge.v1.id));
    if (!apart) throw new Error('No edge found that stands apart from the first');

    mesh.deselectAll();
    edges[0].selected = true;
    apart.selected = true;
    mesh.flushSelection('edge');
    return [edges[0], apart];
  }

  /** Selects two edges that meet, which is what the operator refuses. */
  function selectTouchingEdges(): Edge[] {
    const mesh = activeObject().mesh;
    const edges = [...mesh.edges.values()];
    const touching = edges.find(
      (edge) => edge !== edges[0] && [edges[0].v0.id, edges[0].v1.id].includes(edge.v0.id),
    );
    if (!touching) throw new Error('No edge found meeting the first');

    mesh.deselectAll();
    edges[0].selected = true;
    touching.selected = true;
    mesh.flushSelection('edge');
    return [edges[0], touching];
  }

  it('sets the selected edges to a length measured out in the world', () => {
    const object = activeObject();
    store().setObjectTransform(object.id, { scale: vec3(2, 2, 2) });
    const selected = selectDisjointEdges();

    store().exec('setEdgeLength', { length: 1 }, 'Set edge length');

    for (const edge of selected) expect(edgeLength(edge, vec3(2, 2, 2))).toBeCloseTo(1);
    expect(store().status).toBe('Set 2 edge(s) to 1m');
  });

  it('refuses edges that meet, keeping both the mesh and the timeline as they were', () => {
    selectTouchingEdges();
    const before = [...activeObject().mesh.verts.values()].map((vert) => ({ ...vert.co }));
    const steps = store().historyUndo.length;

    store().exec('setEdgeLength', { length: 1 }, 'Set edge length');

    const after = [...activeObject().mesh.verts.values()];
    after.forEach((vert, index) => expect(vert.co).toEqual(before[index]));
    expect(store().status).toContain('meet at a vertex');
    expect(store().historyUndo).toHaveLength(steps);
  });

  it('records no step of its own for a tick of a continuous edit', () => {
    const selected = selectDisjointEdges();
    const steps = store().historyUndo.length;

    // What a scrub of the LENGTH label sends: the step to undo back to was
    // taken when the drag began, so the ticks record none of their own.
    store().recordHistory('Set edge length');
    for (const length of [0.9, 0.8, 0.7]) {
      store().exec('setEdgeLength', { length }, 'Set edge length', { record: false });
    }

    expect(store().historyUndo).toHaveLength(steps + 1);
    for (const edge of selected) expect(edgeLength(edge, vec3(1, 1, 1))).toBeCloseTo(0.7);

    // Undo loads a document rather than editing the mesh in place, so the
    // restored box is read back out of the store rather than through `selected`.
    store().undo();
    for (const edge of activeObject().mesh.edges.values()) {
      expect(edgeLength(edge, vec3(1, 1, 1))).toBeCloseTo(1);
    }
  });

  it('keeps the reserved step when a tick of a continuous edit is refused', () => {
    selectTouchingEdges();
    const steps = store().historyUndo.length;

    store().recordHistory('Set edge length');
    store().exec('setEdgeLength', { length: 1 }, 'Set edge length', { record: false });

    // The refusal used to drop whatever step was on top, which here is the one
    // the gesture reserved before it started rather than one of its own.
    expect(store().historyUndo).toHaveLength(steps + 1);
  });

  it('refuses when nothing is selected', () => {
    activeObject().mesh.deselectAll();

    store().exec('setEdgeLength', { length: 1 }, 'Set edge length');

    expect(store().status).toBe('Select the edge(s) to set a length for');
  });
});
