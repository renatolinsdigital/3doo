import {
  type Axis,
  type Mat4,
  type Vec3,
  axisVector,
  composeMatrix,
  createTransform,
  degToRad,
  multiplyMatrices,
  normalMatrix,
  normalize,
  radToDeg,
  rotationMatrix,
  sub,
  transformDirection,
  transformPoint,
  vec3,
} from '../math';
import type { BMesh } from '../mesh';

import { type ImportedObject, meshFromPolygons, prepareMesh } from './obj';
import {
  type ExportObject,
  type ExportOptions,
  type ExportTexture,
  type UpAxis,
  convertDirection,
  convertPoint,
  resolveExportOptions,
  textureMaterialName,
  unitScaleFactor,
} from './types';

/**
 * Binary FBX 7.4 (version 7400) writer.
 *
 * Binary rather than ASCII because Blender's stock importer refuses ASCII FBX
 * outright, while Unity, Unreal, Maya and 3ds Max read either. Arrays are stored
 * uncompressed, which the format allows, so no zlib is needed. The node layout
 * follows what Blender's own exporter writes, a file the FBX SDK is known to
 * accept.
 */

const FBX_VERSION = 7400;
const CREATOR = '3DOO';

const HEADER_MAGIC = 'Kaydara FBX Binary  \0\x1a\0';

// The FBX SDK checks FileId against CreationTime with an algorithm nobody has
// published, so this is the fixed pair Blender's exporter writes, which passes.
const FILE_ID = Uint8Array.from([
  0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1,
]);
const CREATION_TIME = '1970-01-01 10:00:00:000';
const FOOTER_ID = Uint8Array.from([
  0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e,
]);
const FOOTER_MAGIC = Uint8Array.from([
  0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b,
]);

/** The all-zero record that closes a nested node list in files before 7500. */
const SENTINEL_LENGTH = 13;

/**
 * Axis metadata as [axis, sign] for up, front and coord, where 0 = X, 1 = Y,
 * 2 = Z. Both are right-handed: Y-up is the Maya convention, Z-up the Blender
 * one with the front at -Y, which is where `convertPoint` puts our +Z.
 * A left-handed triple makes importers mirror the whole model.
 */
const AXIS_SYSTEMS: Record<UpAxis, Record<'up' | 'front' | 'coord', [number, number]>> = {
  y: { up: [1, 1], front: [2, 1], coord: [0, 1] },
  z: { up: [2, 1], front: [1, -1], coord: [0, 1] },
};

/**
 * The editor composes rotations as Rx·Ry·Rz, which FBX names ZYX (5). Moving
 * to Z-up turns that into Rx·Rz·Ry about the converted axes, which is YZX (2).
 */
const ROTATION_ORDER: Record<UpAxis, number> = { y: 5, z: 2 };

type Property =
  | { type: 'C'; value: boolean }
  | { type: 'I' | 'L' | 'D'; value: number }
  | { type: 'S'; value: string }
  | { type: 'R'; value: Uint8Array }
  | { type: 'i' | 'd'; value: readonly number[] };

interface FbxNode {
  name: string;
  props: Property[];
  children: FbxNode[];
}

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

const bool = (value: boolean): Property => ({ type: 'C', value });
const int32 = (value: number): Property => ({ type: 'I', value });
const int64 = (value: number): Property => ({ type: 'L', value });
const double = (value: number): Property => ({ type: 'D', value: finite(value) });
const string = (value: string): Property => ({ type: 'S', value });
const raw = (value: Uint8Array): Property => ({ type: 'R', value });
const int32s = (value: readonly number[]): Property => ({ type: 'i', value });
const doubles = (value: readonly number[]): Property => ({ type: 'd', value: value.map(finite) });

function node(name: string, props: Property[] = [], children: FbxNode[] = []): FbxNode {
  return { name, props, children };
}

/** One `P` entry of a `Properties70` block: name, type, label, flags, then the value. */
function p(name: string, type: string, label: string, flags: string, ...values: Property[]) {
  return node('P', [string(name), string(type), string(label), string(flags), ...values]);
}

function vector({ x, y, z }: Vec3): Property[] {
  return [double(x), double(y), double(z)];
}

/** Binary FBX writes `Geometry::Cube` as `Cube`, a `\0\x01` separator, then the class. */
function objectName(name: string, className: string): Property {
  return string(`${name}\0\x01${className}`);
}

/** FBX object ids must be unique and non-zero; 0 is reserved for the scene root. */
let idCounter = 1_000_000;

function nextId(): number {
  idCounter += 1;
  return idCounter;
}

interface GeometryData {
  positions: number[];
  polygonVertexIndex: number[];
  normals: number[];
  /** One pair per polygon vertex, written only for an image plane. */
  uvs: number[] | null;
  materials: number[];
}

function buildGeometry(mesh: BMesh, object: ExportObject, options: ExportOptions): GeometryData {
  const scale = options.scale * unitScaleFactor(options.unit);
  const transform = options.applyTransform ? object.transform : createTransform();
  const matrix = composeMatrix(transform);
  const normals = normalMatrix(transform);

  const positions: number[] = [];
  const vertIndex = new Map<number, number>();

  let index = 0;
  for (const vert of mesh.verts.values()) {
    const point = convertPoint(transformPoint(matrix, vert.co), options.upAxis, scale);
    positions.push(point.x, point.y, point.z);
    vertIndex.set(vert.id, index++);
  }

  const polygonVertexIndex: number[] = [];
  const normalValues: number[] = [];
  const uvs: number[] | null = object.texture ? [] : null;
  const materials: number[] = [];
  const corners = options.perVertexNormals ? mesh.cornerNormals() : null;

  for (const face of mesh.faces.values()) {
    const loops = mesh.faceLoops(face);
    // An image plane has a single material, the picture's.
    materials.push(object.texture ? 0 : Math.max(0, face.materialIndex));

    loops.forEach((loop, position) => {
      const vertex = vertIndex.get(loop.vert.id) ?? 0;
      // The last index of every polygon is encoded as -(index + 1). Without
      // this the importer cannot tell where one polygon ends and the next
      // begins, and the whole mesh comes in as garbage.
      polygonVertexIndex.push(position === loops.length - 1 ? -(vertex + 1) : vertex);

      const source =
        corners && face.smooth ? (corners.get(loop.id) ?? loop.vert.normal) : face.normal;
      const direction = convertDirection(
        normalize(transformDirection(normals, source)),
        options.upAxis,
      );
      normalValues.push(direction.x, direction.y, direction.z);
      uvs?.push(loop.uv.u, loop.uv.v);
    });
  }

  return { positions, polygonVertexIndex, normals: normalValues, uvs, materials };
}

export function exportFBX(
  objects: readonly ExportObject[],
  options: Partial<ExportOptions> = {},
): Uint8Array<ArrayBuffer> {
  const resolved = resolveExportOptions(options);

  // One material, texture and embedded file per picture, however many planes show it.
  const pictures = new Map<
    string,
    { texture: ExportTexture; materialId: number; textureId: number; videoId: number }
  >();
  const pictureMaterial = (texture: ExportTexture): number => {
    let picture = pictures.get(texture.fileName);
    if (!picture) {
      picture = { texture, materialId: nextId(), textureId: nextId(), videoId: nextId() };
      pictures.set(texture.fileName, picture);
    }
    return picture.materialId;
  };

  const entries = objects.map((object) => {
    const mesh = prepareMesh(object, resolved);
    return {
      object,
      data: buildGeometry(mesh, object, resolved),
      geometryId: nextId(),
      modelId: nextId(),
      materialIds: object.texture
        ? [pictureMaterial(object.texture)]
        : object.materials.map(() => nextId()),
    };
  });

  const ownMaterials = entries.reduce(
    (total, entry) => total + (entry.object.texture ? 0 : entry.materialIds.length),
    0,
  );
  const materialCount = ownMaterials + pictures.size;

  const objectNodes: FbxNode[] = [];
  const connections: FbxNode[] = [];
  const connect = (child: number, parent: number) =>
    connections.push(node('C', [string('OO'), int64(child), int64(parent)]));

  for (const { object, data, geometryId, modelId, materialIds } of entries) {
    objectNodes.push(geometryNode(geometryId, object.name, data));
    objectNodes.push(modelNode(modelId, object, resolved));
    if (!object.texture) {
      object.materials.forEach((material, index) => {
        objectNodes.push(materialNode(materialIds[index], material.name, material.color));
      });
    }

    connect(modelId, 0);
    connect(geometryId, modelId);
    for (const materialId of materialIds) connect(materialId, modelId);
  }

  for (const { texture, materialId, textureId, videoId } of pictures.values()) {
    const name = textureMaterialName(texture);
    // White, so an importer that tints the picture by the colour leaves it as it is.
    objectNodes.push(materialNode(materialId, name, { r: 1, g: 1, b: 1 }));
    objectNodes.push(textureNode(textureId, name, texture.fileName));
    objectNodes.push(videoNode(videoId, name, texture));

    connections.push(
      node('C', [string('OP'), int64(textureId), int64(materialId), string('DiffuseColor')]),
    );
    connect(videoId, textureId);
  }

  const definitions = [
    objectType('GlobalSettings', 1),
    objectType('Geometry', entries.length),
    objectType('Model', entries.length),
  ];
  if (materialCount > 0) definitions.push(objectType('Material', materialCount));
  if (pictures.size > 0) {
    definitions.push(objectType('Texture', pictures.size), objectType('Video', pictures.size));
  }

  const document: FbxNode[] = [
    headerExtension(new Date()),
    node('FileId', [raw(FILE_ID)]),
    node('CreationTime', [string(CREATION_TIME)]),
    node('Creator', [string(CREATOR)]),
    globalSettings(resolved),
    node(
      'Documents',
      [],
      [
        node('Count', [int32(1)]),
        node(
          'Document',
          [int64(nextId()), string('Scene'), string('Scene')],
          [
            node(
              'Properties70',
              [],
              [
                p('SourceObject', 'object', '', ''),
                p('ActiveAnimStackName', 'KString', '', '', string('')),
              ],
            ),
            node('RootNode', [int64(0)]),
          ],
        ),
      ],
    ),
    node('References'),
    node(
      'Definitions',
      [],
      [
        node('Version', [int32(100)]),
        node('Count', [int32(1 + entries.length * 2 + materialCount + pictures.size * 2)]),
        ...definitions,
      ],
    ),
    node('Objects', [], objectNodes),
    node('Connections', [], connections),
    node('Takes', [], [node('Current', [string('')])]),
  ];

  const out = new ByteWriter();
  out.bytes(encoder.encode(HEADER_MAGIC));
  out.uint32(FBX_VERSION);
  writeChildren(out, document, false);

  out.bytes(FOOTER_ID);
  out.zeros(4);
  // Pad to the next 16-byte boundary, and a full 16 when already on one.
  out.zeros(16 - (out.length % 16));
  out.uint32(FBX_VERSION);
  out.zeros(120);
  out.bytes(FOOTER_MAGIC);

  return out.result();
}

function headerExtension(now: Date): FbxNode {
  return node(
    'FBXHeaderExtension',
    [],
    [
      node('FBXHeaderVersion', [int32(1003)]),
      node('FBXVersion', [int32(FBX_VERSION)]),
      node('EncryptionType', [int32(0)]),
      node(
        'CreationTimeStamp',
        [],
        [
          node('Version', [int32(1000)]),
          node('Year', [int32(now.getFullYear())]),
          node('Month', [int32(now.getMonth() + 1)]),
          node('Day', [int32(now.getDate())]),
          node('Hour', [int32(now.getHours())]),
          node('Minute', [int32(now.getMinutes())]),
          node('Second', [int32(now.getSeconds())]),
          node('Millisecond', [int32(now.getMilliseconds())]),
        ],
      ),
      node('Creator', [string(CREATOR)]),
    ],
  );
}

function globalSettings(options: ExportOptions): FbxNode {
  const { up, front, coord } = AXIS_SYSTEMS[options.upAxis];
  // Centimetres per file unit, which is how importers learn the model's size.
  const unitScale = options.unit === 'centimeters' ? 1 : 100;
  const integer = (name: string, value: number) => p(name, 'int', 'Integer', '', int32(value));
  const number = (name: string, value: number) => p(name, 'double', 'Number', '', double(value));

  return node(
    'GlobalSettings',
    [],
    [
      node('Version', [int32(1000)]),
      node(
        'Properties70',
        [],
        [
          integer('UpAxis', up[0]),
          integer('UpAxisSign', up[1]),
          integer('FrontAxis', front[0]),
          integer('FrontAxisSign', front[1]),
          integer('CoordAxis', coord[0]),
          integer('CoordAxisSign', coord[1]),
          integer('OriginalUpAxis', up[0]),
          integer('OriginalUpAxisSign', up[1]),
          number('UnitScaleFactor', unitScale),
          number('OriginalUnitScaleFactor', unitScale),
        ],
      ),
    ],
  );
}

function objectType(name: string, count: number): FbxNode {
  return node('ObjectType', [string(name)], [node('Count', [int32(count)])]);
}

function layerElement(
  name: string,
  layerName: string,
  mapping: string,
  reference: string,
  ...data: FbxNode[]
): FbxNode {
  return node(
    name,
    [int32(0)],
    [
      node('Version', [int32(101)]),
      node('Name', [string(layerName)]),
      node('MappingInformationType', [string(mapping)]),
      node('ReferenceInformationType', [string(reference)]),
      ...data,
    ],
  );
}

function geometryNode(id: number, name: string, data: GeometryData): FbxNode {
  const elements = [
    layerElement(
      'LayerElementNormal',
      '',
      'ByPolygonVertex',
      'Direct',
      node('Normals', [doubles(data.normals)]),
    ),
  ];
  if (data.uvs) {
    // IndexToDirect, as every other exporter writes polygon-vertex UVs, with
    // each corner simply pointing at its own entry.
    const corners = Array.from({ length: data.uvs.length / 2 }, (_, index) => index);
    elements.push(
      layerElement(
        'LayerElementUV',
        'UVMap',
        'ByPolygonVertex',
        'IndexToDirect',
        node('UV', [doubles(data.uvs)]),
        node('UVIndex', [int32s(corners)]),
      ),
    );
  }
  elements.push(
    layerElement(
      'LayerElementMaterial',
      '',
      'ByPolygon',
      'IndexToDirect',
      node('Materials', [int32s(data.materials)]),
    ),
  );

  const layer = (type: string) =>
    node('LayerElement', [], [node('Type', [string(type)]), node('TypedIndex', [int32(0)])]);

  return node(
    'Geometry',
    [int64(id), objectName(name, 'Geometry'), string('Mesh')],
    [
      node('GeometryVersion', [int32(124)]),
      node('Vertices', [doubles(data.positions)]),
      node('PolygonVertexIndex', [int32s(data.polygonVertexIndex)]),
      ...elements,
      node(
        'Layer',
        [int32(0)],
        [node('Version', [int32(100)]), ...elements.map((element) => layer(element.name))],
      ),
    ],
  );
}

function textureNode(id: number, name: string, fileName: string): FbxNode {
  return node(
    'Texture',
    [int64(id), objectName(name, 'Texture'), string('')],
    [
      node('Type', [string('TextureVideoClip')]),
      node('Version', [int32(202)]),
      node('TextureName', [objectName(name, 'Texture')]),
      node('Media', [objectName(name, 'Video')]),
      node('FileName', [string(fileName)]),
      node('RelativeFilename', [string(fileName)]),
      node('Properties70', [], [p('UseMaterial', 'bool', '', '', int32(1))]),
    ],
  );
}

/**
 * The image file itself, embedded as `Content`. The names point at a file
 * beside the FBX too, but the one file is all an importer needs.
 */
function videoNode(id: number, name: string, texture: ExportTexture): FbxNode {
  return node(
    'Video',
    [int64(id), objectName(name, 'Video'), string('Clip')],
    [
      node('Type', [string('Clip')]),
      node('Properties70', [], [p('Path', 'KString', 'Url', '', string(texture.fileName))]),
      node('UseMipMap', [int32(0)]),
      node('Filename', [string(texture.fileName)]),
      node('RelativeFilename', [string(texture.fileName)]),
      node('Content', [raw(texture.data)]),
    ],
  );
}

function modelNode(id: number, object: ExportObject, options: ExportOptions): FbxNode {
  // Baking the transform into the vertices leaves the node at the origin.
  const transform = options.applyTransform ? createTransform() : object.transform;
  const scale = options.scale * unitScaleFactor(options.unit);
  const translation = convertPoint(transform.position, options.upAxis, scale);
  const rotation = convertDirection(
    {
      x: radToDeg(transform.rotation.x),
      y: radToDeg(transform.rotation.y),
      z: radToDeg(transform.rotation.z),
    },
    options.upAxis,
  );
  // Scale factors swap axes with the conversion but never change sign.
  const { x, y, z } = transform.scale;
  const scaling = options.upAxis === 'z' ? { x, y: z, z: y } : { x, y, z };

  return node(
    'Model',
    [int64(id), objectName(object.name, 'Model'), string('Mesh')],
    [
      node('Version', [int32(232)]),
      node(
        'Properties70',
        [],
        [
          // Importers ignore RotationOrder unless RotationActive is set.
          p('RotationActive', 'bool', '', '', int32(1)),
          p('RotationOrder', 'enum', '', '', int32(ROTATION_ORDER[options.upAxis])),
          p('InheritType', 'enum', '', '', int32(1)),
          p('Lcl Translation', 'Lcl Translation', '', 'A', ...vector(translation)),
          p('Lcl Rotation', 'Lcl Rotation', '', 'A', ...vector(rotation)),
          p('Lcl Scaling', 'Lcl Scaling', '', 'A', ...vector(scaling)),
          p('DefaultAttributeIndex', 'int', 'Integer', '', int32(0)),
        ],
      ),
      node('MultiLayer', [int32(0)]),
      node('MultiTake', [int32(0)]),
      node('Shading', [bool(true)]),
      node('Culling', [string('CullingOff')]),
    ],
  );
}

function materialNode(
  id: number,
  name: string,
  color: { r: number; g: number; b: number },
): FbxNode {
  const rgb = [double(color.r), double(color.g), double(color.b)];

  return node(
    'Material',
    [int64(id), objectName(name, 'Material'), string('')],
    [
      node('Version', [int32(102)]),
      node('ShadingModel', [string('phong')]),
      node('MultiLayer', [int32(0)]),
      node(
        'Properties70',
        [],
        [
          p('ShadingModel', 'KString', '', '', string('phong')),
          p('DiffuseColor', 'Color', '', 'A', ...rgb),
          p('Diffuse', 'Vector3D', 'Vector', '', ...rgb),
          p('SpecularColor', 'Color', '', 'A', double(0), double(0), double(0)),
          p('Shininess', 'double', 'Number', '', double(20)),
          p('Opacity', 'double', 'Number', '', double(1)),
        ],
      ),
    ],
  );
}

const encoder = new TextEncoder();

/** A little-endian byte buffer that grows as it is written and can patch earlier offsets. */
class ByteWriter {
  private buffer = new ArrayBuffer(1 << 16);
  private view = new DataView(this.buffer);
  length = 0;

  private reserve(count: number): void {
    if (this.length + count <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength * 2;
    while (size < this.length + count) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buffer, 0, this.length));
    this.buffer = next;
    this.view = new DataView(next);
  }

  uint8(value: number): void {
    this.reserve(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  uint32(value: number): void {
    this.reserve(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  int32(value: number): void {
    this.reserve(4);
    this.view.setInt32(this.length, value, true);
    this.length += 4;
  }

  int64(value: number): void {
    this.reserve(8);
    this.view.setBigInt64(this.length, BigInt(value), true);
    this.length += 8;
  }

  float64(value: number): void {
    this.reserve(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  bytes(data: Uint8Array): void {
    this.reserve(data.length);
    new Uint8Array(this.buffer).set(data, this.length);
    this.length += data.length;
  }

  zeros(count: number): void {
    this.reserve(count);
    new Uint8Array(this.buffer, this.length, count).fill(0);
    this.length += count;
  }

  patchUint32(offset: number, value: number): void {
    this.view.setUint32(offset, value, true);
  }

  result(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.buffer.slice(0, this.length));
  }
}

function writeProperty(out: ByteWriter, prop: Property): void {
  out.uint8(prop.type.charCodeAt(0));
  switch (prop.type) {
    case 'C':
      out.uint8(prop.value ? 1 : 0);
      return;
    case 'I':
      out.int32(prop.value);
      return;
    case 'L':
      out.int64(prop.value);
      return;
    case 'D':
      out.float64(prop.value);
      return;
    case 'S':
    case 'R': {
      const data = typeof prop.value === 'string' ? encoder.encode(prop.value) : prop.value;
      out.uint32(data.length);
      out.bytes(data);
      return;
    }
    case 'i':
    case 'd': {
      const size = prop.type === 'i' ? 4 : 8;
      out.uint32(prop.value.length);
      out.uint32(0); // encoding: 0 is raw, 1 would be zlib
      out.uint32(prop.value.length * size);
      for (const value of prop.value) {
        if (prop.type === 'i') out.int32(value);
        else out.float64(value);
      }
    }
  }
}

/**
 * A node is its end offset (absolute in the file), property count, property
 * byte length and name, then the properties, then any children.
 */
function writeNode(out: ByteWriter, fbxNode: FbxNode, isLast: boolean): void {
  const start = out.length;
  out.uint32(0);
  out.uint32(fbxNode.props.length);
  out.uint32(0);

  const name = encoder.encode(fbxNode.name);
  out.uint8(name.length);
  out.bytes(name);

  const propsStart = out.length;
  for (const prop of fbxNode.props) writeProperty(out, prop);
  out.patchUint32(start + 8, out.length - propsStart);

  // A node with neither properties nor children still gets the closing record
  // unless it is the last in its list, which is how the FBX SDK writes it.
  writeChildren(out, fbxNode.children, fbxNode.props.length === 0 && !isLast);
  out.patchUint32(start, out.length);
}

function writeChildren(out: ByteWriter, children: readonly FbxNode[], closeWhenEmpty: boolean) {
  children.forEach((child, index) => writeNode(out, child, index === children.length - 1));
  if (children.length > 0 || closeWhenEmpty) out.zeros(SENTINEL_LENGTH);
}

// ---------------------------------------------------------------- import

/**
 * An array as a binary file stores it: packed, and often deflated. Left that
 * way until something asks for it, since a file carries normals, UVs and
 * animation curves an import never reads, and inflating is the slow part.
 */
class PackedArray {
  constructor(
    readonly type: 'b' | 'i' | 'l' | 'f' | 'd',
    readonly count: number,
    readonly encoding: number,
    readonly data: Uint8Array<ArrayBuffer>,
  ) {}
}

type ReadValue = number | bigint | boolean | string | Uint8Array | PackedArray | number[];

interface ReadNode {
  name: string;
  props: ReadValue[];
  children: ReadNode[];
}

const decoder = new TextDecoder();

function readBinary(bytes: Uint8Array<ArrayBuffer>): ReadNode[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // From 7500 on, the three lengths that open a record are 64-bit.
  const wide = view.getUint32(23, true) >= 7500;
  const word = wide ? 8 : 4;
  const length = (at: number) =>
    wide ? Number(view.getBigUint64(at, true)) : view.getUint32(at, true);
  let offset = 27;

  const property = (): ReadValue => {
    const type = String.fromCharCode(bytes[offset]);
    const at = offset + 1;
    switch (type) {
      case 'C':
        offset = at + 1;
        return bytes[at] !== 0;
      case 'Y':
        offset = at + 2;
        return view.getInt16(at, true);
      case 'I':
        offset = at + 4;
        return view.getInt32(at, true);
      case 'F':
        offset = at + 4;
        return view.getFloat32(at, true);
      case 'D':
        offset = at + 8;
        return view.getFloat64(at, true);
      case 'L':
        offset = at + 8;
        return view.getBigInt64(at, true);
      case 'S':
      case 'R': {
        offset = at + 4 + view.getUint32(at, true);
        const data = bytes.subarray(at + 4, offset);
        return type === 'S' ? decoder.decode(data) : data;
      }
      case 'b':
      case 'i':
      case 'l':
      case 'f':
      case 'd': {
        offset = at + 12 + view.getUint32(at + 8, true);
        return new PackedArray(
          type,
          view.getUint32(at, true),
          view.getUint32(at + 4, true),
          bytes.subarray(at + 12, offset),
        );
      }
      default:
        throw new Error(`Unknown property type at byte ${offset}`);
    }
  };

  const record = (): ReadNode | null => {
    const end = length(offset);
    const count = length(offset + word);
    const nameStart = offset + word * 3 + 1;
    offset = nameStart + bytes[nameStart - 1];
    // The all-zero record that closes a list.
    if (end === 0) return null;
    if (end > bytes.length) throw new RangeError('A record runs past the end of the file');

    const name = decoder.decode(bytes.subarray(nameStart, offset));
    const props = Array.from({ length: count }, property);
    const children: ReadNode[] = [];
    while (offset < end) {
      const child = record();
      if (child) children.push(child);
    }
    if (offset !== end) throw new RangeError(`${name} does not end where it says`);
    return { name, props, children };
  };

  const nodes: ReadNode[] = [];
  for (let next = record(); next; next = offset < bytes.length ? record() : null) {
    nodes.push(next);
  }
  return nodes;
}

type Token =
  | { kind: 'name'; text: string }
  | { kind: 'value'; value: ReadValue }
  | { kind: 'array' | '{' | '}' | ',' | 'end' };

/**
 * One ASCII token: whitespace, a `;` comment, a quoted string, a `Name:`, an
 * array's `*count`, a number, a bare word such as the `Y` of `Shading: Y`, or
 * punctuation.
 */
const ASCII_TOKEN =
  /\s+|;[^\n]*|"([^"]*)"|([A-Za-z_][\w|]*):|\*\d+|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([A-Za-z_][\w|]*)|([{},])/y;

/** A number as the text spells it, kept exact when it is an id too long for a double. */
function asciiNumber(text: string): number | bigint {
  const value = Number(text);
  return Number.isSafeInteger(value) || !/^[-+]?\d+$/.test(text) ? value : BigInt(text);
}

/**
 * Reads ASCII FBX into the same tree the binary reader builds, so everything
 * after this point reads both the same way.
 *
 * An array is written as `Vertices: *24 { a: 1,2,3,... }`: its values are
 * lifted out of the `a` child into the one property a binary file holds them in.
 */
function readAscii(text: string): ReadNode[] {
  const scanner = new RegExp(ASCII_TOKEN);
  const scan = (): Token => {
    while (scanner.lastIndex < text.length) {
      const at = scanner.lastIndex;
      const match = scanner.exec(text);
      if (!match) throw new Error(`Unreadable text at character ${at}`);
      const [whole, quoted, name, number, word, mark] = match;
      if (quoted !== undefined) return { kind: 'value', value: quoted.replace(/&quot;/g, '"') };
      if (name !== undefined) return { kind: 'name', text: name };
      if (number !== undefined) return { kind: 'value', value: asciiNumber(number) };
      if (word !== undefined) return { kind: 'value', value: word };
      if (mark !== undefined) return { kind: mark as '{' | '}' | ',' };
      if (whole.startsWith('*')) return { kind: 'array' };
    }
    return { kind: 'end' };
  };

  let token = scan();
  const list = (closing: boolean): ReadNode[] => {
    const nodes: ReadNode[] = [];
    for (;;) {
      if (token.kind === 'end') {
        if (closing) throw new Error('A { is never closed');
        return nodes;
      }
      if (token.kind === '}') {
        if (!closing) throw new Error('A } closes nothing');
        token = scan();
        return nodes;
      }
      if (token.kind !== 'name') {
        throw new Error(`Expected a name at character ${scanner.lastIndex}`);
      }

      const name = token.text;
      const props: ReadValue[] = [];
      let packed = false;
      token = scan();
      // Commas only separate, and embedded content is written `Content: , "..."`,
      // with one before anything to separate.
      while (token.kind === 'value' || token.kind === 'array' || token.kind === ',') {
        if (token.kind === 'array') packed = true;
        if (token.kind === 'value') props.push(token.value);
        token = scan();
      }

      let children: ReadNode[] = [];
      if (token.kind === '{') {
        token = scan();
        children = list(true);
      }
      if (packed) {
        props.push((children.find((child) => child.name === 'a')?.props ?? []).map(Number));
        children = [];
      }
      nodes.push({ name, props, children });
    }
  };
  return list(false);
}

const BINARY_MAGIC = encoder.encode(HEADER_MAGIC.slice(0, 18));

function readDocument(bytes: Uint8Array<ArrayBuffer>): ReadNode[] {
  if (BINARY_MAGIC.every((byte, index) => bytes[index] === byte)) {
    try {
      return readBinary(bytes);
    } catch (error) {
      // A length that points past the end is a file cut short, and the
      // DataView's own words for that ("offset is outside the bounds") say
      // nothing useful.
      if (error instanceof RangeError) throw new Error('The file is damaged or cut short');
      throw error;
    }
  }

  const text = decoder.decode(bytes);
  if (!text.includes('FBXHeaderExtension')) throw new Error('Not an FBX file');
  return readAscii(text);
}

function childNode(nodes: readonly ReadNode[] | undefined, name: string): ReadNode | undefined {
  return nodes?.find((node) => node.name === name);
}

function scalar(value: ReadValue | undefined, fallback = 0): number {
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return Number(value);
  }
  return fallback;
}

/** A node's `Properties70`, by name, each holding what follows name, type, label and flags. */
function properties(owner: ReadNode | undefined): Map<string, ReadValue[]> {
  const entries = childNode(owner?.children, 'Properties70')?.children ?? [];
  return new Map(entries.map((entry) => [String(entry.props[0]), entry.props.slice(4)]));
}

function vectorProperty(props: Map<string, ReadValue[]>, name: string, fallback = 0): Vec3 {
  const values = props.get(name) ?? [];
  return vec3(
    scalar(values[0], fallback),
    scalar(values[1], fallback),
    scalar(values[2], fallback),
  );
}

/** A binary file writes `Cube\0\x01Model`, an ASCII one `Model::Cube`. */
function objectLabel(value: ReadValue | undefined): string {
  if (typeof value !== 'string') return '';
  const binary = value.indexOf('\0\x01');
  if (binary >= 0) return value.slice(0, binary);
  const ascii = value.indexOf('::');
  return ascii >= 0 ? value.slice(ascii + 2) : value;
}

/**
 * Inflates a zlib stream, which is how a binary file packs any array worth
 * packing. Through the browser's own decompressor, so no library is needed.
 */
async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  // Neither is awaited: a write only settles once the other end has read it,
  // and a damaged stream is reported by the read below.
  writer.write(data).catch(() => {});
  writer.close().catch(() => {});
  try {
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
  } catch {
    throw new Error('The file is damaged: an array inside it does not unpack');
  }
}

const ELEMENT_SIZE: Record<PackedArray['type'], number> = { b: 1, i: 4, l: 8, f: 4, d: 8 };

async function numbers(owner: ReadNode | undefined): Promise<number[]> {
  const value = owner?.props[0];
  if (Array.isArray(value)) return value;
  if (!(value instanceof PackedArray)) return [];

  if (value.encoding > 1) throw new Error(`Unknown array encoding ${value.encoding}`);
  const data = value.encoding === 1 ? await inflate(value.data) : value.data;
  const size = ELEMENT_SIZE[value.type];
  if (data.byteLength < value.count * size) {
    throw new Error('The file is damaged: an array is shorter than it says');
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const read = {
    b: (at: number) => view.getUint8(at),
    i: (at: number) => view.getInt32(at, true),
    l: (at: number) => Number(view.getBigInt64(at, true)),
    f: (at: number) => view.getFloat32(at, true),
    d: (at: number) => view.getFloat64(at, true),
  }[value.type];
  return Array.from({ length: value.count }, (_, index) => read(index * size));
}

/** Splits `PolygonVertexIndex`, where each polygon's last corner is stored as `-(index + 1)`. */
function polygonsOf(indices: readonly number[]): number[][] {
  const polygons: number[][] = [];
  let polygon: number[] = [];
  for (const index of indices) {
    if (index >= 0) {
      polygon.push(index);
      continue;
    }
    polygon.push(-index - 1);
    polygons.push(polygon);
    polygon = [];
  }
  return polygons;
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function translation({ x, y, z }: Vec3): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function scaling({ x, y, z }: Vec3): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

/** `RotationOrder` as the axes in the order they turn: 0, XYZ, turns about X first. */
const EULER_ORDERS: readonly (readonly Axis[])[] = [
  ['x', 'y', 'z'],
  ['x', 'z', 'y'],
  ['y', 'z', 'x'],
  ['y', 'x', 'z'],
  ['z', 'x', 'y'],
  ['z', 'y', 'x'],
];

function euler(degrees: Vec3, order: readonly Axis[] = EULER_ORDERS[0]): Mat4 {
  return order.reduce<Mat4>(
    (matrix, axis) =>
      multiplyMatrices(rotationMatrix(axisVector(axis), degToRad(degrees[axis])), matrix),
    IDENTITY,
  );
}

function chain(...matrices: Mat4[]): Mat4 {
  return matrices.reduce(multiplyMatrices, IDENTITY);
}

/** The upper 3x3 transposed, which inverts a pure rotation. */
function transposed(m: Mat4): Mat4 {
  return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
}

/** Of the upper 3x3: negative when the matrix mirrors. */
function determinant(m: Mat4): number {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

/**
 * A model's transform within its parent, as the FBX SDK documents it:
 * `T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹`.
 *
 * `RotationActive` gates the rotation order and the pre and post rotations,
 * which are otherwise ignored. Pre and post rotations always turn XYZ.
 */
function localMatrix(model: ReadNode): Mat4 {
  const props = properties(model);
  const active = scalar(props.get('RotationActive')?.[0]) !== 0;
  const order = active ? EULER_ORDERS[scalar(props.get('RotationOrder')?.[0])] : undefined;
  const rotationPivot = vectorProperty(props, 'RotationPivot');
  const scalingPivot = vectorProperty(props, 'ScalingPivot');

  return chain(
    translation(vectorProperty(props, 'Lcl Translation')),
    translation(vectorProperty(props, 'RotationOffset')),
    translation(rotationPivot),
    active ? euler(vectorProperty(props, 'PreRotation')) : IDENTITY,
    euler(vectorProperty(props, 'Lcl Rotation'), order),
    active ? transposed(euler(vectorProperty(props, 'PostRotation'))) : IDENTITY,
    translation(sub(vec3(), rotationPivot)),
    translation(vectorProperty(props, 'ScalingOffset')),
    translation(scalingPivot),
    scaling(vectorProperty(props, 'Lcl Scaling', 1)),
    translation(sub(vec3(), scalingPivot)),
  );
}

/** The offset that moves a model's mesh without moving the model, or its children. */
function geometricMatrix(model: ReadNode): Mat4 {
  const props = properties(model);
  return chain(
    translation(vectorProperty(props, 'GeometricTranslation')),
    euler(vectorProperty(props, 'GeometricRotation')),
    scaling(vectorProperty(props, 'GeometricScaling', 1)),
  );
}

/**
 * From the file's axes and units into the editor's: X right, Y up, Z toward
 * the viewer, in metres. The inverse of what `AXIS_SYSTEMS` and `convertPoint`
 * do on the way out.
 *
 * `UnitScaleFactor` is centimetres per file unit, and a file that does not say
 * is in centimetres, the format's default. Axes that are not a permutation of
 * X, Y and Z are a broken header, read as the default Y-up.
 */
function axisMatrix(settings: ReadNode | undefined): Mat4 {
  const props = properties(settings);
  const axis = (name: string, fallback: number) => ({
    index: scalar(props.get(`${name}Axis`)?.[0], fallback),
    sign: scalar(props.get(`${name}AxisSign`)?.[0], 1) < 0 ? -1 : 1,
  });
  let rows = [axis('Coord', 0), axis('Up', 1), axis('Front', 2)];
  const indices = rows.map((row) => row.index).sort();
  if (indices.join() !== '0,1,2') {
    rows = [0, 1, 2].map((index) => ({ index, sign: 1 }));
  }

  const unit = scalar(props.get('UnitScaleFactor')?.[0], 1);
  const scale = (unit > 0 ? unit : 1) / 100;
  const matrix = new Array<number>(16).fill(0);
  rows.forEach(({ index, sign }, row) => {
    matrix[index * 4 + row] = sign * scale;
  });
  matrix[15] = 1;
  return matrix;
}

/**
 * Reads the meshes out of an FBX file, binary or ASCII, version 7 onwards.
 *
 * Every model holding a mesh becomes an object. Its whole placement is baked
 * into the vertices: its parents, pivots and offsets, the geometric transform
 * that moves the mesh alone, and the file's own axes and units. Only where its
 * origin lands is kept apart, as the object's position, so it arrives the right
 * way up, the right size and pivoting where it did.
 *
 * Async because a binary file deflates its arrays, and the browser only
 * inflates through a stream.
 */
export async function importFBX(bytes: Uint8Array<ArrayBuffer>): Promise<ImportedObject[]> {
  const document = readDocument(bytes);

  const header = childNode(document, 'FBXHeaderExtension');
  const version = scalar(childNode(header?.children, 'FBXVersion')?.props[0], FBX_VERSION);
  if (version < 7000) {
    throw new Error(
      `FBX ${(version / 1000).toFixed(1)} is too old: only FBX 7 and later can be read`,
    );
  }

  const models = new Map<string, ReadNode>();
  const geometries = new Map<string, ReadNode>();
  for (const entry of childNode(document, 'Objects')?.children ?? []) {
    const id = String(entry.props[0]);
    if (entry.name === 'Model') models.set(id, entry);
    // Blend shapes and curves are stored as Geometry too: only a Mesh is one.
    if (entry.name === 'Geometry' && entry.props[2] === 'Mesh') geometries.set(id, entry);
  }

  // Ids as text: they are 64-bit, and two of them rounded to the same double
  // would wire the wrong mesh to the wrong model.
  const parents = new Map<string, string>();
  const meshes = new Map<string, string[]>();
  for (const link of childNode(document, 'Connections')?.children ?? []) {
    if (link.name !== 'C' || link.props[0] !== 'OO') continue;
    const child = String(link.props[1]);
    const parent = String(link.props[2]);
    if (!models.has(parent)) continue;
    if (models.has(child)) parents.set(child, parent);
    if (geometries.has(child)) meshes.set(parent, [...(meshes.get(parent) ?? []), child]);
  }

  const axes = axisMatrix(childNode(document, 'GlobalSettings'));
  const worlds = new Map<string, Mat4>();
  const world = (id: string, depth = 0): Mat4 => {
    const known = worlds.get(id);
    if (known) return known;
    const local = localMatrix(models.get(id) as ReadNode);
    const parent = parents.get(id);
    // A chain longer than there are models loops back on itself: a broken
    // file, cut here rather than followed forever.
    const matrix =
      parent && depth < models.size ? multiplyMatrices(world(parent, depth + 1), local) : local;
    worlds.set(id, matrix);
    return matrix;
  };

  const imported: ImportedObject[] = [];
  for (const [modelId, model] of models) {
    for (const geometryId of meshes.get(modelId) ?? []) {
      const geometry = geometries.get(geometryId) as ReadNode;
      const name = objectLabel(model.props[1]) || objectLabel(geometry.props[1]) || 'imported';

      const placed = multiplyMatrices(axes, world(modelId));
      const matrix = multiplyMatrices(placed, geometricMatrix(model));
      const origin = transformPoint(placed, vec3());

      const coordinates = await numbers(childNode(geometry.children, 'Vertices'));
      const positions: Vec3[] = [];
      for (let index = 0; index + 2 < coordinates.length; index += 3) {
        const point = vec3(coordinates[index], coordinates[index + 1], coordinates[index + 2]);
        positions.push(sub(transformPoint(matrix, point), origin));
      }

      const polygons = polygonsOf(
        await numbers(childNode(geometry.children, 'PolygonVertexIndex')),
      );
      // Baking a mirror into the vertices turns every face inside out, so the
      // corners go round the other way to keep them facing out.
      if (determinant(matrix) < 0) for (const polygon of polygons) polygon.reverse();

      const mesh = meshFromPolygons(name, positions, polygons);
      if (mesh.faces.size > 0) imported.push({ name, mesh, position: origin });
    }
  }
  return imported;
}
