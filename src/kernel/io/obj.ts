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
  convertDirection,
  convertPoint,
  resolveExportOptions,
  unitScaleFactor,
} from './types';
import { boxProjectUVs } from './uv';

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
): { obj: string; mtl: string } {
  const resolved = resolveExportOptions(options);
  const scale = resolved.scale * unitScaleFactor(resolved.unit);

  const lines: string[] = ['# Exported by 3DOO', 'mtllib model.mtl', ''];

  let vertexOffset = 1;
  let uvOffset = 1;
  let normalOffset = 1;

  for (const object of objects) {
    const mesh = prepareMesh(object, resolved);
    const matrix = resolved.applyTransform ? composeMatrix(object.transform) : composeMatrix(createTransform());
    const normals = normalMatrix(resolved.applyTransform ? object.transform : createTransform());

    lines.push(`o ${object.name.replace(/\s+/g, '_')}`);

    const vertIndex = new Map<number, number>();
    let localIndex = 0;
    for (const vert of mesh.verts.values()) {
      const world = transformPoint(matrix, vert.co);
      const point = convertPoint(world, resolved.upAxis, scale);
      lines.push(`v ${format(point.x)} ${format(point.y)} ${format(point.z)}`);
      vertIndex.set(vert.id, localIndex++);
    }

    const uvIndices: number[] = [];
    if (resolved.includeUVs) {
      for (const face of mesh.faces.values()) {
        for (const loop of mesh.faceLoops(face)) {
          lines.push(`vt ${format(loop.uv.u)} ${format(loop.uv.v)}`);
          uvIndices.push(uvIndices.length);
        }
      }
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

    let currentMaterial = -1;
    let loopCursor = 0;

    for (const face of mesh.faces.values()) {
      if (face.materialIndex !== currentMaterial) {
        currentMaterial = face.materialIndex;
        const material = object.materials[currentMaterial];
        const name = material ? material.name.replace(/\s+/g, '_') : `material_${currentMaterial}`;
        lines.push(`usemtl ${name}`);
      }

      const corners = mesh.faceLoops(face).map((loop) => {
        const v = (vertIndex.get(loop.vert.id) ?? 0) + vertexOffset;
        const vn = (faceNormalIndex.get(face.id) ?? 0) + normalOffset;
        if (!resolved.includeUVs) return `${v}//${vn}`;
        const vt = loopCursor++ + uvOffset;
        return `${v}/${vt}/${vn}`;
      });

      lines.push(`f ${corners.join(' ')}`);
    }

    vertexOffset += mesh.verts.size;
    uvOffset += uvIndices.length;
    normalOffset += normalCount;
    lines.push('');
  }

  return { obj: lines.join('\n'), mtl: buildMTL(objects) };
}

function buildMTL(objects: readonly ExportObject[]): string {
  const lines: string[] = ['# Exported by 3DOO', ''];
  const seen = new Set<string>();

  for (const object of objects) {
    for (const material of object.materials) {
      const name = material.name.replace(/\s+/g, '_');
      if (seen.has(name)) continue;
      seen.add(name);
      lines.push(
        `newmtl ${name}`,
        `Kd ${format(material.color.r)} ${format(material.color.g)} ${format(material.color.b)}`,
        'Ka 0.0 0.0 0.0',
        'Ks 0.0 0.0 0.0',
        'd 1.0',
        'illum 2',
        '',
      );
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
  if (options.includeUVs) boxProjectUVs(mesh);
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
