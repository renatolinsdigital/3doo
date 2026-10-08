import { beforeEach, describe, expect, it } from 'vitest';

import { type Edge, type Face, degToRad, serializeMesh, vec3 } from '@kernel/index';
import { activeObject, useEditorStore } from '@store/index';

import { SCRIPT_EXAMPLES } from './examples';
import { runScript } from './runScript';
import { sceneScript } from './sceneScript';

const store = () => useEditorStore.getState();
const script = () => sceneScript(store()).source;

const id = (name: string) => store().objects.find((object) => object.name === name)?.id ?? '';

function editing() {
  const object = activeObject(store());
  if (!object) throw new Error('No active object');
  return object;
}

/** Picks the faces `test` passes in face select mode, the way clicks in the viewport would. */
function pickFaces(test: (face: Face) => boolean) {
  const { mesh } = editing();
  mesh.deselectAll();
  for (const face of mesh.faces.values()) if (test(face)) face.selected = true;
  mesh.flushSelection('face');
  store().setSelectMode('face');
  store().touchMesh();
}

function pickEdges(test: (edge: Edge) => boolean) {
  const { mesh } = editing();
  mesh.deselectAll();
  for (const edge of mesh.edges.values()) if (test(edge)) edge.selected = true;
  mesh.flushSelection('edge');
  store().setSelectMode('edge');
  store().touchMesh();
}

const facingUp = (face: Face) => face.normal.y > 0.99;

const MADE_NAME = /^Material \d+$/;

const point = ({ x, y, z }: { x: number; y: number; z: number }) => [x, y, z];

/** Edges as pairs of vertex indices, which way round and in what order not counting. */
const pairs = (list: [number, number][]) =>
  list.map(([a, b]) => (a < b ? `${a} ${b}` : `${b} ${a}`)).sort();

/**
 * Everything a run of the script has to build again: what the scene is, less
 * the ids, the selection and the UVs, which it leaves out by design.
 */
function scene() {
  const { objects, groups, cursor } = store();
  return {
    cursor: point(cursor),
    groups: groups.map((group) => group.name),
    objects: objects.map((object) => {
      const mesh = serializeMesh(object.mesh);
      return {
        name: object.name,
        visible: object.visible,
        locked: object.locked,
        group: groups.findIndex((group) => group.id === object.groupId),
        sharesMeshWith: objects.findIndex((other) => other.mesh === object.mesh),
        position: point(object.transform.position),
        rotation: point(object.transform.rotation),
        scale: point(object.transform.scale),
        primitive: object.primitive,
        positions: mesh.positions,
        faces: mesh.faces,
        materialIndices: mesh.materialIndices,
        smooth: mesh.smooth,
        wireEdges: pairs(mesh.wireEdges),
        sharpEdges: pairs(mesh.sharpEdges),
        materials: object.materials.map(({ name, color }) => ({
          // A slot's made name counts from the session, not the scene.
          name: MADE_NAME.test(name) ? 'made' : name,
          color: [color.r, color.g, color.b],
        })),
        modifiers: object.modifiers.map((modifier) => ({ ...modifier, id: undefined })),
      };
    }),
  };
}

/** `value` with every number in it matched to the five places the script keeps. */
function close(value: unknown): unknown {
  if (typeof value === 'number') return expect.closeTo(value, 5);
  if (Array.isArray(value)) return value.map(close);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, close(field)]));
  }
  return value;
}

/**
 * The promise the tab makes: its script, run on a new project, builds the
 * scene it was read from, and that scene reads back as the same script.
 */
async function rebuild(): Promise<string> {
  const expected = scene();
  const source = script();
  store().resetScene();
  const outcome = await runScript(source);
  expect(outcome, source).toMatchObject({ ok: true });
  expect(scene()).toEqual(close(expected));
  expect(script()).toBe(source);
  return source;
}

describe('the scene script', () => {
  beforeEach(() => {
    store().resetScene();
    store().setHistoryLimit(50);
  });

  it('is empty for an empty scene', () => {
    expect(sceneScript(store())).toEqual({ source: '', gaps: 0 });
  });

  it('writes nothing for a cube added and deleted again, as it writes the scene and not the steps', () => {
    store().addPrimitive('cube');
    store().setObjectTransform(id('CUBE'), { position: vec3(1, 0, 0) });
    expect(script()).not.toBe('');

    store().deleteSelected([id('CUBE')]);

    expect(script()).toBe('');
  });

  it('follows undo and redo, since it reads the scene they leave', () => {
    store().addPrimitive('cube');
    store().recordHistory('Move');
    store().setObjectTransform(id('CUBE'), { position: vec3(2, 0, 0) });
    expect(script()).toBe("scene.add('cube', { position: [2, 0, 0] });");

    // A step taken back loses the shape options, as the panels do, so the
    // cube comes back as its points.
    store().undo();
    expect(script()).toMatch(/^scene\.addMesh\(\{\n {2}name: 'CUBE',/);
    expect(script()).not.toContain('position');

    store().undo();
    expect(script()).toBe('');

    store().redoTimes(2);
    expect(script()).toContain('  position: [2, 0, 0],\n});');
  });

  it('writes a primitive as the add that makes it, with only what differs from a new one', async () => {
    store().addPrimitive('cube');
    store().addPrimitive('uvSphere', { radius: 2 });
    const ball = id('UV SPHERE');
    store().renameObject(ball, 'BALL');
    store().setObjectTransform(ball, {
      position: vec3(1, 2, 0),
      rotation: vec3(0, degToRad(90), 0),
      scale: vec3(2, 2, 2),
    });

    expect(await rebuild()).toBe(
      [
        "scene.add('cube');",
        '',
        "scene.add('uvSphere', {",
        '  radius: 2,',
        "  name: 'BALL',",
        '  position: [1, 2, 0],',
        '  rotation: [0, 90, 0],',
        '  scale: 2,',
        '});',
      ].join('\n'),
    );
  });

  it('keeps a shape option changed after the add on the add itself', async () => {
    store().addPrimitive('cylinder');
    store().updatePrimitiveParams({ segments: 8 });

    expect(await rebuild()).toBe("scene.add('cylinder', { segments: 8 });");
  });

  it('writes an edited mesh as its points and faces', async () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    pickFaces(facingUp);
    store().exec('extrude', { offset: 1 }, 'Extrude');
    store().setMode('object');

    const source = await rebuild();
    expect(source).toMatch(/^scene\.addMesh\(\{\n {2}name: 'CUBE',\n {2}verts: \[/);
    expect(store().objects[0].mesh.faces.size).toBe(10);
  });

  it('writes a mesh changed in place as its points, even while it still holds its shape options', async () => {
    store().addPrimitive('cube');
    const [corner] = editing().mesh.verts.values();
    corner.co = vec3(3, 3, 3);
    store().touchMesh();

    const source = script();
    expect(source).toMatch(/^scene\.addMesh\(/);
    store().resetScene();
    expect(await runScript(source)).toMatchObject({ ok: true });
    expect(store().objects[0].mesh.verts.values().next().value?.co).toEqual(vec3(3, 3, 3));
  });

  it('writes smooth faces, sharp edges and the material slot each face wears', async () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().exec('selectAll', {}, 'Select all');
    store().exec('shade', { smooth: true }, 'Shade smooth');
    pickEdges((edge) => edge.v0.co.y > 0.49 && edge.v1.co.y > 0.49);
    store().exec('markSharp', {}, 'Mark sharp');
    store().addMaterial();
    store().updateMaterial(1, { name: 'Lid', color: { r: 1, g: 0, b: 0 } });
    store().setActiveMaterial(1);
    pickFaces(facingUp);
    store().assignMaterialToSelection();
    store().setMode('object');

    const source = await rebuild();
    expect(source).toContain('  smooth: true,');
    expect(source).toContain('  faceMaterials: [');
    expect(source).toContain('  sharp: [');
    expect(source).toContain("cube.addMaterial({ name: 'Lid', color: '#ff0000' });");
  });

  it('writes edges without faces and points without edges', async () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().exec('selectAll', {}, 'Select all');
    store().exec('delete', { mode: 'onlyFaces' }, 'Delete faces');
    store().setMode('object');
    await runScript(
      `scene.addMesh({ verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [5, 5, 5]], faces: [[0, 1, 2]] });`,
    );

    const source = await rebuild();
    expect(store().objects[0].mesh.edges.size).toBe(12);
    expect(store().objects[1].mesh.verts.size).toBe(4);
    expect(source).toContain('  faces: [],');
    expect(source).toContain('  edges: [');
    expect(source).toContain(
      'scene.addMesh({ verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [5, 5, 5]], faces: [[0, 1, 2]] });',
    );
  });

  it('writes colours, named slots and slots taken away', async () => {
    store().addPrimitive('cone');
    store().updateMaterial(0, { color: { r: 0, g: 0.5, b: 1 } });
    store().addPrimitive('torus');
    store().updateMaterial(0, { name: 'Gold', color: { r: 1, g: 0.8, b: 0 } });
    store().addPrimitive('cube');
    store().removeMaterial(0);

    expect(await rebuild()).toBe(
      [
        "scene.add('cone', { color: [0, 0.5, 1] });",
        '',
        "const torus = scene.add('torus', { color: '#ffcc00' });",
        "torus.materials[0].name = 'Gold';",
        '',
        "const cube = scene.add('cube');",
        'cube.materials[0].remove();',
      ].join('\n'),
    );
  });

  it('writes the modifier stack with only the settings that differ from a new modifier', async () => {
    store().addPrimitive('cube');
    store().addModifier('mirror');
    store().addModifier('array');
    store().addModifier('subsurf');
    const [mirror, array, subsurf] = editing().modifiers;
    store().updateModifier(mirror.id, { axes: { x: true, y: true, z: false } });
    store().updateModifier(array.id, { count: 5, name: 'ROW' });
    store().updateModifier(subsurf.id, { enabled: false });

    expect(await rebuild()).toBe(
      [
        "const cube = scene.add('cube');",
        "cube.addModifier('mirror', { axes: [true, true, false] });",
        "cube.addModifier('array', { name: 'ROW', count: 5 });",
        "cube.addModifier('subsurf', { enabled: false });",
      ].join('\n'),
    );
  });

  it('writes a linked duplicate as one, sharing the mesh, with only what sets it apart', async () => {
    store().addPrimitive('cube');
    store().addModifier('solidify');
    store().setMode('edit');
    pickFaces(facingUp);
    store().exec('extrude', { offset: 1 }, 'Extrude');
    store().setMode('object');
    store().duplicateSelected(true);
    const copy = store().activeObjectId ?? '';
    store().setObjectTransform(copy, { position: vec3(4, 0, 0) });
    store().addPrimitive('cone');
    store().selectObjects([id('CUBE')]);
    store().duplicateSelected(true);
    store().renameObject(store().activeObjectId ?? '', 'THIRD');

    const source = await rebuild();
    expect(source).toContain(
      ['const cubeCopy = cube.duplicate(true);', 'cubeCopy.position = [4, 0, 0];'].join('\n'),
    );
    expect(source).toContain(
      ['const third = cube.duplicate(true);', "third.name = 'THIRD';"].join('\n'),
    );
    const [cube, second, , third] = store().objects;
    expect(second.mesh).toBe(cube.mesh);
    expect(third.mesh).toBe(cube.mesh);
  });

  it('writes the outliner folders, then what is hidden and locked, last of all', async () => {
    store().addPrimitive('cube');
    store().addPrimitive('cone');
    store().addPrimitive('torus');
    store().selectObjects([id('CUBE'), id('TORUS')]);
    store().groupSelected();
    store().renameGroup(store().groups[0].id, 'PARTS');
    store().toggleObjectVisibility(id('CONE'));
    store().toggleObjectLock(id('TORUS'));

    expect(await rebuild()).toBe(
      [
        "const cube = scene.add('cube');",
        "const cone = scene.add('cone');",
        "const torus = scene.add('torus');",
        '',
        "scene.group([cube, torus], 'PARTS');",
        '',
        'cone.visible = false;',
        'torus.locked = true;',
      ].join('\n'),
    );
  });

  it('puts the 3D cursor back after the objects, which would otherwise be added on it', async () => {
    store().addPrimitive('cube');
    store().setCursor(vec3(1, 2, 3), 'Cursor placed');
    store().addPrimitive('cone');

    expect(await rebuild()).toBe(
      [
        "scene.add('cube');",
        "scene.add('cone', { position: [1, 2, 3] });",
        '',
        'scene.cursor = [1, 2, 3];',
      ].join('\n'),
    );
  });

  it('gives every object a variable of its own, whatever it is called', async () => {
    store().addPrimitive('cube');
    store().addPrimitive('cube');
    store().renameObject(store().objects[1].id, 'DELETE');
    store().addPrimitive('cube');
    store().renameObject(store().objects[2].id, '3D PART');
    for (const object of store().objects) store().toggleObjectVisibility(object.id);

    const source = await rebuild();
    expect(source).toContain("const cube = scene.add('cube');");
    expect(source).toContain("const delete2 = scene.add('cube', { name: 'DELETE' });");
    expect(source).toContain("const object3dPart = scene.add('cube', { name: '3D PART' });");
  });

  it('notes what no script can make, counts it, and still builds the rest', async () => {
    store().addImage({
      id: 'asset-photo',
      name: 'photo.png',
      type: 'image/png',
      width: 64,
      height: 32,
      blob: null,
    });
    store().addPrimitive('cube');
    store().addModifier('lattice');

    const { source, gaps } = sceneScript(store());
    expect(gaps).toBe(3);
    expect(source).toBe(
      [
        '// PHOTO.PNG: an image, which a script cannot add',
        '',
        "scene.add('cube');",
        '// CUBE: its LATTICE modifier must be applied for a script to hold the shape it gives',
        '',
        `// ${store().objects[2].name}: a lattice cage, gone once the LATTICE modifier on CUBE is applied`,
      ].join('\n'),
    );

    store().resetScene();
    expect(await runScript(source)).toMatchObject({ ok: true });
    expect(store().objects.map((object) => object.name)).toEqual(['CUBE']);
  });

  it('names every object a shared cage shapes, and only a cage nothing reads as one to add', () => {
    store().addPrimitive('cube');
    store().addModifier('lattice');
    const cage = store().objects[1];
    store().duplicateSelected();

    expect(script()).toContain(
      `// ${cage.name}: a lattice cage, gone once the lattice modifiers on CUBE and CUBE.COPY are applied`,
    );

    for (const object of [store().objects[0], store().objects[2]]) {
      store().setActiveObject(object.id);
      store().removeModifier(object.modifiers[0].id);
    }
    expect(script()).toContain(`// ${cage.name}: a lattice cage, which a script cannot add`);
  });

  it.each(SCRIPT_EXAMPLES.map((example) => [example.label, example] as const))(
    'builds again the scene the %s example makes',
    async (_, example) => {
      expect(await runScript(example.source)).toMatchObject({ ok: true });
      expect(store().objects.length).toBeGreaterThan(0);
      await rebuild();
    },
    30_000,
  );
});
