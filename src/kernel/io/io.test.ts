import { describe, expect, it } from 'vitest';

import { History } from '../commands/history';
import { execOperator } from '../commands/operators';
import { createTransform, dot, vec3 } from '../math';
import { createBox, createPlane } from '../primitives';

import { exportFBXAscii } from './fbx-ascii';
import { exportOBJ, importOBJ } from './obj';
import { deserializeProject, parseProject, serializeProject, stringifyProject } from './project';
import type { ExportObject } from './types';
import { boxProjectUVs } from './uv';

function cubeExport(): ExportObject {
  return {
    name: 'Cube',
    mesh: createBox(2),
    transform: createTransform(),
    materials: [{ id: 'm1', name: 'Base', color: { r: 0.8, g: 0.2, b: 0.2 } }],
  };
}

describe('OBJ export', () => {
  it('writes one vertex line per vertex and one face line per face', () => {
    const { obj } = exportOBJ([cubeExport()]);
    const lines = obj.split('\n');

    expect(lines.filter((line) => line.startsWith('v '))).toHaveLength(8);
    expect(lines.filter((line) => line.startsWith('f '))).toHaveLength(6);
    expect(lines.filter((line) => line.startsWith('vn '))).toHaveLength(6);
    expect(obj).toContain('o Cube');
    expect(obj).toContain('usemtl Base');
  });

  it('uses 1-based indices', () => {
    const { obj } = exportOBJ([cubeExport()]);
    const faceLine = obj.split('\n').find((line) => line.startsWith('f '));
    const indices =
      faceLine
        ?.slice(2)
        .split(' ')
        .map((token) => Number(token.split('/')[0])) ?? [];

    expect(indices).toHaveLength(4);
    expect(Math.min(...indices)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...indices)).toBeLessThanOrEqual(8);
  });

  it('converts to Z-up for Blender and Unreal presets', () => {
    const object = cubeExport();
    object.mesh = createPlane(2);

    const { obj } = exportOBJ([object], { preset: 'blender' });
    const vertices = obj
      .split('\n')
      .filter((line) => line.startsWith('v '))
      .map((line) => line.split(' ').slice(1).map(Number));

    // The plane lies in our XZ ground plane, so Z-up must flatten it on Z.
    for (const [, , z] of vertices) expect(z).toBeCloseTo(0);
  });

  it('scales for centimetre targets', () => {
    const { obj } = exportOBJ([cubeExport()], { preset: 'unreal' });
    const vertices = obj
      .split('\n')
      .filter((line) => line.startsWith('v '))
      .map((line) => line.split(' ').slice(1).map(Number));

    expect(Math.max(...vertices.map(([x]) => Math.abs(x)))).toBeCloseTo(100);
  });

  it('emits a material library', () => {
    const { mtl } = exportOBJ([cubeExport()]);
    expect(mtl).toContain('newmtl Base');
    expect(mtl).toContain('Kd 0.8 0.2 0.2');
  });

  it('round-trips through its own importer', () => {
    const { obj } = exportOBJ([cubeExport()], { preset: 'unity' });
    const imported = importOBJ(obj);

    expect(imported).toHaveLength(1);
    expect(imported[0].name).toBe('Cube');
    expect(imported[0].mesh.verts.size).toBe(8);
    expect(imported[0].mesh.faces.size).toBe(6);
    expect(imported[0].mesh.validate()).toEqual([]);
  });

  it('handles negative and slash-formatted face indices', () => {
    const source = [
      'v 0 0 0',
      'v 1 0 0',
      'v 1 0 1',
      'v 0 0 1',
      'f -4/1/1 -3/2/2 -2/3/3 -1/4/4',
    ].join('\n');

    const [imported] = importOBJ(source);

    expect(imported.mesh.verts.size).toBe(4);
    expect(imported.mesh.faces.size).toBe(1);
  });
});

describe('FBX ASCII export', () => {
  const fbx = exportFBXAscii([cubeExport()]);

  it('declares the 7400 header', () => {
    expect(fbx).toContain('FBXVersion: 7400');
    expect(fbx).toContain('FBXHeaderVersion: 1003');
    expect(fbx).toContain('Creator: "3DOO"');
  });

  it('encodes the last index of every polygon as -(index + 1)', () => {
    const match = fbx.match(/PolygonVertexIndex: \*(\d+) \{\s*a: ([^}]+)\}/);
    expect(match).not.toBeNull();

    const values = (match?.[2] ?? '')
      .split(/[\s,]+/)
      .filter((token) => token.length > 0)
      .map(Number);

    expect(values).toHaveLength(24);
    expect(Number(match?.[1])).toBe(24);

    // Six quads: every fourth index closes a polygon and must be negative.
    for (let i = 0; i < values.length; i++) {
      if ((i + 1) % 4 === 0) expect(values[i]).toBeLessThan(0);
      else expect(values[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('pairs mapping and reference types on every layer element', () => {
    expect(fbx).toContain('MappingInformationType: "ByPolygonVertex"');
    expect(fbx).toContain('MappingInformationType: "ByPolygon"');
    expect(fbx).toContain('ReferenceInformationType: "IndexToDirect"');
    expect(fbx.match(/ReferenceInformationType: "Direct"/g)).toHaveLength(2);
  });

  it('emits one normal and one UV pair per polygon vertex', () => {
    const normals = fbx.match(/Normals: \*(\d+)/);
    const uvs = fbx.match(/UV: \*(\d+)/);

    expect(Number(normals?.[1])).toBe(24 * 3);
    expect(Number(uvs?.[1])).toBe(24 * 2);
  });

  it('emits one material index per polygon', () => {
    const materials = fbx.match(/Materials: \*(\d+)/);
    expect(Number(materials?.[1])).toBe(6);
  });

  it('connects geometry and material to the model, and the model to the root', () => {
    const geometryId = fbx.match(/Geometry: (\d+),/)?.[1];
    const modelId = fbx.match(/Model: (\d+),/)?.[1];
    const materialId = fbx.match(/Material: (\d+),/)?.[1];

    expect(fbx).toContain(`C: "OO",${modelId},0`);
    expect(fbx).toContain(`C: "OO",${geometryId},${modelId}`);
    expect(fbx).toContain(`C: "OO",${materialId},${modelId}`);
  });

  it('declares accurate object counts', () => {
    expect(fbx).toMatch(/ObjectType: "Geometry" \{\s*Count: 1/);
    expect(fbx).toMatch(/ObjectType: "Model" \{\s*Count: 1/);
    expect(fbx).toMatch(/ObjectType: "Material" \{\s*Count: 1/);
  });

  it('switches the up axis for Z-up presets', () => {
    const zUp = exportFBXAscii([cubeExport()], { preset: 'blender' });
    expect(zUp).toContain('P: "UpAxis", "int", "Integer", "",2');
    expect(exportFBXAscii([cubeExport()], { preset: 'unity' })).toContain(
      'P: "UpAxis", "int", "Integer", "",1',
    );
  });

  it('triangulates when asked', () => {
    const triangulated = exportFBXAscii([cubeExport()], { triangulate: true });
    const count = Number(triangulated.match(/PolygonVertexIndex: \*(\d+)/)?.[1]);
    expect(count).toBe(36);
  });
});

describe('UV projection', () => {
  it('gives every loop a UV', () => {
    const mesh = createBox(2);
    boxProjectUVs(mesh);

    for (const face of mesh.faces.values()) {
      for (const loop of mesh.faceLoops(face)) {
        expect(Number.isFinite(loop.uv.u)).toBe(true);
        expect(Number.isFinite(loop.uv.v)).toBe(true);
      }
    }
  });
});

describe('project files', () => {
  const snapshot = () => [
    {
      id: 'obj-1',
      name: 'Cube',
      transform: createTransform(),
      visible: true,
      locked: false,
      parentId: null,
      materials: [{ id: 'm1', name: 'Base', color: { r: 1, g: 1, b: 1 } }],
      modifiers: [],
      activeMaterial: 0,
      mesh: createBox(2),
    },
  ];

  it('round-trips a scene', () => {
    const document = serializeProject('Test', snapshot(), vec3(1, 2, 3), 'obj-1');
    const restored = deserializeProject(parseProject(stringifyProject(document)));

    expect(restored.name).toBe('Test');
    expect(restored.cursor).toEqual({ x: 1, y: 2, z: 3 });
    expect(restored.activeObjectId).toBe('obj-1');
    expect(restored.objects).toHaveLength(1);
    expect(restored.objects[0].mesh.faces.size).toBe(6);
    expect(restored.objects[0].mesh.validate()).toEqual([]);
  });

  it('keeps two objects on one mesh across a round trip', () => {
    const shared = createBox(2);
    const [cube] = snapshot();
    const document = serializeProject(
      'Linked',
      [
        { ...cube, mesh: shared },
        { ...cube, id: 'obj-2', name: 'Cube.COPY', mesh: shared },
      ],
      vec3(),
      'obj-1',
    );
    const restored = deserializeProject(parseProject(stringifyProject(document)));

    // Compared as a boolean on purpose: a failing identity assertion on a BMesh
    // would make the reporter walk the cyclic half-edge graph to build a diff.
    expect(restored.objects[0].mesh === restored.objects[1].mesh).toBe(true);
  });

  it('falls back to its own mesh when the link cannot be resolved', () => {
    const [cube] = snapshot();
    const document = serializeProject('Linked', [cube], vec3(), 'obj-1');
    document.objects[0].meshLink = 'obj-gone';

    const restored = deserializeProject(parseProject(stringifyProject(document)));

    expect(restored.objects[0].mesh.faces.size).toBe(6);
  });

  it('rejects malformed files with a readable message', () => {
    expect(() => parseProject('not json')).toThrow(/not valid JSON/);
    expect(() => parseProject('{"version":99}')).toThrow(/Unsupported project version/);
    expect(() => parseProject('{"version":1}')).toThrow(/no objects array/);
    expect(() => parseProject('{"version":1,"objects":[{"name":"X"}]}')).toThrow(/no usable mesh/);
  });
});

describe('history', () => {
  const doc = (name: string) => serializeProject(name, [], vec3(), null);

  it('drops the newest entry for a cancelled operation', () => {
    const history = new History();
    history.record('op1', doc('first'));
    history.record('cancelled', doc('second'));

    history.drop();

    // What a cancelled modal transform leaves behind: nothing.
    expect(history.undoLabel).toBe('op1');
    history.drop();
    expect(history.canUndo).toBe(false);
    expect(() => history.drop()).not.toThrow();
  });

  it('undoes and redoes in order', () => {
    const history = new History();
    const first = doc('first');
    const second = doc('second');
    const third = doc('third');

    history.record('op1', first);
    history.record('op2', second);

    expect(history.canUndo).toBe(true);
    expect(history.undoLabel).toBe('op2');

    const undone = history.undo(third);
    expect(undone?.document.name).toBe('second');
    expect(history.canRedo).toBe(true);

    const redone = history.redo(second);
    expect(redone?.document.name).toBe('third');
  });

  it('clears the redo stack on a new action', () => {
    const history = new History();
    history.record('op1', doc('a'));
    history.undo(doc('b'));
    expect(history.canRedo).toBe(true);

    history.record('op2', doc('c'));
    expect(history.canRedo).toBe(false);
  });

  it('caps the stack at its limit', () => {
    const history = new History(3);
    for (let i = 0; i < 10; i++) history.record(`op${i}`, doc(`d${i}`));

    let count = 0;
    while (history.canUndo) {
      history.undo(doc('current'));
      count++;
    }
    expect(count).toBe(3);
  });
});

describe('operator registry', () => {
  it('drives the kernel through exec', () => {
    const mesh = createBox(2);
    const top = [...mesh.faces.values()].find((face) => face.normal.y > 0.99);
    if (top) top.selected = true;
    mesh.flushSelection('face');

    const result = execOperator({ mesh, selectMode: 'face', cursor: vec3() }, 'extrude', {
      offset: 1,
    });

    expect(result.status).toContain('Extruded');
    expect(mesh.faces.size).toBe(10);
    expect(mesh.validate()).toEqual([]);
  });

  it('leaves only the new loop selected after a cut', () => {
    const mesh = createBox(2);
    const start = [...mesh.edges.values()][0];
    start.selected = true;
    mesh.flushSelection('edge');

    execOperator({ mesh, selectMode: 'edge', cursor: vec3() }, 'loopCut', { cuts: 1 });

    // The edge the cut ran across used to stay selected alongside the loop, so
    // the next scale dragged two box corners in with it and speared the faces
    // between them. A ring cut through a box is four edges and four vertices.
    expect(mesh.selectedEdges()).toHaveLength(4);
    expect(mesh.selectedVerts()).toHaveLength(4);
    expect(mesh.selectedVerts().every((vert) => vert.id >= 8)).toBe(true);
  });

  it('runs a face loop out from two adjacent faces', () => {
    const mesh = createBox(2);
    const [first] = [...mesh.faces.values()];
    const neighbour = mesh
      .faceEdges(first)
      .flatMap((edge) => mesh.edgeFaces(edge))
      .find((face) => face !== first);
    first.selected = true;
    if (neighbour) neighbour.selected = true;
    mesh.flushSelection('face');

    const result = execOperator({ mesh, selectMode: 'face', cursor: vec3() }, 'selectFaceLoop', {});

    // The two faces share one edge, and the band of quads through it wraps the
    // cube in four.
    expect(result.status).toContain('face loop of 4');
    expect(mesh.selectedFaces()).toHaveLength(4);
  });

  it('refuses a face loop that no pair of adjacent faces names', () => {
    const mesh = createBox(2);
    const [first] = [...mesh.faces.values()];
    first.selected = true;
    mesh.flushSelection('face');

    const single = execOperator({ mesh, selectMode: 'face', cursor: vec3() }, 'selectFaceLoop', {});
    expect(single.status).toMatch(/two adjacent faces/);
    expect(mesh.selectedFaces()).toHaveLength(1);

    const opposite = [...mesh.faces.values()].find(
      (face) => dot(face.normal, first.normal) < -0.99,
    );
    if (opposite) opposite.selected = true;
    mesh.flushSelection('face');

    const apart = execOperator({ mesh, selectMode: 'face', cursor: vec3() }, 'selectFaceLoop', {});
    expect(apart.status).toMatch(/adjacent quads/);
    expect(mesh.selectedFaces()).toHaveLength(2);
  });

  it('reports unknown operators with the available list', () => {
    const mesh = createBox(2);
    expect(() => execOperator({ mesh, selectMode: 'face', cursor: vec3() }, 'nope')).toThrow(
      /Unknown operator "nope"/,
    );
  });

  it('falls back to defaults for malformed params', () => {
    const mesh = createBox(2);
    for (const face of mesh.faces.values()) face.selected = true;
    mesh.flushSelection('face');

    const result = execOperator({ mesh, selectMode: 'face', cursor: vec3() }, 'subdivide', {
      cuts: 'many',
    });

    expect(result.status).toContain('Subdivided');
    expect(mesh.faces.size).toBe(24);
  });
});
