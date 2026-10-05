import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  type Vec3,
  cloneMesh,
  degToRad,
  execOperator,
  medianPoint,
  rotateVerts,
  scaleVerts,
  translateVerts,
  vec3,
} from '@kernel/index';
import { activeObject, useEditorStore } from '@store/index';

import { clearActionLog, installRecorder, readActionLog } from './recorder';
import { runScript } from './runScript';

const store = () => useEditorStore.getState();

function editing() {
  const object = activeObject(store());
  if (!object) throw new Error('No active object');
  return object;
}

const id = (name: string) => store().objects.find((object) => object.name === name)?.id ?? '';

/** Picks the faces facing up, the way a click in face select mode would. */
function pickTop() {
  const { mesh } = editing();
  mesh.deselectAll();
  for (const face of mesh.faces.values()) if (face.normal.y > 0.99) face.selected = true;
  mesh.flushSelection('face');
  store().touchMesh();
}

/** A viewport gesture: a step opened, the vertices moved in place, nothing else. */
function gesture(label: string, move: () => void) {
  store().recordHistory(label);
  move();
  store().touchMesh();
}

const round = (value: number) => Math.round(value * 1e4) / 1e4 + 0;
const point = (v: Vec3) => [round(v.x), round(v.y), round(v.z)];

/** The scene as a replay of the log has to rebuild it, whatever the mesh's ids. */
function scene() {
  return store().objects.map((object) => ({
    name: object.name,
    position: point(object.transform.position),
    rotation: point(object.transform.rotation),
    scale: point(object.transform.scale),
    verts: [...object.mesh.verts.values()].map((vert) => point(vert.co).join(' ')).sort(),
    faces: object.mesh.faces.size,
    materials: object.materials.map(({ color }) => [color.r, color.g, color.b].map(round)),
    // A replayed modifier is a new one, with an id of its own.
    modifiers: object.modifiers.map((modifier) => ({ ...modifier, id: undefined })),
  }));
}

/** Runs the log on an empty scene and expects the scene it was written from. */
async function replay() {
  const log = readActionLog();
  const expected = scene();
  store().resetScene();
  store().setMode('object');
  const outcome = await runScript(log);
  expect(outcome, log).toMatchObject({ ok: true });
  expect(scene()).toEqual(expected);
}

describe('the action log', () => {
  beforeAll(installRecorder);

  beforeEach(() => {
    store().resetScene();
    store().setHistoryLimit(50);
    clearActionLog();
  });

  it('writes what is added, moved and selected as the script that does it', async () => {
    store().addPrimitive('cube');
    store().setObjectTransform(id('CUBE'), { position: vec3(1, 0, 0) });
    store().setObjectTransform(id('CUBE'), { position: vec3(2, 0.5, 0) });
    store().addPrimitive('uvSphere', { radius: 2 });
    store().setObjectTransform(id('UV SPHERE'), { rotation: vec3(0, degToRad(90), 0) });
    store().setActiveObject(id('CUBE'));

    expect(readActionLog()).toBe(
      [
        "scene.add('cube');",
        "scene.find('CUBE').position = [2, 0.5, 0];",
        "scene.add('uvSphere', { radius: 2 });",
        "scene.find('UV SPHERE').rotation = [0, 90, 0];",
        "scene.select('CUBE');",
      ].join('\n'),
    );
    await replay();
  });

  it('puts a shape option changed after the add back on the line that added it', async () => {
    store().addPrimitive('cylinder');
    store().setObjectTransform(id('CYLINDER'), { position: vec3(0, 1, 0) });
    store().updatePrimitiveParams({ segments: 8 });

    expect(readActionLog()).toBe(
      [
        "scene.add('cylinder', { segments: 8 });",
        "scene.find('CYLINDER').position = [0, 1, 0];",
      ].join('\n'),
    );
    await replay();
  });

  it('writes a script run as having run, and nothing it did on the way', async () => {
    await runScript(`scene.add('cube'); scene.add('cone').position = [2, 0, 0];`);
    expect(readActionLog()).toBe('// Ran a script');
  });

  it('writes edit mode operations inside an edit of the object, selecting only when it changed', async () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('face');
    pickTop();
    store().exec('extrude', { offset: 1 }, 'Extrude');
    store().exec('inset', { thickness: 0.1 }, 'Inset');

    expect(readActionLog()).toBe(
      [
        "scene.add('cube');",
        "scene.find('CUBE').edit((mesh) => {",
        '  mesh.selectFaces([[0, 0.5, 0]]);',
        '  mesh.extrude({ offset: 1 });',
        '  mesh.inset({ thickness: 0.1 });',
        '});',
      ].join('\n'),
    );
    await replay();
  });

  it('describes a drag of the selection as a translate, and forgets one called off', async () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('face');
    pickTop();
    const { mesh } = editing();

    gesture('MOVE selection', () => translateVerts(mesh, mesh.selectedVerts(), vec3(0, 0.25, 0)));
    store().recordHistory('MOVE selection');
    translateVerts(mesh, mesh.selectedVerts(), vec3(4, 0, 0));
    translateVerts(mesh, mesh.selectedVerts(), vec3(-4, 0, 0));
    store().discardHistory();

    expect(readActionLog()).toBe(
      [
        "scene.add('cube');",
        "scene.find('CUBE').edit((mesh) => {",
        '  mesh.selectFaces([[0, 0.5, 0]]);',
        '  mesh.translate({ offset: [0, 0.25, 0] });',
        '});',
      ].join('\n'),
    );
    await replay();
  });

  it('describes a turn or a scale about the middle of the selection as one operation', async () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('face');
    pickTop();
    const { mesh } = editing();
    const pivot = () => medianPoint(mesh.selectedVerts());

    gesture('ROTATE selection', () =>
      rotateVerts(mesh, mesh.selectedVerts(), vec3(0, 1, 0), degToRad(30), pivot()),
    );
    gesture('SCALE selection', () =>
      scaleVerts(mesh, mesh.selectedVerts(), vec3(1.5, 1, 0.5), pivot()),
    );

    expect(readActionLog()).toContain(
      [
        '  mesh.selectFaces([[0, 0.5, 0]]);',
        "  mesh.rotate({ axis: 'y', angle: 30 });",
        '  mesh.scale({ scale: [1.5, 1, 0.5] });',
      ].join('\n'),
    );
    await replay();
  });

  it('says so when a move by hand has no operation that repeats it', () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('face');
    pickTop();
    const { mesh } = editing();

    gesture('ROTATE selection', () =>
      rotateVerts(mesh, mesh.selectedVerts(), vec3(0, 0, 1), degToRad(45), vec3(3, 0, 0)),
    );

    expect(readActionLog()).toContain('  // Rotate selection (no script equivalent)');
  });

  it('writes the operation a bevel drag ended on, and selects by place after the mesh is renumbered', async () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('face');
    pickTop();

    // As the drag does: previews on a copy, keeps the last copy, says what ran.
    store().recordHistory('INSET');
    const copy = cloneMesh(editing().mesh);
    const { cursor, proportional } = store();
    execOperator({ mesh: copy, selectMode: 'face', cursor, proportional }, 'inset', {
      thickness: 0.15,
    });
    store().patchActiveObject({ mesh: copy });
    store().noteOperator('inset', { thickness: 0.15 }, 'INSET');
    store().touchMesh();

    store().exec('extrude', { offset: 0.5 }, 'Extrude');
    pickTop();
    store().exec('delete', { mode: 'faces' }, 'Delete');

    const log = readActionLog();
    expect(log).toContain('  mesh.inset({ thickness: 0.15 });');
    expect(log).toContain("  mesh.delete({ mode: 'faces' });");
    await replay();
  });

  it('writes what is done to objects as a whole', async () => {
    store().addPrimitive('cube');
    store().addPrimitive('cone');
    store().renameObject(id('CONE'), 'SPIRE');
    store().setObjectTransform(id('SPIRE'), { position: vec3(0, 2, 0) });
    store().selectObjects([id('CUBE')]);
    store().duplicateSelected();
    store().setObjectTransform(id('CUBE.COPY'), { position: vec3(3, 0, 0) });
    store().selectObjects([id('CUBE.COPY'), id('CUBE')]);
    store().mergeSelected();
    store().addMaterial();
    store().updateMaterial(1, { color: { r: 1, g: 0, b: 0 } });
    store().addModifier('array');
    const array = editing().modifiers[0].id;
    store().updateModifier(array, { count: 3 });
    store().updateModifier(array, { count: 4 });
    store().toggleObjectVisibility(id('SPIRE'));
    store().deleteSelected([id('SPIRE')]);

    expect(readActionLog()).toBe(
      [
        "scene.add('cube');",
        "scene.add('cone');",
        "scene.find('CONE').name = 'SPIRE';",
        "scene.find('SPIRE').position = [0, 2, 0];",
        "scene.select('CUBE');",
        "scene.find('CUBE').duplicate();",
        "scene.find('CUBE.COPY').position = [3, 0, 0];",
        "scene.select('CUBE.COPY', 'CUBE');",
        "scene.join('CUBE', 'CUBE.COPY');",
        "scene.find('CUBE').addMaterial();",
        "scene.find('CUBE').materials[1].color = '#ff0000';",
        "scene.find('CUBE').addModifier('array');",
        "scene.find('CUBE').modifiers[0].set({ count: 4 });",
        "scene.find('SPIRE').visible = false;",
        "scene.delete('SPIRE');",
      ].join('\n'),
    );
    await replay();
  });

  it('notes an undo rather than taking anything off the log', () => {
    store().addPrimitive('cube');
    store().undo();
    expect(readActionLog()).toBe("scene.add('cube');\n// Undo: Add CUBE");
  });

  it('notes a change no script can make', () => {
    store().addPrimitive('cube');
    store().groupSelected();
    const [group] = store().groups;
    store().ungroup(group.id);

    expect(readActionLog()).toBe(
      ["scene.add('cube');", "scene.group(['CUBE']);", '// Ungroup (no script equivalent)'].join(
        '\n',
      ),
    );
  });
});
