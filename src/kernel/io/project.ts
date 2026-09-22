import { type Transform, type Vec3, createTransform, vec3 } from '../math';
import { type MeshData, BMesh, deserializeMesh, serializeMesh } from '../mesh';
import type { Modifier } from '../modifiers';

import type { Material } from './types';

/**
 * A named folder in the outliner, holding the objects that point at it.
 *
 * Whether it is folded shut is left out deliberately: that is how the panel
 * looks, not what the scene is, and a document is replayed on every undo.
 */
export interface SceneGroupData {
  id: string;
  name: string;
}

export interface SceneObjectData {
  id: string;
  name: string;
  transform: Transform;
  visible: boolean;
  locked: boolean;
  parentId: string | null;
  /** The group this object belongs to, or null when it is loose. */
  groupId?: string | null;
  materials: Material[];
  modifiers: Modifier[];
  activeMaterial: number;
  mesh: MeshData;
  /**
   * Id of the object this one shares its mesh instance with.
   *
   * A linked duplicate is one mesh behind several objects, and a document is a
   * flat list: without this the link is lost on every save, and on every undo,
   * which snapshots through the same format, leaving the copies quietly
   * independent. Each sharer still writes its own `mesh`, so a document whose
   * owner has been dropped, or a reader that predates the field, still loads
   * something valid.
   */
  meshLink?: string;
}

export interface ProjectDocument {
  version: 1;
  name: string;
  savedAt: string;
  cursor: Vec3;
  activeObjectId: string | null;
  objects: SceneObjectData[];
  /**
   * The outliner's folders. Absent in files written before grouping, which
   * load with every object loose.
   */
  groups?: SceneGroupData[];
  /**
   * Which panels were folded away, keyed by title.
   *
   * Layout rather than scene, so it is filled in and read back by the store,
   * `serializeProject` has no business knowing about the shell. Absent in files
   * written before panels could fold, which load with everything open.
   */
  panels?: Record<string, boolean>;
}

export interface SceneObjectSnapshot {
  id: string;
  name: string;
  transform: Transform;
  visible: boolean;
  locked: boolean;
  parentId: string | null;
  groupId: string | null;
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
  groups: readonly SceneGroupData[] = [],
): ProjectDocument {
  const owners = new Map<BMesh, string>();

  return {
    version: 1,
    name,
    savedAt: new Date().toISOString(),
    cursor: { ...cursor },
    activeObjectId,
    groups: groups.map((group) => ({ id: group.id, name: group.name })),
    objects: objects.map((object) => {
      const owner = owners.get(object.mesh);
      if (owner === undefined) owners.set(object.mesh, object.id);

      return {
        id: object.id,
        name: object.name,
        transform: structuredClone(object.transform),
        visible: object.visible,
        locked: object.locked,
        parentId: object.parentId,
        groupId: object.groupId,
        materials: structuredClone(object.materials),
        modifiers: structuredClone(object.modifiers),
        activeMaterial: object.activeMaterial,
        mesh: serializeMesh(object.mesh),
        ...(owner === undefined ? {} : { meshLink: owner }),
      };
    }),
  };
}

export function deserializeProject(document: ProjectDocument): {
  name: string;
  cursor: Vec3;
  activeObjectId: string | null;
  objects: SceneObjectSnapshot[];
  groups: SceneGroupData[];
} {
  const meshes = new Map<string, BMesh>();
  const groups = (document.groups ?? []).map((group) => ({ id: group.id, name: group.name }));
  const known = new Set(groups.map((group) => group.id));

  return {
    name: document.name,
    cursor: document.cursor ?? vec3(),
    activeObjectId: document.activeObjectId ?? null,
    groups,
    objects: (document.objects ?? []).map((data) => {
      // A link to an object that is missing, or that has not been read yet,
      // falls back to this object's own copy rather than failing the load.
      const shared = data.meshLink === undefined ? undefined : meshes.get(data.meshLink);
      const mesh = shared ?? deserializeMesh(data.mesh);
      meshes.set(data.id, mesh);

      return {
        id: data.id,
        name: data.name,
        transform: data.transform ?? createTransform(),
        visible: data.visible ?? true,
        locked: data.locked ?? false,
        parentId: data.parentId ?? null,
        // A membership whose folder went missing reads as loose, rather than
        // hiding the object behind a folder the outliner cannot draw.
        groupId: data.groupId && known.has(data.groupId) ? data.groupId : null,
        materials: data.materials ?? [],
        modifiers: data.modifiers ?? [],
        activeMaterial: data.activeMaterial ?? 0,
        mesh,
      };
    }),
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
    if (
      !object.mesh ||
      !Array.isArray(object.mesh.positions) ||
      !Array.isArray(object.mesh.faces)
    ) {
      throw new Error(`Object "${object.name ?? 'unnamed'}" has no usable mesh data`);
    }
  }

  return candidate as ProjectDocument;
}

export function stringifyProject(document: ProjectDocument): string {
  return JSON.stringify(document, null, 2);
}
