import { type Transform, type Vec3, createTransform, vec3 } from '../math';
import { type MeshData, BMesh, deserializeMesh, serializeMesh } from '../mesh';
import type { Modifier } from '../modifiers';

import type { Material } from './types';

export interface SceneObjectData {
  id: string;
  name: string;
  transform: Transform;
  visible: boolean;
  locked: boolean;
  parentId: string | null;
  materials: Material[];
  modifiers: Modifier[];
  activeMaterial: number;
  mesh: MeshData;
}

export interface ProjectDocument {
  version: 1;
  name: string;
  savedAt: string;
  cursor: Vec3;
  activeObjectId: string | null;
  objects: SceneObjectData[];
}

export interface SceneObjectSnapshot {
  id: string;
  name: string;
  transform: Transform;
  visible: boolean;
  locked: boolean;
  parentId: string | null;
  materials: Material[];
  modifiers: Modifier[];
  activeMaterial: number;
  mesh: BMesh;
}

export function serializeProject(
  name: string,
  objects: readonly SceneObjectSnapshot[],
  cursor: Vec3,
  activeObjectId: string | null,
): ProjectDocument {
  return {
    version: 1,
    name,
    savedAt: new Date().toISOString(),
    cursor: { ...cursor },
    activeObjectId,
    objects: objects.map((object) => ({
      id: object.id,
      name: object.name,
      transform: structuredClone(object.transform),
      visible: object.visible,
      locked: object.locked,
      parentId: object.parentId,
      materials: structuredClone(object.materials),
      modifiers: structuredClone(object.modifiers),
      activeMaterial: object.activeMaterial,
      mesh: serializeMesh(object.mesh),
    })),
  };
}

export function deserializeProject(document: ProjectDocument): {
  name: string;
  cursor: Vec3;
  activeObjectId: string | null;
  objects: SceneObjectSnapshot[];
} {
  return {
    name: document.name,
    cursor: document.cursor ?? vec3(),
    activeObjectId: document.activeObjectId ?? null,
    objects: (document.objects ?? []).map((data) => ({
      id: data.id,
      name: data.name,
      transform: data.transform ?? createTransform(),
      visible: data.visible ?? true,
      locked: data.locked ?? false,
      parentId: data.parentId ?? null,
      materials: data.materials ?? [],
      modifiers: data.modifiers ?? [],
      activeMaterial: data.activeMaterial ?? 0,
      mesh: deserializeMesh(data.mesh),
    })),
  };
}

/**
 * Validates a parsed project file before it reaches the store.
 *
 * Project files are user-supplied data, so a malformed one has to fail with a
 * readable message rather than half-loading and corrupting the scene.
 */
export function parseProject(text: string): ProjectDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Project file is not valid JSON: ${(error as Error).message}`);
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Project file is empty or not an object');
  }

  const candidate = raw as Partial<ProjectDocument>;
  if (candidate.version !== 1) {
    throw new Error(`Unsupported project version: ${String(candidate.version)}`);
  }
  if (!Array.isArray(candidate.objects)) {
    throw new Error('Project file has no objects array');
  }

  for (const object of candidate.objects) {
    if (!object.mesh || !Array.isArray(object.mesh.positions) || !Array.isArray(object.mesh.faces)) {
      throw new Error(`Object "${object.name ?? 'unnamed'}" has no usable mesh data`);
    }
  }

  return candidate as ProjectDocument;
}

export function stringifyProject(document: ProjectDocument): string {
  return JSON.stringify(document, null, 2);
}
