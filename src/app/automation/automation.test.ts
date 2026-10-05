import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

<<<<<<< HEAD
import { API_ENTRIES } from '@domain/scripting/reference';
=======
>>>>>>> debda340d193740e0ee0600c9b2928ca2b0425cd
import { decodeScenePayload, scenePayloadIn } from '@domain/services/sceneLink';

import { createAutomationApi, installAutomation, scriptingReference } from './automation';

const store = () => useEditorStore.getState();
const api = createAutomationApi();

const decode = (base64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));

describe('the automation API', () => {
  beforeEach(() => {
    store().resetScene();
    store().setHistoryLimit(50);
  });

  it('runs a script and reports the scene in script terms', async () => {
    const report = await api.run(`
      const top = scene.add('cube', { name: 'TOP', size: 2, position: [0, 1, 0] });
      top.rotation = [0, 45, 0];
      top.color = '#ff0000';
    `);

    expect(report.ok).toBe(true);
    expect(report.message).toBe('Script ran: 1 object added');
    const [top] = report.scene.objects;
    expect(top).toMatchObject({
      name: 'TOP',
      vertices: 8,
      faces: 6,
      position: { x: 0, y: 1, z: 0 },
      rotation: { x: 0, y: 45, z: 0 },
      color: '#ff0000',
      visible: true,
    });
    expect(top.dimensions.y).toBeCloseTo(2);
    expect(report.scene.bounds?.min.y).toBeCloseTo(0);
    expect(report.scene.bounds?.max.y).toBeCloseTo(2);
    expect(report.scene.totals).toEqual({ objects: 1, vertices: 8, faces: 6 });
  });

  it('hands back the string a script returns, which is how a script reads values out', async () => {
    const report = await api.run(`scene.add('cube'); return String(scene.objects.length);`);
    expect(report.message).toBe('1');
  });

  it('reports a failing line and leaves the scene as it was', async () => {
    await api.run(`scene.add('cube', { name: 'KEEP' });`);

    const report = await api.run(`scene.add('cube');\nscene.add('cube', { sise: 2 });`);

    expect(report.ok).toBe(false);
    expect(report.line).toBe(2);
    expect(report.message).toMatch(/Did you mean "size"\?/);
    expect(report.scene.objects.map((object) => object.name)).toEqual(['KEEP']);
  });

  it('resets to an empty scene with nothing to undo', async () => {
    await api.run(`scene.add('cube');`);
    api.reset();
    expect(api.scene().objects).toEqual([]);
    expect(api.scene().bounds).toBeNull();
    expect(store().canUndo).toBe(false);
  });

  it('exports a .3doo that opens back to the same scene', async () => {
    await api.run(`scene.add('cylinder', { name: 'POST', position: [1, 0, 0] });`);

    const [file] = await api.exportFile({ format: '3doo', name: 'fence' });
    expect(file.name).toBe('fence.3doo');
    expect(JSON.parse(decode(file.base64)).name).toBe('fence');

    api.reset();
    const summary = await api.open({ name: 'fence.3doo', base64: file.base64 });
    expect(summary.name).toBe('fence');
    expect(summary.objects.map((object) => object.name)).toEqual(['POST']);
    expect(store().canUndo).toBe(false);
  });

  it('exports OBJ with its material file, named after the project by default', async () => {
    store().setProjectName('my lamp');
    await api.run(`scene.add('cube');`);

    const files = await api.exportFile({ format: 'obj' });

    expect(files.map((file) => file.name)).toEqual(['my_lamp.obj', 'my_lamp.mtl']);
    expect(decode(files[0].base64)).toMatch(/mtllib my_lamp\.mtl/);
    expect(decode(files[0].base64).match(/^v /gm)).toHaveLength(8);
  });

  it('exports binary FBX, and triangulates when asked', async () => {
    await api.run(`scene.add('cube');`);

    const [fbx] = await api.exportFile({ format: 'fbx', preset: 'unreal' });
    expect(fbx.name).toBe('untitled.fbx');
    expect(decode(fbx.base64).startsWith('Kaydara FBX Binary')).toBe(true);

    const [obj] = await api.exportFile({ format: 'obj', triangulate: true });
    expect(decode(obj.base64).match(/^f /gm)).toHaveLength(12);
  });

  it('keeps folders out of a file name it is handed', async () => {
    await api.run(`scene.add('cube');`);
    const [file] = await api.exportFile({ format: 'fbx', name: '../../etc/box.fbx' });
    expect(file.name).toBe('box.fbx');
  });

  it('refuses to export a mesh from an empty scene, and a format it does not know', async () => {
    await expect(api.exportFile({ format: 'obj' })).rejects.toThrow(/Nothing to export/);
    await expect(api.exportFile({ format: 'stl' as 'obj' })).rejects.toThrow(/format has to be/);
  });

  it('imports an OBJ into the scene alongside what is there', async () => {
    await api.run(`scene.add('cube', { name: 'KEEP' });`);
    const obj = 'o TRI\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

    const summary = await api.open({ name: 'tri.obj', base64: btoa(obj) });

    expect(summary.objects).toHaveLength(2);
    expect(summary.objects[1].faces).toBe(1);
  });

  it('refuses a file it cannot read', async () => {
    await expect(api.open({ name: 'model.stl', base64: '' })).rejects.toThrow(/not a \.3doo/);
  });

  it('builds a link that carries the scene to the hosted editor', async () => {
    await api.run(`scene.add('torus', { name: 'RING' });`);

    const { url, length } = await api.shareLink('https://3doo.example.com/');

    expect(url.startsWith('https://3doo.example.com/modeling#scene=')).toBe(true);
    expect(length).toBe(url.length);
    const payload = scenePayloadIn(new URL(url).hash);
    const project = JSON.parse(await decodeScenePayload(payload ?? ''));
    expect(project.objects[0].name).toBe('RING');
  });

  it('refuses a link to anything but a web address', async () => {
    await expect(api.shareLink('ftp://example.com')).rejects.toThrow(/http/);
    await expect(api.shareLink('example.com')).rejects.toThrow(/full http/);
  });

  it('checks a render request before it reaches the GPU', async () => {
    await expect(api.render({ views: ['isometric'] })).rejects.toThrow(
      /Each view has to be one of/,
    );
    await expect(api.render({ width: 9000 })).rejects.toThrow(/16 to 2048/);
    await expect(api.render({ shading: 'shiny' })).rejects.toThrow(/shading has to be/);
    await expect(api.render({ views: [] })).rejects.toThrow(/one or more/);
  });

  it('is put on window for the headless browser to find', () => {
    installAutomation();
    expect(window.threedoo?.version).toBe(api.version);
  });
});

describe('the scripting reference', () => {
  const reference = scriptingReference();

  it('covers the whole API and the shipped examples', () => {
    expect(reference).toMatch(/^# 3DOO scripting reference/);
<<<<<<< HEAD
    for (const entry of API_ENTRIES) expect(reference).toContain(`\`${entry.signature}\``);
=======
    expect(reference).toContain('scene.add(');
    expect(reference).toContain('mesh.extrude');
>>>>>>> debda340d193740e0ee0600c9b2928ca2b0425cd
    expect(reference).toContain("'subsurf'");
    expect(reference).toContain('## Examples');
    expect(reference).toContain('```js');
  });

<<<<<<< HEAD
  it('says what a script can do and how it works before the tables', () => {
    expect(reference.indexOf('## What a script can do')).toBeLessThan(reference.indexOf('## API'));
    expect(reference).toContain('## How a script works');
  });

  it('names the values a choice takes', () => {
    expect(reference).toContain(
      'mode: Where they meet. Default "center". Takes "center", "cursor", "first", "last" or "collapse".',
    );
  });

  it('leaves out the parts about the editor window', () => {
    expect(reference).not.toContain('Ctrl+Enter');
    expect(reference).not.toContain('Ctrl+Z');
    expect(reference).not.toContain('The <> button');
    expect(reference).not.toContain('MCP button');
=======
  it('leaves out the parts about the editor window', () => {
    expect(reference).not.toContain('Ctrl+Enter');
    expect(reference).not.toContain('The <> button');
>>>>>>> debda340d193740e0ee0600c9b2928ca2b0425cd
  });
});
