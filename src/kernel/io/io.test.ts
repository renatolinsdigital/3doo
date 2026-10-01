import { describe, expect, it } from 'vitest';

import { History } from '../commands/history';
import { execOperator } from '../commands/operators';
import { createTransform, dot, vec3 } from '../math';
import { createBox, createImagePlane, createPlane, imagePlaneSize } from '../primitives';

import { exportFBX } from './fbx';
import { exportOBJ, importOBJ } from './obj';
import { deserializeProject, parseProject, serializeProject, stringifyProject } from './project';
import type { AxisPreset, ExportObject } from './types';

function cubeExport(): ExportObject {
  return {
    name: 'Cube',
    mesh: createBox(2),
    transform: createTransform(),
    materials: [{ id: 'm1', name: 'Base', color: { r: 0.8, g: 0.2, b: 0.2 } }],
  };
}

function pictureExport(): ExportObject {
  return {
    name: 'Ref',
    mesh: createImagePlane(2, 1),
    transform: createTransform(),
    materials: [{ id: 'm2', name: 'Base', color: { r: 0.8, g: 0.2, b: 0.2 } }],
    texture: { fileName: 'ref.png', data: new Uint8Array([1, 2, 3, 4]) },
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

  it('writes an image plane with its UVs and a material that maps the picture', () => {
    const { obj, mtl } = exportOBJ([cubeExport(), pictureExport()], {}, 'board.mtl');
    const lines = obj.split('\n');

    expect(lines[1]).toBe('mtllib board.mtl');
    expect(lines.filter((line) => line.startsWith('vt '))).toEqual([
      'vt 0 0',
      'vt 1 0',
      'vt 1 1',
      'vt 0 1',
    ]);
    // The cube ahead of it has no UVs, so the plane's count from the first.
    expect(lines.filter((line) => line.startsWith('f ')).at(-1)).toBe(
      'f 9/1/7 10/2/7 11/3/7 12/4/7',
    );
    expect(obj).toContain('usemtl ref');
    // White, so an importer that tints the picture by the colour leaves it be.
    expect(mtl).toContain('newmtl ref\nKd 1 1 1');
    expect(mtl).toContain('map_Kd ref.png');
    expect(mtl).toContain('newmtl Base');
  });

  it('writes positions and normals but no UVs', () => {
    const { obj } = exportOBJ([cubeExport()]);
    const lines = obj.split('\n');

    expect(lines.filter((line) => line.startsWith('vt '))).toHaveLength(0);
    for (const face of lines.filter((line) => line.startsWith('f '))) {
      expect(face).toMatch(/^f( \d+\/\/\d+)+$/);
    }
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

  it('converts to Z-up for the Unreal preset', () => {
    const object = cubeExport();
    object.mesh = createPlane(2);

    const { obj } = exportOBJ([object], { preset: 'unreal' });
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

interface ParsedNode {
  name: string;
  props: unknown[];
  children: ParsedNode[];
}

const decoder = new TextDecoder();

/**
 * Reads a binary FBX back into a node tree, checking every end offset,
 * property length and closing record on the way, so getting a tree at all
 * means the file is well formed.
 */
function readFBX(bytes: Uint8Array): ParsedNode {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 27;

  const readProperty = (): unknown => {
    const type = String.fromCharCode(bytes[offset]);
    offset += 1;
    switch (type) {
      case 'C':
        offset += 1;
        return bytes[offset - 1] !== 0;
      case 'I':
        offset += 4;
        return view.getInt32(offset - 4, true);
      case 'L':
        offset += 8;
        return Number(view.getBigInt64(offset - 8, true));
      case 'D':
        offset += 8;
        return view.getFloat64(offset - 8, true);
      case 'S':
      case 'R': {
        const length = view.getUint32(offset, true);
        const data = bytes.subarray(offset + 4, offset + 4 + length);
        offset += 4 + length;
        return type === 'S' ? decoder.decode(data) : data;
      }
      case 'i':
      case 'd': {
        const count = view.getUint32(offset, true);
        const size = type === 'i' ? 4 : 8;
        expect(view.getUint32(offset + 4, true)).toBe(0);
        expect(view.getUint32(offset + 8, true)).toBe(count * size);
        offset += 12;
        const values = Array.from({ length: count }, (_, index) =>
          type === 'i'
            ? view.getInt32(offset + index * 4, true)
            : view.getFloat64(offset + index * 8, true),
        );
        offset += count * size;
        return values;
      }
      default:
        throw new Error(`Unknown property type ${type} at ${offset - 1}`);
    }
  };

  const readNode = (): ParsedNode | null => {
    const end = view.getUint32(offset, true);
    if (end === 0) {
      offset += 13;
      return null;
    }
    const count = view.getUint32(offset + 4, true);
    const propsLength = view.getUint32(offset + 8, true);
    const nameLength = bytes[offset + 12];
    const name = decoder.decode(bytes.subarray(offset + 13, offset + 13 + nameLength));
    offset += 13 + nameLength;

    const propsStart = offset;
    const props = Array.from({ length: count }, readProperty);
    expect(offset - propsStart).toBe(propsLength);

    const children: ParsedNode[] = [];
    while (offset < end) {
      const child = readNode();
      if (child) children.push(child);
    }
    expect(offset).toBe(end);
    return { name, props, children };
  };

  const children: ParsedNode[] = [];
  for (let next = readNode(); next; next = readNode()) children.push(next);
  return { name: '', props: [], children };
}

function child(parent: ParsedNode | undefined, name: string): ParsedNode | undefined {
  return parent?.children.find((node) => node.name === name);
}

function childrenNamed(parent: ParsedNode | undefined, name: string): ParsedNode[] {
  return parent?.children.filter((node) => node.name === name) ?? [];
}

/** The value of a `Properties70` entry: everything after name, type, label and flags. */
function property(owner: ParsedNode | undefined, name: string): unknown[] | undefined {
  const entry = child(owner, 'Properties70')?.children.find((node) => node.props[0] === name);
  return entry?.props.slice(4);
}

describe('FBX export', () => {
  const bytes = exportFBX([cubeExport()]);
  const root = readFBX(bytes);
  const objects = child(root, 'Objects');
  const geometry = child(objects, 'Geometry');
  const model = child(objects, 'Model');
  const material = child(objects, 'Material');

  const settings = (preset: AxisPreset) =>
    child(readFBX(exportFBX([cubeExport()], { preset })), 'GlobalSettings');

  it('is binary 7400, with the header and footer importers check', () => {
    expect(decoder.decode(bytes.subarray(0, 23))).toBe('Kaydara FBX Binary  \0\x1a\0');
    expect(new DataView(bytes.buffer).getUint32(23, true)).toBe(7400);
    expect(child(child(root, 'FBXHeaderExtension'), 'FBXVersion')?.props).toEqual([7400]);
    expect(child(root, 'Creator')?.props).toEqual(['3DOO']);
    expect([...bytes.subarray(-16)]).toEqual([
      0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29,
      0x0b,
    ]);
  });

  it('names objects the binary way: name, separator, class', () => {
    expect(geometry?.props.slice(1)).toEqual(['Cube\0\x01Geometry', 'Mesh']);
    expect(model?.props.slice(1)).toEqual(['Cube\0\x01Model', 'Mesh']);
    expect(material?.props[1]).toBe('Base\0\x01Material');
  });

  it('encodes the last index of every polygon as -(index + 1)', () => {
    const values = child(geometry, 'PolygonVertexIndex')?.props[0] as number[];
    expect(values).toHaveLength(24);

    // Six quads: every fourth index closes a polygon and must be negative.
    for (let i = 0; i < values.length; i++) {
      if ((i + 1) % 4 === 0) expect(values[i]).toBeLessThan(0);
      else expect(values[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('pairs mapping and reference types on every layer element', () => {
    const normals = child(geometry, 'LayerElementNormal');
    const materials = child(geometry, 'LayerElementMaterial');

    expect(child(normals, 'MappingInformationType')?.props).toEqual(['ByPolygonVertex']);
    expect(child(normals, 'ReferenceInformationType')?.props).toEqual(['Direct']);
    expect(child(materials, 'MappingInformationType')?.props).toEqual(['ByPolygon']);
    expect(child(materials, 'ReferenceInformationType')?.props).toEqual(['IndexToDirect']);
  });

  it('emits one normal per polygon vertex and one material index per polygon', () => {
    const normals = child(child(geometry, 'LayerElementNormal'), 'Normals');
    const materials = child(child(geometry, 'LayerElementMaterial'), 'Materials');

    expect(normals?.props[0]).toHaveLength(24 * 3);
    expect(materials?.props[0]).toHaveLength(6);
  });

  it('writes no UV layer', () => {
    expect(child(geometry, 'LayerElementUV')).toBeUndefined();
  });

  it('connects geometry and material to the model, and the model to the root', () => {
    const [geometryId, modelId, materialId] = [geometry, model, material].map(
      (node) => node?.props[0],
    );

    expect(childrenNamed(child(root, 'Connections'), 'C').map((node) => node.props)).toEqual([
      ['OO', modelId, 0],
      ['OO', geometryId, modelId],
      ['OO', materialId, modelId],
    ]);
  });

  it('declares accurate object counts', () => {
    const definitions = child(root, 'Definitions');
    const counts = Object.fromEntries(
      childrenNamed(definitions, 'ObjectType').map((type) => [
        type.props[0],
        child(type, 'Count')?.props[0],
      ]),
    );

    expect(counts).toEqual({ GlobalSettings: 1, Geometry: 1, Model: 1, Material: 1 });
    expect(child(definitions, 'Count')?.props).toEqual([4]);
  });

  it('declares a right-handed axis system for either up axis', () => {
    const axes = (preset: AxisPreset) => {
      const global = settings(preset);
      return [
        'UpAxis',
        'UpAxisSign',
        'FrontAxis',
        'FrontAxisSign',
        'CoordAxis',
        'CoordAxisSign',
      ].map((name) => property(global, name)?.[0]);
    };

    expect(axes('unity')).toEqual([1, 1, 2, 1, 0, 1]);
    // A front sign of +1 here would be left-handed, and importers mirror the model.
    expect(axes('unreal')).toEqual([2, 1, 1, -1, 0, 1]);
  });

  it('declares the unit the coordinates are written in', () => {
    // UnitScaleFactor counts centimetres per file unit.
    expect(property(settings('unity'), 'UnitScaleFactor')).toEqual([100]);
    expect(property(settings('unreal'), 'UnitScaleFactor')).toEqual([1]);
  });

  it('keeps the transform on the node when transforms are not applied', () => {
    const object = cubeExport();
    object.transform = { position: vec3(1, 2, 3), rotation: vec3(0, 0, 0), scale: vec3(1, 2, 3) };
    const exported = exportFBX([object], { preset: 'unreal', applyTransform: false });
    const node = child(child(readFBX(exported), 'Objects'), 'Model');

    // Z-up in centimetres: our (x, y, z) becomes (x, -z, y), times 100.
    expect(property(node, 'Lcl Translation')).toEqual([100, -300, 200]);
    // Scale swaps axes with the conversion but never changes sign.
    expect(property(node, 'Lcl Scaling')).toEqual([1, 3, 2]);
    // The rotation order changes with the axes, and only counts when active.
    expect(property(node, 'RotationOrder')).toEqual([2]);
    expect(property(node, 'RotationActive')).toEqual([1]);
  });

  it('triangulates when asked', () => {
    const triangulated = readFBX(exportFBX([cubeExport()], { triangulate: true }));
    const indices = child(child(child(triangulated, 'Objects'), 'Geometry'), 'PolygonVertexIndex');
    expect(indices?.props[0]).toHaveLength(36);
  });
});

describe('FBX export of an image plane', () => {
  const twin = { ...pictureExport(), name: 'Twin' };
  const root = readFBX(exportFBX([cubeExport(), pictureExport(), twin]));
  const objects = child(root, 'Objects');
  const material = childrenNamed(objects, 'Material').find(
    (node) => node.props[1] === 'ref\0\x01Material',
  );
  const texture = child(objects, 'Texture');
  const video = child(objects, 'Video');

  it("writes the plane's UVs, and none for ordinary geometry", () => {
    const [cube, plane] = childrenNamed(objects, 'Geometry');
    const uv = child(plane, 'LayerElementUV');

    expect(child(cube, 'LayerElementUV')).toBeUndefined();
    expect(child(uv, 'UV')?.props[0]).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(child(uv, 'UVIndex')?.props[0]).toEqual([0, 1, 2, 3]);
    expect(child(uv, 'MappingInformationType')?.props).toEqual(['ByPolygonVertex']);
    expect(child(uv, 'ReferenceInformationType')?.props).toEqual(['IndexToDirect']);
    expect(
      childrenNamed(child(plane, 'Layer'), 'LayerElement').map(
        (element) => child(element, 'Type')?.props[0],
      ),
    ).toEqual(['LayerElementNormal', 'LayerElementUV', 'LayerElementMaterial']);
  });

  it('embeds each picture once, however many planes show it', () => {
    expect(childrenNamed(objects, 'Video')).toHaveLength(1);
    expect([...(child(video, 'Content')?.props[0] as Uint8Array)]).toEqual([1, 2, 3, 4]);
    expect(child(video, 'RelativeFilename')?.props).toEqual(['ref.png']);
  });

  it('wires the picture to a texture on the material both planes share', () => {
    const links = childrenNamed(child(root, 'Connections'), 'C').map((node) => node.props);
    const [, plane, other] = childrenNamed(objects, 'Model');

    expect(links).toContainEqual(['OP', texture?.props[0], material?.props[0], 'DiffuseColor']);
    expect(links).toContainEqual(['OO', video?.props[0], texture?.props[0]]);
    expect(links).toContainEqual(['OO', material?.props[0], plane.props[0]]);
    expect(links).toContainEqual(['OO', material?.props[0], other.props[0]]);
    // White, so the picture is not tinted by the plane's own colour.
    expect(property(material, 'DiffuseColor')).toEqual([1, 1, 1]);
  });

  it("counts the picture's objects in the definitions", () => {
    const definitions = child(root, 'Definitions');
    const counts = Object.fromEntries(
      childrenNamed(definitions, 'ObjectType').map((type) => [
        type.props[0],
        child(type, 'Count')?.props[0],
      ]),
    );

    expect(counts).toEqual({
      GlobalSettings: 1,
      Geometry: 3,
      Model: 3,
      Material: 2,
      Texture: 1,
      Video: 1,
    });
    expect(child(definitions, 'Count')?.props).toEqual([11]);
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
      groupId: null,
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

  it('round-trips the folders and what sits in them', () => {
    const [cube] = snapshot();
    const document = serializeProject(
      'Grouped',
      [
        { ...cube, groupId: 'group-1' },
        { ...cube, id: 'obj-2', name: 'Cube.COPY', mesh: createBox(2), groupId: 'group-1' },
      ],
      vec3(),
      'obj-1',
      [{ id: 'group-1', name: 'GROUP' }],
    );
    const restored = deserializeProject(parseProject(stringifyProject(document)));

    expect(restored.groups).toEqual([{ id: 'group-1', name: 'GROUP' }]);
    expect(restored.objects.map((object) => object.groupId)).toEqual(['group-1', 'group-1']);
  });

  it('loosens an object whose folder is gone', () => {
    const [cube] = snapshot();
    const document = serializeProject(
      'Grouped',
      [{ ...cube, groupId: 'group-gone' }],
      vec3(),
      null,
    );

    const restored = deserializeProject(parseProject(stringifyProject(document)));

    expect(restored.groups).toEqual([]);
    expect(restored.objects[0].groupId).toBeNull();
  });

  it('loads a file written before grouping with every object loose', () => {
    const [cube] = snapshot();
    const document = serializeProject('Old', [cube], vec3(), null);
    delete (document as { groups?: unknown }).groups;
    delete document.objects[0].groupId;

    const restored = deserializeProject(parseProject(stringifyProject(document)));

    expect(restored.groups).toEqual([]);
    expect(restored.objects[0].groupId).toBeNull();
  });

  it('rejects malformed files with a readable message', () => {
    expect(() => parseProject('not json')).toThrow(/not valid JSON/);
    expect(() => parseProject('{"version":99}')).toThrow(/Unsupported project version/);
    expect(() => parseProject('{"version":1}')).toThrow(/no objects array/);
    expect(() => parseProject('{"version":1,"objects":[{"name":"X"}]}')).toThrow(/no usable mesh/);
  });
});

describe('imported images', () => {
  it('keeps the proportions of the picture, at the size a primitive starts at', () => {
    expect(imagePlaneSize(1920, 1080)).toEqual({ width: 1, height: 0.5625 });
    expect(imagePlaneSize(512, 1024)).toEqual({ width: 0.5, height: 1 });
    expect(imagePlaneSize(256, 256)).toEqual({ width: 1, height: 1 });
  });

  it('stands the plane up facing the front view, not flat on the floor', () => {
    const mesh = createImagePlane(2, 1);
    const [face] = [...mesh.faces.values()];

    expect(face.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(mesh.validate()).toEqual([]);
  });

  it('maps the corners of the image onto the corners of the plane', () => {
    const mesh = createImagePlane(2, 1);
    const [face] = [...mesh.faces.values()];
    const loops = mesh.faceLoops(face);

    // Bottom-left of the picture on the bottom-left corner: without this the
    // reference arrives mirrored or upside down, which is worse than useless.
    expect(loops.map((loop) => loop.uv)).toEqual([
      { u: 0, v: 0 },
      { u: 1, v: 0 },
      { u: 1, v: 1 },
      { u: 0, v: 1 },
    ]);
    expect(loops.map((loop) => loop.vert.co)).toEqual([
      { x: -1, y: -0.5, z: 0 },
      { x: 1, y: -0.5, z: 0 },
      { x: 1, y: 0.5, z: 0 },
      { x: -1, y: 0.5, z: 0 },
    ]);
  });

  it('carries the image and its bytes through a round trip', () => {
    const asset = {
      id: 'asset-1',
      name: 'ref.png',
      type: 'image/png',
      width: 800,
      height: 600,
      data: 'aGVsbG8=',
    };
    const object = {
      id: 'obj-1',
      name: 'REF.PNG',
      transform: createTransform(),
      visible: true,
      locked: false,
      parentId: null,
      groupId: null,
      materials: [],
      modifiers: [],
      activeMaterial: 0,
      mesh: createImagePlane(1, 0.75),
      image: { assetId: 'asset-1' },
    };

    const document = serializeProject('Ref', [object], vec3(), 'obj-1', [], [asset]);
    const restored = deserializeProject(parseProject(stringifyProject(document)));

    expect(restored.objects[0].image).toEqual({ assetId: 'asset-1' });
    expect(restored.assets).toEqual([asset]);
  });

  it('leaves out an asset nothing in the scene points at', () => {
    const asset = { id: 'asset-1', name: 'ref.png', type: 'image/png', width: 8, height: 8 };
    const document = serializeProject('Ref', [], vec3(), null, [], [asset]);

    expect(document.assets).toEqual([]);
  });

  it('reads a file written before images existed', () => {
    const document = serializeProject('Old', [], vec3(), null);
    delete document.assets;

    const restored = deserializeProject(parseProject(stringifyProject(document)));
    expect(restored.assets).toEqual([]);
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
