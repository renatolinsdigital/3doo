import {
  type Vec3,
  composeMatrix,
  createTransform,
  normalMatrix,
  normalize,
  transformDirection,
  transformPoint,
  vec3,
} from '../math';
import { BMesh, cloneMesh } from '../mesh';
import { triangulateFaces } from '../ops/subdivide';

import {
  type ExportObject,
  type ExportOptions,
  type Material,
  convertDirection,
  convertPoint,
  resolveExportOptions,
  textureMaterialName,
  unitScaleFactor,
} from './types';

function format(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/**
 * OBJ export.
 *
 * Built before FBX on purpose: it is simple enough to read by eye, so the
 * kernel's vertex order, winding, normals and material assignment can all be
 * validated against a known-good format before FBX complexity is added.
 */
export function exportOBJ(
  objects: readonly ExportObject[],
  options: Partial<ExportOptions> = {},
  materialLibrary = 'model.mtl',
): { obj: string; mtl: string } {
  const resolved = resolveExportOptions(options);
  const scale = resolved.scale * unitScaleFactor(resolved.unit);

  const lines: string[] = ['# Exported by 3DOO', `mtllib ${materialLibrary}`, ''];

  let vertexOffset = 1;
  let uvOffset = 1;
  let normalOffset = 1;

  for (const object of objects) {
    const mesh = prepareMesh(object, resolved);
    const transform = resolved.applyTransform ? object.transform : createTransform();
    const matrix = composeMatrix(transform);
    const normals = normalMatrix(transform);

    lines.push(`o ${object.name.replace(/\s+/g, '_')}`);

    const vertIndex = new Map<number, number>();
    let localIndex = 0;
    for (const vert of mesh.verts.values()) {
      const world = transformPoint(matrix, vert.co);
      const point = convertPoint(world, resolved.upAxis, scale);
      lines.push(`v ${format(point.x)} ${format(point.y)} ${format(point.z)}`);
      vertIndex.set(vert.id, localIndex++);
    }

    const faceNormalIndex = new Map<number, number>();
    let normalCount = 0;
    for (const face of mesh.faces.values()) {
      const direction = convertDirection(
        normalize(transformDirection(normals, face.normal)),
        resolved.upAxis,
      );
      lines.push(`vn ${format(direction.x)} ${format(direction.y)} ${format(direction.z)}`);
      faceNormalIndex.set(face.id, normalCount++);
    }

    const { texture } = object;
    let uvCount = 0;
    if (texture) {
      for (const face of mesh.faces.values()) {
        for (const loop of mesh.faceLoops(face)) {
          lines.push(`vt ${format(loop.uv.u)} ${format(loop.uv.v)}`);
        }
      }
      lines.push(`usemtl ${textureMaterialName(texture)}`);
    }

    let currentMaterial = -1;

    for (const face of mesh.faces.values()) {
      if (!texture && face.materialIndex !== currentMaterial) {
        currentMaterial = face.materialIndex;
        const material = object.materials[currentMaterial];
        const name = material ? material.name.replace(/\s+/g, '_') : `material_${currentMaterial}`;
        lines.push(`usemtl ${name}`);
      }

      const corners = mesh.faceLoops(face).map((loop) => {
        const v = (vertIndex.get(loop.vert.id) ?? 0) + vertexOffset;
        const vn = (faceNormalIndex.get(face.id) ?? 0) + normalOffset;
        if (!texture) return `${v}//${vn}`;
        // The UVs were written in this same face and loop order.
        return `${v}/${uvOffset + uvCount++}/${vn}`;
      });

      lines.push(`f ${corners.join(' ')}`);
    }

    vertexOffset += mesh.verts.size;
    uvOffset += uvCount;
    normalOffset += normalCount;
    lines.push('');
  }

  return { obj: lines.join('\n'), mtl: buildMTL(objects) };
}

function buildMTL(objects: readonly ExportObject[]): string {
  const lines: string[] = ['# Exported by 3DOO', ''];
  const seen = new Set<string>();

  const add = (name: string, color: Material['color'], map?: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    lines.push(
      `newmtl ${name}`,
      `Kd ${format(color.r)} ${format(color.g)} ${format(color.b)}`,
      'Ka 0.0 0.0 0.0',
      'Ks 0.0 0.0 0.0',
      'd 1.0',
      'illum 2',
      ...(map ? [`map_Kd ${map}`] : []),
      '',
    );
  };

  for (const object of objects) {
    if (object.texture) {
      // White, so an importer that tints the picture by the colour leaves it as it is.
      add(textureMaterialName(object.texture), { r: 1, g: 1, b: 1 }, object.texture.fileName);
      continue;
    }
    for (const material of object.materials) {
      add(material.name.replace(/\s+/g, '_'), material.color);
    }
  }

  return lines.join('\n');
}

/**
 * Applies the export options that change geometry, on a copy. The document's
 * own mesh is never modified by an export.
 */
export function prepareMesh(object: ExportObject, options: ExportOptions): BMesh {
  const mesh = cloneMesh(object.mesh);
  if (options.triangulate) triangulateFaces(mesh, [...mesh.faces.values()]);
  mesh.computeNormals();
  return mesh;
}

export interface ImportedObject {
  name: string;
  mesh: BMesh;
}

interface ObjGroup {
  name: string;
  polygons: number[][];
}

/**
 * Parses OBJ geometry into one mesh per `o`/`g` group.
 *
 * Positions are collected globally first because OBJ face indices address the
 * whole file, not the current group.
 */
export function importOBJ(text: string): ImportedObject[] {
  const positions: Vec3[] = [];
  const groups: ObjGroup[] = [];

  const currentGroup = (): ObjGroup => {
    const last = groups[groups.length - 1];
    if (last) return last;
    const created: ObjGroup = { name: 'imported', polygons: [] };
    groups.push(created);
    return created;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const [keyword, ...rest] = line.split(/\s+/);

    if (keyword === 'v') {
      positions.push(vec3(Number(rest[0]) || 0, Number(rest[1]) || 0, Number(rest[2]) || 0));
      continue;
    }

    if (keyword === 'o' || keyword === 'g') {
      groups.push({ name: rest.join(' ') || `object_${groups.length + 1}`, polygons: [] });
      continue;
    }

    if (keyword !== 'f') continue;

    const polygon: number[] = [];
    for (const token of rest) {
      const raw = Number(token.split('/')[0]);
      if (!Number.isFinite(raw) || raw === 0) continue;
      // OBJ indices are 1-based; negatives count back from the last vertex.
      polygon.push(raw > 0 ? raw - 1 : positions.length + raw);
    }
    if (polygon.length >= 3) currentGroup().polygons.push(polygon);
  }

  const objects: ImportedObject[] = [];
  for (const group of groups) {
    if (group.polygons.length === 0) continue;

    const mesh = new BMesh();
    const local = new Map<number, number>();

    for (const polygon of group.polygons) {
      const ring = [];
      for (const index of polygon) {
        const source = positions[index];
        if (!source) continue;
        let vertId = local.get(index);
        if (vertId === undefined) {
          vertId = mesh.addVert(source).id;
          local.set(index, vertId);
        }
        const vert = mesh.verts.get(vertId);
        if (vert) ring.push(vert);
      }
      if (ring.length >= 3) mesh.addFace(ring);
    }

    mesh.computeNormals();
    objects.push({ name: group.name, mesh });
  }

  return objects;
}
