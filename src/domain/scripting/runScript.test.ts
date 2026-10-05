import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OPERATORS } from '@kernel/index';
import { activeObject, useEditorStore } from '@store/index';

import { SCRIPT_EXAMPLES, STARTER_SCRIPT } from './examples';
import { OPERATOR_SPECS } from './reference';
import { runScript } from './runScript';

const store = () => useEditorStore.getState();

async function run(source: string) {
  const outcome = await runScript(source);
  if (!outcome.ok) throw new Error(`Line ${outcome.line}: ${outcome.message}`);
  return outcome;
}

async function fail(source: string) {
  const outcome = await runScript(source);
  if (outcome.ok) throw new Error(`Expected the script to fail, but it said: ${outcome.message}`);
  return outcome;
}

describe('runScript', () => {
  beforeEach(() => {
    store().resetScene();
    store().setHistoryLimit(50);
  });

  it('builds objects and reports what it added', async () => {
    const outcome = await run(`
      const base = scene.add('cube', { size: 2, name: 'BASE' });
      base.position = [0, 1, 0];
      scene.add('cylinder', { radius: 0.25, height: 3, position: { x: 2, y: 0, z: 0 } });
    `);

    expect(outcome.message).toBe('Script ran: 2 objects added');
    expect(store().objects.map((object) => object.name)).toEqual(['BASE', 'CYLINDER']);
    expect(store().objects[0].transform.position).toEqual({ x: 0, y: 1, z: 0 });
    expect(store().objects[1].transform.position).toEqual({ x: 2, y: 0, z: 0 });
    expect(store().status).toBe('Script ran: 2 objects added');
  });

  it('undoes the whole run in one step', async () => {
    store().addPrimitive('cube');
    const steps = store().historyUndo.length;

    await run(`
      for (let i = 0; i < 4; i++) scene.add('cube', { position: [i * 2, 0, 0] });
      scene.objects[0].color = '#ff0000';
    `);

    expect(store().objects).toHaveLength(5);
    expect(store().historyUndo).toHaveLength(steps + 1);
    expect(store().historyUndo[0]).toBe('Run script');

    store().undo();
    expect(store().objects).toHaveLength(1);
  });

  it('records no step for a script that changed nothing', async () => {
    store().addPrimitive('cube');
    const steps = store().historyUndo.length;

    const outcome = await run(`const count = scene.objects.length;`);

    expect(outcome.message).toBe('Script ran, and left the scene as it was');
    expect(store().historyUndo).toHaveLength(steps);
  });

  it('puts the scene back and names the line when a script throws halfway', async () => {
    store().addPrimitive('cube');
    const before = store().objects;
    const steps = store().historyUndo.length;

    const outcome = await fail(`scene.add('cone');
scene.objects[0].position = [5, 5, 5];
scene.add('cubee');`);

    expect(outcome.line).toBe(3);
    expect(outcome.message).toBe(
      'scene.add: kind has to be one of "cube", "plane", "circle", "grid", "uvSphere", "icoSphere", "cylinder", "cone", "capsule", "torus", not "cubee". Did you mean "cube"?',
    );
    expect(store().objects).toHaveLength(1);
    expect(store().objects[0].id).toBe(before[0].id);
    expect(store().objects[0].transform.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(store().historyUndo).toHaveLength(steps);
  });

  it('points at the line of an error thrown by the script itself', async () => {
    const outcome = await fail(`const a = 1;

const b = undefinedThing + a;`);

    expect(outcome.line).toBe(3);
    expect(outcome.message).toMatch(/undefinedThing/);
  });

  it('points at the bracket a script that will not compile left open', async () => {
    const outcome = await fail(`for (let i = 0; i < 3; i++) {
  scene.add('cube');
`);

    expect(outcome.line).toBe(1);
    expect(outcome.message).toBe('The { on line 1 is never closed with }');
  });

  it('says so when there is nothing to run', async () => {
    expect(await runScript('  \n ')).toEqual({
      ok: false,
      message: 'There is nothing to run yet.',
      line: null,
      logs: [],
    });
  });

  it('uses a string the script returns as the message', async () => {
    const outcome = await run(`scene.add('plane'); return 'Laid the floor';`);
    expect(outcome.message).toBe('Laid the floor');
  });

  it('hands back any other value the script returns as JSON', async () => {
    expect((await run(`return 6 * 7;`)).message).toBe('42');
    expect((await run(`return null;`)).message).toBe('null');
    expect((await run(`return scene.add('cube', { size: 2 }).bounds.size;`)).message).toBe(
      '{"x":2,"y":2,"z":2}',
    );
  });

  it('writes handles out as their names and settings, not their insides', async () => {
    const outcome = await run(`
      const box = scene.add('cube', { name: 'BOX', color: '#ff0000' });
      box.addModifier('array', { count: 3 });
      box.addMaterial({ name: 'TRIM', color: '#00ff00' });
      return [box, box.modifiers[0], box.materials[1]];
    `);

    const [box, array, trim] = JSON.parse(outcome.message);
    expect(box).toEqual({
      name: 'BOX',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      color: '#ff0000',
    });
    expect(array).toMatchObject({ type: 'array', enabled: true, count: 3 });
    expect(array).not.toHaveProperty('objectId');
    expect(trim).toEqual({ name: 'TRIM', color: '#00ff00', index: 1 });
  });

  it('keeps what the script logs, one line per call, failed run or not', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ran = await run(`
        console.log('cube', scene.add('cube').stats.faces, { a: [1, 2] });
        console.warn('careful');
      `);
      expect(ran.logs).toEqual(['cube 6 {"a":[1,2]}', 'warning: careful']);
      expect(log).toHaveBeenCalledWith('cube', 6, { a: [1, 2] });

      const failed = await fail(`console.log('before');\nthrow new Error('stop');`);
      expect(failed.logs).toEqual(['before']);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('refuses a shape option the primitive does not use', async () => {
    const outcome = await fail(`scene.add('cube', { radius: 2 });`);
    expect(outcome.message).toBe(
      'scene.add("cube") has no option "radius". It takes size, name, position, rotation, scale, color.',
    );
  });

  it('refuses an option an operation does not take, naming the near miss', async () => {
    store().addPrimitive('cube');
    const outcome = await fail(`scene.active.edit((mesh) => {
  mesh.selectFaces((face) => face.normal.y > 0.9);
  mesh.extrude({ ofset: 1 });
});`);

    expect(outcome.line).toBe(3);
    expect(outcome.message).toBe(
      'mesh.extrude has no option "ofset". Did you mean "offset"? It takes offset, individual, alongNormals.',
    );
  });

  it('extrudes the faces a script selects', async () => {
    await run(`
      const box = scene.add('cube');
      box.edit((mesh) => {
        mesh.selectFaces((face) => face.normal.y > 0.9);
        mesh.extrude({ offset: 1 });
      });
    `);

    const mesh = store().objects[0].mesh;
    expect(mesh.verts.size).toBe(12);
    expect(mesh.faces.size).toBe(10);
    expect(mesh.validate()).toEqual([]);
    expect(store().objects[0].primitive).toBeNull();
  });

  it('turns a refused operation into an error on its line', async () => {
    store().addPrimitive('cube');
    const outcome = await fail(`const box = scene.active;
box.edit((mesh) => {
  mesh.deselectAll();
  mesh.bevel({ width: 0.1 });
});`);

    expect(outcome.line).toBe(4);
    expect(outcome.message).toBe('mesh.bevel needs at least one edge selected first.');
  });

  it('deforms every vertex the function returns a point for', async () => {
    await run(`
      scene.add('cube').edit((mesh) => {
        mesh.deform((v) => (v.y > 0 ? [v.x * 2, v.y, v.z * 2] : undefined));
      });
    `);

    const xs = [...store().objects[0].mesh.verts.values()].map((vert) => Math.abs(vert.co.x));
    expect(xs.sort()).toEqual([0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1]);
  });

  it('builds a mesh from a list of points and faces', async () => {
    await run(`
      scene.addMesh({
        name: 'Ramp',
        verts: [[0, 0, 0], [1, 0, 0], [1, 1, 1], [0, 1, 1]],
        faces: [[0, 1, 2, 3]],
      });
    `);

    const object = store().objects[0];
    expect(object.name).toBe('Ramp');
    expect(object.mesh.verts.size).toBe(4);
    expect(object.mesh.faces.size).toBe(1);
  });

  it('refuses a face that names a vertex the list does not have', async () => {
    const outcome = await fail(
      `scene.addMesh({ verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 3]] });`,
    );
    expect(outcome.message).toBe(
      'scene.addMesh: faces[0] names vertex 3, and verts runs from 0 to 2.',
    );
  });

  it('adds and sets modifiers, merging a nested setting into the rest of it', async () => {
    await run(`
      const bar = scene.add('cube');
      const bend = bar.addModifier('bend', { angles: { z: 90 }, origin: 'cursor' });
      bend.set({ angles: { x: 15 } });
      bar.addModifier('array', { count: 3, relativeOffset: [1.5, 0, 0] });
    `);

    const [bend, array] = store().objects[0].modifiers;
    expect(bend).toMatchObject({ type: 'bend', angles: { x: 15, y: 0, z: 90 }, origin: 'cursor' });
    expect(array).toMatchObject({
      type: 'array',
      count: 3,
      relativeOffset: { x: 1.5, y: 0, z: 0 },
    });
  });

  it('holds a modifier setting to the range the panel does', async () => {
    const outcome = await fail(`scene.add('cube').addModifier('subsurf', { levels: 9 });`);
    expect(outcome.message).toBe('subsurf modifier: levels has to be from 0 to 6, not 9.');
  });

  it('refuses a typo on assignment instead of making a property nobody reads', async () => {
    const outcome = await fail(`const box = scene.add('cube');
box.positon = [0, 1, 0];`);

    expect(outcome.line).toBe(2);
    expect(outcome.message).toBe('object has no property "positon". Did you mean "position"?');
  });

  it('names a namespace member that does not exist', async () => {
    const outcome = await fail(`scene.ad('cube');`);
    expect(outcome.message).toBe('scene.ad is not part of the scripting API. Did you mean "add"?');
  });

  it('refuses to edit a locked object', async () => {
    const outcome = await fail(`const box = scene.add('cube');
box.locked = true;
box.position = [1, 0, 0];`);

    expect(outcome.line).toBe(3);
    expect(outcome.message).toBe('CUBE is locked: set locked = false to edit it.');
  });

  it('cuts one object with another and waits for the result', async () => {
    await run(`
      const block = scene.add('cube', { size: 2 });
      const hole = scene.add('cylinder', { radius: 0.4, height: 4, segments: 12 });
      await scene.boolean('difference', block, hole);
    `);

    expect(store().objects).toHaveLength(1);
    expect(store().objects[0].mesh.faces.size).toBeGreaterThan(6);
  });

  it('joins, duplicates and finds objects by name', async () => {
    await run(`
      const a = scene.add('cube', { name: 'A' });
      const b = a.duplicate();
      b.position = [3, 0, 0];
      b.name = 'B';
      if (scene.find('b') !== b) throw new Error('find should hand back the same object');
      scene.join(a, b);
    `);

    expect(store().objects.map((object) => object.name)).toEqual(['A']);
    expect(store().objects[0].mesh.faces.size).toBe(12);
  });

  it('groups objects into a named folder', async () => {
    await run(`scene.group([scene.add('cube'), scene.add('cone')], 'PARTS');`);
    expect(store().groups.map((group) => group.name)).toEqual(['PARTS']);
    expect(store().objects.every((object) => object.groupId === store().groups[0].id)).toBe(true);
  });

  it('leaves the active object alone when it edits another one', async () => {
    store().addPrimitive('cube');
    const active = store().activeObjectId;

    await run(`
      const cone = scene.add('cone');
      scene.select('CUBE');
      cone.color = [0, 1, 0];
    `);

    expect(store().activeObjectId).toBe(active);
    expect(store().objects[1].materials[0].color).toEqual({ r: 0, g: 1, b: 0 });
  });

  it('acts on the selection made by hand when the object is in edit mode', async () => {
    store().addPrimitive('cube');
    store().setMode('edit');
    store().setSelectMode('face');
    const mesh = activeObject(store())?.mesh;
    for (const face of mesh?.faces.values() ?? []) face.selected = face.normal.x > 0.9;
    mesh?.flushSelection('face');

    await run(`scene.active.edit((mesh) => mesh.extrude({ offset: 0.5 }));`);

    expect(activeObject(store())?.mesh.faces.size).toBe(10);
  });

  it('colours an object as it is added, primitive or custom mesh', async () => {
    await run(`
      scene.add('cube', { color: '#ff0000' });
      scene.addMesh({ verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], color: [0, 0, 1] });
    `);

    expect(store().objects.map((object) => object.materials[0].color)).toEqual([
      { r: 1, g: 0, b: 0 },
      { r: 0, g: 0, b: 1 },
    ]);
  });

  it('names the option a bad colour came in', async () => {
    const outcome = await fail(`scene.add('cube', { color: 'red' });`);
    expect(outcome.message).toBe(
      'scene.add("cube"): color has to be "#rrggbb", "#rgb" or [r, g, b] from 0 to 1, not "red".',
    );
  });

  it('puts the faces a script selects on a material slot of their own', async () => {
    const outcome = await run(`
      const box = scene.add('cube', { color: '#ffffff' });
      const trim = box.addMaterial({ name: 'TRIM', color: '#b8452f' });
      const count = box.edit((mesh) => {
        mesh.selectFaces((face) => face.normal.y > 0.9);
        return mesh.assignMaterial(trim);
      });
      const worn = box.edit((mesh) => mesh.faces.filter((face) => face.material === trim.index).length);
      return [count, worn, trim.name, box.materials.map((slot) => slot.color)].join(' ');
    `);

    expect(outcome.message).toBe('1 1 TRIM #ffffff,#b8452f');
    const object = store().objects[0];
    const top = [...object.mesh.faces.values()].find((face) => face.normal.y > 0.9);
    expect(top?.materialIndex).toBe(1);
    expect(object.primitive).toBeNull();
  });

  it('finds a slot by index or by name, and suggests the nearest name', async () => {
    await run(`
      const box = scene.add('cube');
      box.addMaterial({ name: 'GLASS' });
      box.edit((mesh) => {
        mesh.selectFaces((face) => face.normal.x > 0.9);
        mesh.assignMaterial('glass');
        mesh.selectFaces((face) => face.normal.x < -0.9);
        mesh.assignMaterial(1);
      });
    `);
    const faces = [...store().objects[0].mesh.faces.values()];
    expect(faces.filter((face) => face.materialIndex === 1)).toHaveLength(2);

    const outcome = await fail(`
      scene.find('CUBE').edit((mesh) => {
        mesh.selectFaces();
        mesh.assignMaterial('GLAS');
      });
    `);
    expect(outcome.message).toBe(
      'mesh.assignMaterial: CUBE has no material called "GLAS". Did you mean "GLASS"?',
    );
    expect(outcome.line).toBe(4);
  });

  it('refuses to assign a material with no face selected', async () => {
    const outcome = await fail(`scene.add('cube').edit((mesh) => mesh.assignMaterial(0));`);
    expect(outcome.message).toBe('mesh.assignMaterial needs at least one face selected first.');
  });

  it('keeps a material handle on its slot when an earlier one is removed', async () => {
    const outcome = await run(`
      const box = scene.add('cube');
      const red = box.addMaterial({ color: '#ff0000' });
      box.materials[0].remove();
      red.name = 'RED';
      return red.index + ' ' + box.materials.length;
    `);

    expect(outcome.message).toBe('0 1');
    expect(store().objects[0].materials[0].name).toBe('RED');
  });

  it('measures an object where it is drawn, modifiers and all', async () => {
    const outcome = await run(`
      const bar = scene.add('cube', { size: 2, position: [0, 1, 0], scale: [1, 0.5, 1] });
      bar.addModifier('array', { count: 3 });
      return JSON.stringify(bar.bounds);
    `);

    expect(JSON.parse(outcome.message)).toEqual({
      min: { x: -1, y: 0.5, z: -1 },
      max: { x: 5, y: 1.5, z: 1 },
      size: { x: 6, y: 1, z: 2 },
      center: { x: 2, y: 1, z: 0 },
    });
  });

  it('renames the project, and puts the name back when the run fails', async () => {
    await run(`scene.name = 'chair';`);
    expect(store().projectName).toBe('chair');

    await fail(`scene.name = 'table'; throw new Error('no');`);
    expect(store().projectName).toBe('chair');
  });

  it('cuts with the knife through a point inside a face written as [x, y, z]', async () => {
    await run(`
      const sheet = scene.add('plane', { size: 2 });
      sheet.edit((mesh) => {
        const left = mesh.edges.find((edge) => edge.center.x < -0.9);
        const right = mesh.edges.find((edge) => edge.center.x > 0.9);
        const face = mesh.faces[0];
        mesh.knife({
          cuts: [[
            { kind: 'edge', edge: left.id, t: 0.5 },
            { kind: 'face', face: face.id, co: [0, 0, 0.5] },
            { kind: 'edge', edge: right.id, t: 0.5 },
          ]],
        });
      });
    `);

    const mesh = store().objects[0].mesh;
    expect(mesh.verts.size).toBe(7);
    expect(mesh.faces.size).toBe(2);
  });

  it('refuses a knife point of a kind it does not know', async () => {
    const outcome = await fail(`
      scene.add('plane').edit((mesh) => {
        mesh.knife({ cuts: [[{ kind: 'vert', vert: 0 }, { kind: 'edg', edge: 1, t: 0.5 }]] });
      });
    `);
    expect(outcome.message).toBe(
      'mesh.knife: cuts[0][1].kind has to be "vert", "edge" or "face", not "edg".',
    );
  });

  it('drops back to object mode when the script deletes the object being edited', async () => {
    store().addPrimitive('cube');
    store().setMode('edit');

    await run(`scene.clear();`);

    expect(store().mode).toBe('object');
  });

  it.each([{ label: 'the starter script', source: STARTER_SCRIPT }, ...SCRIPT_EXAMPLES])(
    'runs $label cleanly',
    async ({ source }) => {
      store().addPrimitive('cube');
      await run(source);

      for (const object of store().objects) expect(object.mesh.validate()).toEqual([]);
      // The examples are what people learn the API from, so they model the way a
      // finished asset is modelled: quads, and triangles where a point needs them.
      const ngons = store().objects.filter((object) =>
        [...object.mesh.faces.values()].some((face) => object.mesh.faceLoopCount(face) > 4),
      );
      expect(ngons.map((object) => object.name)).toEqual([]);
    },
  );

  it('covers every operator the kernel has', () => {
    expect(OPERATOR_SPECS.map((spec) => spec.name).sort()).toEqual(Object.keys(OPERATORS).sort());
  });
});
