import { beforeEach, describe, expect, it } from 'vitest';

import { dot, exportFBXAscii, exportOBJ, parseProject, stringifyProject } from '@kernel/index';

import { displayCenter, evaluatedMesh } from './slices/scene';
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

  it('reaches for the move tool, so the new primitive has a gizmo to grab', () => {
    store().setActiveTool('select');

    store().addPrimitive('box');

    expect(store().activeTool).toBe('move');
    // The add is what the status line says; switching tool must not bury it.
    expect(store().status).toBe('Added BOX');
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
    store().addPrimitive('box');
    store().setMode('edit');
    selectTopFace();

    store().assignMaterialToSelection();

    // Rebuilding from the parameters would drop the per-face assignment, so the
    // parameters are what gives way.
    expect(activeObject().primitive).toBeNull();
  });

  it('keeps parameters live through anything that leaves the mesh alone', () => {
    store().addPrimitive('box');
    const id = activeObject().id;

    store().setObjectTransform(id, { position: { x: 2, y: 0, z: 0 } });
    store().addModifier('array');
    store().renameObject(id, 'CRATE');

    // Moving the object, stacking a modifier and renaming all leave the mesh
    // exactly as the parameters describe it.
    expect(activeObject().primitive?.kind).toBe('box');
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

  it('still knows the first-selected vertex after an undo', () => {
    store().addPrimitive('box');
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

  it('refuses to fold a face when dissolving a cube corner vertex', () => {
    store().addPrimitive('box');
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
    store().addPrimitive('box');
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
    store().addPrimitive('box');
    store().setMode('edit');
    // Explicit: resetScene leaves selectMode as the previous test left it.
    store().setSelectMode('face');
    selectTopFace();

    store().exec('subdivide', { cuts: 1, smooth: 0 }, 'Subdivide');

    expect(activeObject().mesh.faces.size).toBe(9);
    expect(store().status).toMatch(/Subdivided 1 face/);
  });

  it('dissolves a vertex sitting in the middle of an edge', () => {
    store().addPrimitive('box');
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
    store().addPrimitive('box');
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
    store().addPrimitive('box');
    store().setMode('edit');
    store().setSelectMode('face');
    selectTopFace();

    store().exec('shade', { smooth: true }, 'Shade smooth');

    expect(store().recentVerts).toBeNull();
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

  it('holds a linked duplicate on one mesh through an undo', () => {
    store().addPrimitive('box');
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
    store().addPrimitive('box');
    const first = activeObject().id;
    store().addPrimitive('box');
    const second = activeObject().id;
    store().setObjectTransform(second, { position: { x: 3, y: 0, z: 0 } });
    useEditorStore.setState({ selectedObjectIds: [first, second], activeObjectId: first });

    store().mergeSelected();

    expect(store().objects).toHaveLength(1);
    const joined = activeObject();
    expect(joined.id).toBe(first);
    expect(joined.mesh.faces.size).toBe(12);
    // Carried through world space: the second box keeps its 3 m offset instead
    // of landing back on the target's origin.
    const box = joined.mesh.boundingBox();
    expect(box.min.x).toBeCloseTo(-0.5);
    expect(box.max.x).toBeCloseTo(3.5);
  });

  it('merges a linked duplicate into its own original', () => {
    store().addPrimitive('box');
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
    store().addPrimitive('box');
    const first = activeObject().id;
    store().addPrimitive('box');
    const second = activeObject().id;
    store().setObjectTransform(second, { position: { x: 3, y: 0, z: 0 } });
    useEditorStore.setState({ selectedObjectIds: [first, second], activeObjectId: first });
    store().mergeSelected();

    store().separateLooseParts();

    expect(store().objects).toHaveLength(2);
    for (const object of store().objects) expect(object.mesh.faces.size).toBe(6);
    // The two boxes were 3 m apart when merged and stay 3 m apart after: the
    // parts come out where the geometry sits, not stacked on the origin.
    const centres = store().objects.map((object) => object.mesh.boundingBox().min.x);
    expect(Math.abs(centres[0] - centres[1])).toBeCloseTo(3);
    expect(store().selectedObjectIds).toHaveLength(2);
  });

  it('says so rather than acting when the mesh is one piece', () => {
    store().addPrimitive('box');
    const before = store().objects.length;

    store().separateLooseParts();

    expect(store().objects).toHaveLength(before);
    expect(store().status).toMatch(/one connected piece/);
  });

  it('refuses to separate a mesh another object shares', () => {
    store().addPrimitive('box');
    store().setActiveObject(activeObject().id);
    store().duplicateSelected(true);

    store().separateLooseParts();

    expect(store().objects).toHaveLength(2);
    expect(store().status).toContain('single-user');
  });

  it('leaves objects outside the merge unchanged when they share the mesh', () => {
    store().addPrimitive('box');
    const original = activeObject().id;
    store().setActiveObject(original);
    store().duplicateSelected(true);
    const linked = activeObject().id;
    store().addPrimitive('box');
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
    store().addPrimitive('box');
    store().setActiveObject(activeObject().id);
    store().duplicateSelected(true);
    store().setActiveObject(store().objects[0].id);

    store().updatePrimitiveParams({ size: 4 });

    const [original, copy] = store().objects;
    expect(original.mesh === copy.mesh).toBe(true);
    expect(copy.mesh.boundingBox().max.x).toBeCloseTo(2);
  });

  it('leaves the copy selected and under the move gizmo', () => {
    store().addPrimitive('box');
    const original = activeObject().id;

    store().duplicateSelected(false);

    // The copy sits exactly on top of the original, so the gizmo it needs to be
    // dragged off with has to be there without a tool change first.
    expect(store().activeObjectId).not.toBe(original);
    expect(store().selectedObjectIds).toEqual([store().activeObjectId]);
    expect(store().activeTool).toBe('move');
  });

  it('bakes rotation and scale into the mesh, leaving the object where it sits', () => {
    store().addPrimitive('box');
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

  it('flips the winding when a mirrored scale is baked in', () => {
    store().addPrimitive('box');
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
    store().addPrimitive('box');
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
    store().addPrimitive('box');
    store().addModifier('array');

    const object = activeObject();
    expect(object.mesh.faces.size).toBe(6);
    expect(evaluatedMesh(object).faces.size).toBe(18);
  });

  it('centres the gizmo on the whole array, not the first copy', () => {
    store().addPrimitive('box');
    const before = displayCenter(activeObject(), evaluatedMesh(activeObject()));
    expect(before.x).toBeCloseTo(0);

    store().addModifier('array');

    // Default array is 3 copies of a 1 m box along +X, spanning -0.5..2.5.
    const after = displayCenter(activeObject(), evaluatedMesh(activeObject()));
    expect(after.x).toBeCloseTo(1);
    expect(after.y).toBeCloseTo(0);
    expect(after.z).toBeCloseTo(0);
  });

  it('carries the gizmo centre through the object transform', () => {
    store().addPrimitive('box');
    store().addModifier('array');
    const object = activeObject();
    store().setObjectTransforms([
      { id: object.id, transform: { position: { x: 10, y: 0, z: 0 } } },
    ]);

    const center = displayCenter(activeObject(), evaluatedMesh(activeObject()));
    expect(center.x).toBeCloseTo(11);
  });

  it('moves the cursor onto the selection and the selection back onto it', () => {
    store().addPrimitive('box');
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

  it('says so rather than snapping to the origin when nothing is selected', () => {
    store().addPrimitive('box');
    store().setActiveObject(null);

    store().cursorToSelection();

    expect(store().cursor).toEqual({ x: 0, y: 0, z: 0 });
    expect(store().status).toBe('Nothing selected');
  });

  it('mirrors about the cursor once the modifier is pointed at it', () => {
    store().addPrimitive('box');
    store().setCursor({ x: 5, y: 0, z: 0 });
    store().addModifier('mirror');
    const modifier = activeObject().modifiers[0];
    store().updateModifier(modifier.id, { origin: 'cursor' });

    // Box spans -0.5..0.5; reflected across x = 5 the copy lands at 9.5..10.5.
    const display = evaluatedMesh(activeObject(), store().cursor);
    expect(display.boundingBox().max.x).toBeCloseTo(10.5);
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

    store().setObjectTransforms([
      { id: 'not-a-real-id', transform: { position: { x: 9, y: 9, z: 9 } } },
    ]);

    expect(store().objects.find((o) => o.id === id)?.transform.position).toEqual(originalPosition);
  });

  it('does nothing on an empty patch list', () => {
    store().addPrimitive('box');
    const versionBefore = store().meshVersion;

    store().setObjectTransforms([]);

    expect(store().meshVersion).toBe(versionBefore);
  });
});
