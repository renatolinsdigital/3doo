import type { StateCreator } from 'zustand';

import {
  type Modifier,
  type PrimitiveKind,
  type PrimitiveParams,
  type SceneObjectSnapshot,
  type Vec3,
  DEFAULT_PRIMITIVE_PARAMS,
  History,
  PRIMITIVE_DEFAULT_OVERRIDES,
  PRIMITIVE_LABELS,
  applyModifier,
  cloneMesh,
  createModifier,
  createPrimitive,
  createTransform,
  deserializeProject,
  evaluateModifiers,
  execOperator,
  normalizePrimitiveParams,
  serializeProject,
  vec3,
} from '@kernel/index';

import type { EditorStore } from '../useEditorStore';
import type { LastOperator, Material, SceneObject } from '../types';

/** Undo lives outside React state: only its two flags ever drive a render. */
const history = new History(64);

let objectCounter = 0;
let materialCounter = 0;

function nextObjectId(): string {
  objectCounter += 1;
  return `object-${objectCounter}`;
}

export function defaultMaterial(): Material {
  materialCounter += 1;
  return {
    id: `material-${materialCounter}`,
    name: `Material ${materialCounter}`,
    color: { r: 0.85, g: 0.84, b: 0.8 },
  };
}

export interface SceneSlice {
  objects: SceneObject[];
  activeObjectId: string | null;
  selectedObjectIds: string[];
  cursor: Vec3;
  projectName: string;
  /** Bumped on every geometry change so the viewport and panels can react. */
  meshVersion: number;
  canUndo: boolean;
  canRedo: boolean;
  status: string;
  lastOperator: LastOperator | null;

  addPrimitive: (kind: PrimitiveKind, params?: Partial<PrimitiveParams>) => void;
  updatePrimitiveParams: (params: Partial<PrimitiveParams>) => void;
  patchActiveObject: (
    patch:
      | Partial<SceneObject>
      | ((object: SceneObject) => Partial<SceneObject> | null),
    options?: { touchGeometry?: boolean; status?: string },
  ) => void;
  setActiveObject: (id: string | null, additive?: boolean) => void;
  selectAllObjects: () => void;
  renameObject: (id: string, name: string) => void;
  toggleObjectVisibility: (id: string) => void;
  toggleObjectLock: (id: string) => void;
  duplicateSelected: (linked?: boolean) => void;
  deleteSelected: () => void;
  joinSelected: () => void;
  setObjectTransform: (id: string, transform: Partial<SceneObject['transform']>) => void;
  setObjectTransforms: (
    patches: { id: string; transform: Partial<SceneObject['transform']> }[],
  ) => void;
  setCursor: (position: Vec3) => void;

  addMaterial: () => void;
  updateMaterial: (index: number, patch: Partial<Material>) => void;
  setActiveMaterial: (index: number) => void;
  assignMaterialToSelection: () => void;

  addModifier: (type: Modifier['type']) => void;
  updateModifier: (id: string, patch: Partial<Modifier>) => void;
  removeModifier: (id: string) => void;
  moveModifier: (id: string, direction: -1 | 1) => void;
  applyModifierToMesh: (id: string) => void;

  exec: (name: string, params?: Record<string, unknown>, label?: string) => void;
  recordHistory: (label: string) => void;
  undo: () => void;
  redo: () => void;
  touchMesh: () => void;

  loadProjectDocument: (document: ReturnType<typeof serializeProject>) => void;
  snapshotDocument: () => ReturnType<typeof serializeProject>;
  setProjectName: (name: string) => void;
  resetScene: () => void;
}

export const createSceneSlice: StateCreator<
  EditorStore,
  [['zustand/subscribeWithSelector', never]],
  [],
  SceneSlice
> = (set, get) => ({
  objects: [],
  activeObjectId: null,
  selectedObjectIds: [],
  cursor: vec3(),
  projectName: 'untitled',
  meshVersion: 0,
  canUndo: false,
  canRedo: false,
  status: 'Ready',
  lastOperator: null,

  touchMesh: () => set((state) => ({ meshVersion: state.meshVersion + 1 })),

  snapshotDocument: () => {
    const { projectName, objects, cursor, activeObjectId } = get();
    return serializeProject(projectName, objects as SceneObjectSnapshot[], cursor, activeObjectId);
  },

  recordHistory: (label) => {
    history.record(label, get().snapshotDocument());
    set({ canUndo: history.canUndo, canRedo: history.canRedo });
  },

  addPrimitive: (kind, params) => {
    get().recordHistory(`Add ${PRIMITIVE_LABELS[kind]}`);

    const resolved = normalizePrimitiveParams({
      ...DEFAULT_PRIMITIVE_PARAMS,
      ...PRIMITIVE_DEFAULT_OVERRIDES[kind],
      ...params,
    });
    const mesh = createPrimitive(kind, resolved);
    const transform = createTransform();
    transform.position = { ...get().cursor };

    const object: SceneObject = {
      id: nextObjectId(),
      name: PRIMITIVE_LABELS[kind],
      mesh,
      transform,
      visible: true,
      locked: false,
      parentId: null,
      materials: [defaultMaterial()],
      modifiers: [],
      activeMaterial: 0,
      primitive: { kind, params: resolved },
    };

    set((state) => ({
      objects: [...state.objects, object],
      activeObjectId: object.id,
      selectedObjectIds: [object.id],
      meshVersion: state.meshVersion + 1,
      status: `Added ${PRIMITIVE_LABELS[kind]}`,
    }));
  },

  /**
   * Replaces the active object with a patched copy.
   *
   * Every field other than `mesh` has to be swapped by reference rather than
   * mutated: panels select the object itself, so an in-place edit leaves the
   * selector returning an identical reference and nothing re-renders. Geometry
   * is the exception — it is mutated in place and tracked by `meshVersion`.
   */
  patchActiveObject: (patch, options = {}) => {
    const { objects, activeObjectId } = get();
    const object = objects.find((candidate) => candidate.id === activeObjectId);
    if (!object) return;

    const changes = typeof patch === 'function' ? patch(object) : patch;
    if (!changes) return;

    set((state) => ({
      objects: state.objects.map((candidate) =>
        candidate.id === object.id ? { ...candidate, ...changes } : candidate,
      ),
      meshVersion: options.touchGeometry === false ? state.meshVersion : state.meshVersion + 1,
      ...(options.status ? { status: options.status } : {}),
    }));
  },

  /** Live primitive parameters stay editable until the next operation commits. */
  updatePrimitiveParams: (params) => {
    const object = get().objects.find((candidate) => candidate.id === get().activeObjectId);
    if (!object?.primitive) return;

    const resolved = normalizePrimitiveParams({ ...object.primitive.params, ...params });
    get().patchActiveObject({
      mesh: createPrimitive(object.primitive.kind, resolved),
      primitive: { kind: object.primitive.kind, params: resolved },
    });
  },

  setActiveObject: (id, additive = false) => {
    if (id === null) {
      set({ activeObjectId: null, selectedObjectIds: [] });
      return;
    }

    set((state) => {
      const selected = additive
        ? state.selectedObjectIds.includes(id)
          ? state.selectedObjectIds.filter((candidate) => candidate !== id)
          : [...state.selectedObjectIds, id]
        : [id];
      return { activeObjectId: id, selectedObjectIds: selected };
    });
  },

  /** The object-mode equivalent of "select all" in edit mode. */
  selectAllObjects: () => {
    set((state) => ({
      selectedObjectIds: state.objects.map((object) => object.id),
      activeObjectId: state.activeObjectId ?? state.objects[state.objects.length - 1]?.id ?? null,
      status: `Selected all ${state.objects.length} object(s)`,
    }));
  },

  renameObject: (id, name) => {
    set((state) => ({
      objects: state.objects.map((object) => (object.id === id ? { ...object, name } : object)),
    }));
  },

  toggleObjectVisibility: (id) => {
    set((state) => ({
      objects: state.objects.map((object) =>
        object.id === id ? { ...object, visible: !object.visible } : object,
      ),
      meshVersion: state.meshVersion + 1,
    }));
  },

  toggleObjectLock: (id) => {
    set((state) => ({
      objects: state.objects.map((object) =>
        object.id === id ? { ...object, locked: !object.locked } : object,
      ),
    }));
  },

  duplicateSelected: (linked = false) => {
    const { objects, selectedObjectIds } = get();
    if (selectedObjectIds.length === 0) return;
    get().recordHistory(linked ? 'Linked duplicate' : 'Duplicate');

    const copies: SceneObject[] = [];
    for (const object of objects) {
      if (!selectedObjectIds.includes(object.id)) continue;
      copies.push({
        ...object,
        id: nextObjectId(),
        name: `${object.name}.COPY`,
        // A linked duplicate shares the mesh instance; a full copy clones it.
        mesh: linked ? object.mesh : cloneMesh(object.mesh),
        transform: structuredClone(object.transform),
        materials: structuredClone(object.materials),
        modifiers: structuredClone(object.modifiers),
        primitive: null,
      });
    }

    set((state) => ({
      objects: [...state.objects, ...copies],
      selectedObjectIds: copies.map((object) => object.id),
      activeObjectId: copies[copies.length - 1]?.id ?? state.activeObjectId,
      meshVersion: state.meshVersion + 1,
      status: `Duplicated ${copies.length} object(s)`,
    }));
  },

  deleteSelected: () => {
    const { selectedObjectIds } = get();
    if (selectedObjectIds.length === 0) return;
    get().recordHistory('Delete object');

    set((state) => {
      const remaining = state.objects.filter(
        (object) => !selectedObjectIds.includes(object.id),
      );
      return {
        objects: remaining,
        selectedObjectIds: [],
        activeObjectId: remaining[remaining.length - 1]?.id ?? null,
        meshVersion: state.meshVersion + 1,
        status: `Deleted ${selectedObjectIds.length} object(s)`,
      };
    });
  },

  joinSelected: () => {
    const { objects, selectedObjectIds, activeObjectId } = get();
    if (selectedObjectIds.length < 2) return;
    get().recordHistory('Join');

    const target = objects.find((object) => object.id === activeObjectId);
    if (!target) return;

    for (const object of objects) {
      if (object.id === target.id || !selectedObjectIds.includes(object.id)) continue;
      const merged = cloneMesh(object.mesh);
      const map = new Map<number, ReturnType<typeof target.mesh.addVert>>();
      for (const vert of merged.verts.values()) map.set(vert.id, target.mesh.addVert(vert.co));
      for (const face of merged.faces.values()) {
        const ring = merged.faceVerts(face).map((vert) => map.get(vert.id));
        if (ring.every(Boolean)) {
          target.mesh.addFace(ring as NonNullable<(typeof ring)[number]>[], {
            materialIndex: face.materialIndex,
            smooth: face.smooth,
          });
        }
      }
    }
    target.mesh.computeNormals();

    set((state) => ({
      objects: state.objects.filter(
        (object) => object.id === target.id || !selectedObjectIds.includes(object.id),
      ),
      selectedObjectIds: [target.id],
      meshVersion: state.meshVersion + 1,
      status: `Joined ${selectedObjectIds.length} objects`,
    }));
  },

  setObjectTransform: (id, transform) => {
    set((state) => ({
      objects: state.objects.map((object) =>
        object.id === id ? { ...object, transform: { ...object.transform, ...transform } } : object,
      ),
      meshVersion: state.meshVersion + 1,
    }));
  },

  /**
   * Same as `setObjectTransform`, but for every dragged object in one `set`
   * call. A multi-object gizmo drag patches every selected object on each
   * pointer-move tick; batching keeps that one store update (and one
   * `syncScene`) instead of N.
   */
  setObjectTransforms: (patches) => {
    if (patches.length === 0) return;
    const patchMap = new Map(patches.map((patch) => [patch.id, patch.transform]));

    set((state) => ({
      objects: state.objects.map((object) => {
        const transform = patchMap.get(object.id);
        return transform ? { ...object, transform: { ...object.transform, ...transform } } : object;
      }),
      meshVersion: state.meshVersion + 1,
    }));
  },

  setCursor: (position) => set({ cursor: { ...position } }),

  addMaterial: () => {
    get().patchActiveObject(
      (object) => {
        const materials = [...object.materials, defaultMaterial()];
        return { materials, activeMaterial: materials.length - 1 };
      },
      { touchGeometry: false },
    );
  },

  updateMaterial: (index, patch) => {
    get().patchActiveObject((object) =>
      object.materials[index]
        ? {
            materials: object.materials.map((material, i) =>
              i === index ? { ...material, ...patch } : material,
            ),
          }
        : null,
    );
  },

  setActiveMaterial: (index) => {
    get().patchActiveObject({ activeMaterial: index }, { touchGeometry: false });
  },

  assignMaterialToSelection: () => {
    const { objects, activeObjectId } = get();
    const object = objects.find((candidate) => candidate.id === activeObjectId);
    if (!object) return;

    get().recordHistory('Assign material');
    for (const face of object.mesh.selectedFaces()) face.materialIndex = object.activeMaterial;

    set((state) => ({
      meshVersion: state.meshVersion + 1,
      status: `Assigned ${object.materials[object.activeMaterial]?.name ?? 'material'}`,
    }));
  },

  addModifier: (type) => {
    if (!get().objects.some((object) => object.id === get().activeObjectId)) return;
    get().recordHistory('Add modifier');
    get().patchActiveObject((object) => ({
      modifiers: [...object.modifiers, createModifier(type)],
    }));
  },

  updateModifier: (id, patch) => {
    get().patchActiveObject((object) => ({
      modifiers: object.modifiers.map((modifier) =>
        modifier.id === id ? ({ ...modifier, ...patch } as Modifier) : modifier,
      ),
    }));
  },

  removeModifier: (id) => {
    if (!get().objects.some((object) => object.id === get().activeObjectId)) return;
    get().recordHistory('Remove modifier');
    get().patchActiveObject((object) => ({
      modifiers: object.modifiers.filter((modifier) => modifier.id !== id),
    }));
  },

  moveModifier: (id, direction) => {
    get().patchActiveObject((object) => {
      const index = object.modifiers.findIndex((modifier) => modifier.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= object.modifiers.length) return null;

      const reordered = [...object.modifiers];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(target, 0, moved);
      return { modifiers: reordered };
    });
  },

  applyModifierToMesh: (id) => {
    const object = get().objects.find((candidate) => candidate.id === get().activeObjectId);
    const modifier = object?.modifiers.find((candidate) => candidate.id === id);
    if (!object || !modifier) return;

    get().recordHistory(`Apply ${modifier.name}`);
    get().patchActiveObject(
      {
        mesh: applyModifier(cloneMesh(object.mesh), modifier),
        modifiers: object.modifiers.filter((candidate) => candidate.id !== id),
        primitive: null,
      },
      { status: `Applied ${modifier.name}` },
    );
  },

  exec: (name, params = {}, label) => {
    const { objects, activeObjectId, selectMode, cursor, proportional } = get();
    const object = objects.find((candidate) => candidate.id === activeObjectId);
    if (!object) {
      set({ status: 'No active object' });
      return;
    }
    if (object.locked) {
      set({ status: `${object.name} is locked` });
      return;
    }

    get().recordHistory(label ?? name);

    try {
      const result = execOperator(
        { mesh: object.mesh, selectMode, cursor, proportional },
        name,
        params,
      );
      // A structural edit invalidates the primitive's live parameters. The
      // object is replaced rather than mutated so the panels see the change.
      set((state) => ({
        objects: state.objects.map((candidate) =>
          candidate.id === object.id ? { ...candidate, primitive: null } : candidate,
        ),
        meshVersion: state.meshVersion + 1,
        status: result.status,
        lastOperator: { name, label: label ?? name, params },
      }));
    } catch (error) {
      set({ status: `${name} failed: ${(error as Error).message}` });
      get().pushToast('error', `${name} failed: ${(error as Error).message}`);
    }
  },

  undo: () => {
    const entry = history.undo(get().snapshotDocument());
    if (!entry) {
      set({ status: 'Nothing to undo' });
      return;
    }
    get().loadProjectDocument(entry.document);
    set({
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      status: `Undo: ${entry.label}`,
    });
  },

  redo: () => {
    const entry = history.redo(get().snapshotDocument());
    if (!entry) {
      set({ status: 'Nothing to redo' });
      return;
    }
    get().loadProjectDocument(entry.document);
    set({
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      status: `Redo: ${entry.label}`,
    });
  },

  loadProjectDocument: (document) => {
    const restored = deserializeProject(document);
    const objects: SceneObject[] = restored.objects.map((object) => ({
      ...object,
      primitive: null,
    }));

    set((state) => ({
      objects,
      projectName: restored.name,
      cursor: restored.cursor,
      activeObjectId: restored.activeObjectId,
      selectedObjectIds: restored.activeObjectId ? [restored.activeObjectId] : [],
      meshVersion: state.meshVersion + 1,
    }));
  },

  setProjectName: (name) => set({ projectName: name }),

  resetScene: () => {
    history.clear();
    set({
      objects: [],
      activeObjectId: null,
      selectedObjectIds: [],
      cursor: vec3(),
      projectName: 'untitled',
      canUndo: false,
      canRedo: false,
      status: 'New project',
      lastOperator: null,
      meshVersion: get().meshVersion + 1,
      // Edit mode with no object is not a reachable state, so a new scene has
      // to drop back to object mode along with the tool that was active.
      mode: 'object',
      activeTool: 'select',
      modal: null,
      dialog: null,
    });
  },
});

/** Display mesh for an object: its base mesh run through the modifier stack. */
export function evaluatedMesh(object: SceneObject) {
  return object.modifiers.length > 0
    ? evaluateModifiers(object.mesh, object.modifiers)
    : object.mesh;
}
