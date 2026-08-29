import type { StateCreator } from 'zustand';

import {
  type BMesh,
  type BooleanOp,
  type Modifier,
  type PrimitiveKind,
  type PrimitiveParams,
  type ProjectDocument,
  type SceneObjectSnapshot,
  type Vec3,
  DEFAULT_PRIMITIVE_PARAMS,
  History,
  PRIMITIVE_DEFAULT_OVERRIDES,
  PRIMITIVE_LABELS,
  SELECTION_OPERATORS,
  add,
  applyModifier,
  booleanMeshStaged,
  centroid,
  cloneMesh,
  composeMatrix,
  createModifier,
  createPrimitive,
  createTransform,
  deserializeProject,
  equals,
  evaluateModifiers,
  execOperator,
  flipNormals,
  splitLooseParts,
  inverseTransformPoint,
  medianPoint,
  normalizePrimitiveParams,
  serializeProject,
  sub,
  transformPoint,
  translateVerts,
  vec3,
} from '@kernel/index';

import { WorkerUnavailable, booleanOffThread, canRunOffThread } from '../booleanOffThread';
import type { EditorStore } from '../useEditorStore';
import type { LastOperator, Material, SceneObject } from '../types';

const BOOLEAN_LABELS: Record<BooleanOp, string> = {
  union: 'Union',
  difference: 'Difference',
  intersect: 'Intersect',
};

/** Undo lives outside React state: only its two flags ever drive a render. */
const history = new History(64);

let objectCounter = 0;
let materialCounter = 0;
let lockAttemptCounter = 0;
let recentVertsCounter = 0;

function nextObjectId(): string {
  objectCounter += 1;
  return `object-${objectCounter}`;
}

function defaultMaterial(): Material {
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
  /**
   * Set whenever an edit is denied because its object is locked. The token
   * bumps on every denial (even repeats on the same object) so a UI can react
   * to the one denial event, rather than to the locked state itself.
   */
  lockedAttempt: { objectId: string; token: number } | null;
  /**
   * Vertices an operator just created, for the viewport to flash briefly. The
   * token bumps on every run so repeating one re-triggers the flash.
   */
  recentVerts: { objectId: string; vertIds: number[]; token: number } | null;

  addPrimitive: (kind: PrimitiveKind, params?: Partial<PrimitiveParams>) => void;
  updatePrimitiveParams: (params: Partial<PrimitiveParams>) => void;
  patchActiveObject: (
    patch: Partial<SceneObject> | ((object: SceneObject) => Partial<SceneObject> | null),
    options?: { touchGeometry?: boolean; status?: string },
  ) => void;
  setActiveObject: (id: string | null, additive?: boolean) => void;
  deselectObject: (id: string) => void;
  selectObjects: (ids: readonly string[], additive?: boolean) => void;
  clearSelection: () => void;
  selectAllObjects: () => void;
  renameObject: (id: string, name: string) => void;
  toggleObjectVisibility: (id: string) => void;
  toggleObjectLock: (id: string) => void;
  noteLockedAttempt: (objectId: string) => void;
  clearRecentVerts: () => void;
  duplicateSelected: (linked?: boolean) => void;
  mergeSelected: () => void;
  /**
   * Cuts the selected objects against the active one, which keeps the result.
   *
   * Asynchronous so the status bar can move while it runs: a cut between two
   * dense meshes takes seconds, and it pauses between stages to let the window
   * repaint. The mesh is not touched until every tool has been applied.
   */
  booleanWithSelected: (op: BooleanOp) => Promise<void>;
  separateLooseParts: () => void;
  /** Deletes the selection, or the objects named — the outliner's row menu names one. */
  deleteSelected: (ids?: readonly string[]) => void;
  /** Bakes the selection's transforms, or those of the objects named. */
  applyTransformToSelected: (ids?: readonly string[]) => void;
  setObjectTransform: (id: string, transform: Partial<SceneObject['transform']>) => void;
  setObjectTransforms: (
    patches: { id: string; transform: Partial<SceneObject['transform']> }[],
  ) => void;
  setCursor: (position: Vec3, status?: string) => void;
  cursorToSelection: () => void;
  selectionToCursor: () => void;

  addMaterial: () => void;
  updateMaterial: (index: number, patch: Partial<Material>) => void;
  /** Drops a slot and rehomes the faces that were wearing it. */
  removeMaterial: (index: number) => void;
  setActiveMaterial: (index: number) => void;
  assignMaterialToSelection: () => void;

  addModifier: (type: Modifier['type']) => void;
  updateModifier: (id: string, patch: Partial<Modifier>) => void;
  removeModifier: (id: string) => void;
  moveModifier: (id: string, direction: -1 | 1) => void;
  applyModifierToMesh: (id: string) => void;

  exec: (name: string, params?: Record<string, unknown>, label?: string) => void;
  recordHistory: (label: string) => void;
  /**
   * Records a document captured earlier rather than the one on screen now.
   *
   * For an edit that stands as a preview before it is committed: the state to
   * undo back to is the one from before the preview, which by then is no longer
   * what `snapshotDocument` would return.
   */
  recordHistoryDocument: (label: string, document: ProjectDocument) => void;
  /** Forgets the last recorded entry, for an operation that was cancelled. */
  discardHistory: () => void;
  undo: () => void;
  redo: () => void;
  touchMesh: () => void;

  /** `restoreLayout` puts the folded panels back too — for a file load, not for undo. */
  loadProjectDocument: (
    document: ReturnType<typeof serializeProject>,
    restoreLayout?: boolean,
  ) => void;
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
  lockedAttempt: null,
  recentVerts: null,

  touchMesh: () => set((state) => ({ meshVersion: state.meshVersion + 1 })),

  snapshotDocument: () => {
    const { projectName, objects, cursor, activeObjectId, collapsedPanels } = get();
    return {
      ...serializeProject(projectName, objects as SceneObjectSnapshot[], cursor, activeObjectId),
      panels: { ...collapsedPanels },
    };
  },

  recordHistory: (label) => get().recordHistoryDocument(label, get().snapshotDocument()),

  recordHistoryDocument: (label, document) => {
    history.record(label, document);
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
      // Placing is what you do next with something you just added, and the
      // gizmo only draws for a transform tool — under the default 'select' a
      // new primitive arrives with nothing to grab. Set here rather than
      // through `setActiveTool`, whose status would bury "Added BOX".
      activeTool: 'move',
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
    const object = activeObject(get());
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
    const object = activeObject(get());
    if (!object?.primitive) return;

    const { kind } = object.primitive;
    const resolved = normalizePrimitiveParams({ ...object.primitive.params, ...params });
    const mesh = createPrimitive(kind, resolved);
    const previous = object.mesh;

    set((state) => ({
      objects: state.objects.map((candidate) => {
        if (candidate.id === object.id) {
          return { ...candidate, mesh, primitive: { kind, params: resolved } };
        }
        // Rebuilding a primitive replaces the instance rather than editing it,
        // so anything linked to the old one is moved across too — otherwise a
        // linked duplicate silently stops following the object it was cut from.
        return candidate.mesh === previous ? { ...candidate, mesh } : candidate;
      }),
      meshVersion: state.meshVersion + 1,
    }));
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

    // Selecting a locked object is allowed, but nothing can be done with it —
    // say so on the click rather than letting the user find out on a failed edit.
    const object = get().objects.find((candidate) => candidate.id === id);
    if (object?.locked) get().noteLockedAttempt(id);
  },

  /**
   * Selects a set of objects at once, for a region drag in object mode.
   *
   * The last one named becomes active, the way the last one clicked would.
   * Additive keeps what was already selected and adds to it, and a drag that
   * caught nothing clears the selection rather than leaving the last one
   * standing — the same as clicking empty space.
   */
  selectObjects: (ids, additive = false) => {
    set((state) => {
      const selected = additive
        ? [...state.selectedObjectIds, ...ids.filter((id) => !state.selectedObjectIds.includes(id))]
        : [...ids];

      return {
        selectedObjectIds: selected,
        activeObjectId: ids[ids.length - 1] ?? (additive ? state.activeObjectId : null),
      };
    });
  },

  /**
   * Drops one object from the selection.
   *
   * `setActiveObject` with `additive` toggles the same way, but leaves what it
   * turned off as the active object, and the outliner would go on drawing a
   * deselected row as the active one. Whatever is left selected takes over
   * instead.
   */
  deselectObject: (id) => {
    set((state) => {
      if (!state.selectedObjectIds.includes(id)) return {};

      const selected = state.selectedObjectIds.filter((candidate) => candidate !== id);
      return {
        selectedObjectIds: selected,
        activeObjectId:
          state.activeObjectId === id
            ? (selected[selected.length - 1] ?? null)
            : state.activeObjectId,
      };
    });
  },

  /**
   * Empties the selection in whichever mode is live, and stands the gizmo down.
   *
   * Falling back to the select tool is what removes the handles: the viewport
   * attaches its gizmo to whatever the active tool asks for, so clearing the
   * selection alone would leave a move or rotate tool armed and the handles
   * back the moment anything was picked again.
   *
   * No history entry, unlike Alt+A: Escape is the way out of a state, and
   * filling undo with the times someone reached for it would bury the edits
   * they actually want back.
   */
  clearSelection: () => {
    const { mode } = get();

    if (mode === 'edit') {
      const object = activeObject(get());
      object?.mesh.deselectAll();
      set((state) => ({ meshVersion: state.meshVersion + 1 }));
    } else {
      set({ selectedObjectIds: [], activeObjectId: null });
    }

    set({ activeTool: 'select', status: 'Deselected all' });
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

  clearRecentVerts: () => set({ recentVerts: null }),

  noteLockedAttempt: (objectId) => {
    lockAttemptCounter += 1;
    set({ status: 'Object is locked', lockedAttempt: { objectId, token: lockAttemptCounter } });
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
      // A copy is made to be put somewhere else, and it lands exactly on top of
      // its original: it arrives selected and already under the move gizmo,
      // rather than invisible until the tool is switched by hand.
      activeTool: 'move',
      meshVersion: state.meshVersion + 1,
      status: `Duplicated ${copies.length} object(s)`,
    }));
  },

  /**
   * Merges the selected objects into the active one, leaving a single object.
   *
   * Geometry travels through world space rather than being copied raw: every
   * source sits somewhere of its own, and dropping its vertices straight into
   * the target's local space would pile them all onto the target's origin.
   * Modifiers on the sources are dropped with them; the target keeps its own.
   */
  mergeSelected: () => {
    const state = get();
    const { objects, selectedObjectIds } = state;
    const target = activeObject(state);
    if (!target) return;
    if (target.locked) {
      get().noteLockedAttempt(target.id);
      return;
    }

    const sources = objects.filter(
      (object) =>
        object.id !== target.id && selectedObjectIds.includes(object.id) && !object.locked,
    );
    if (sources.length === 0) {
      set({ status: 'Select the objects to merge, then the one to merge them into' });
      return;
    }

    get().recordHistory('Merge');

    // Merging into a mesh that an object outside the merge also uses would
    // reshape that object too, so the target takes a copy of its own first.
    const shared = objects.some(
      (object) =>
        object.mesh === target.mesh && object.id !== target.id && !sources.includes(object),
    );
    const merged = shared ? cloneMesh(target.mesh) : target.mesh;
    const materials = [...target.materials];

    for (const source of sources) {
      // Read the source out before anything is added: merging a linked
      // duplicate into its own original walks the very mesh being written to.
      const verts = [...source.mesh.verts.values()];
      const rings = [...source.mesh.faces.values()].map((face) => ({
        vertIds: source.mesh.faceVerts(face).map((vert) => vert.id),
        materialIndex: face.materialIndex,
        smooth: face.smooth,
      }));

      // Slots are merged by identity, so merging a duplicate does not leave two
      // slots pointing at one material.
      const slots = source.materials.map((material) => {
        const existing = materials.findIndex((candidate) => candidate.id === material.id);
        if (existing !== -1) return existing;
        materials.push(structuredClone(material));
        return materials.length - 1;
      });

      const matrix = composeMatrix(source.transform);
      const map = new Map<number, ReturnType<typeof merged.addVert>>();
      for (const vert of verts) {
        const world = transformPoint(matrix, vert.co);
        map.set(vert.id, merged.addVert(inverseTransformPoint(target.transform, world)));
      }

      for (const ring of rings) {
        const face = ring.vertIds.map((id) => map.get(id));
        if (face.every(Boolean)) {
          merged.addFace(face as NonNullable<(typeof face)[number]>[], {
            materialIndex: slots[ring.materialIndex] ?? 0,
            smooth: ring.smooth,
          });
        }
      }
    }

    merged.computeNormals();

    const absorbed = new Set(sources.map((object) => object.id));
    set((state) => ({
      objects: state.objects
        .filter((object) => !absorbed.has(object.id))
        .map((object) =>
          object.id === target.id
            ? // The parameters described the target's own shape, not the merge.
              { ...object, mesh: merged, materials, primitive: null }
            : object,
        ),
      selectedObjectIds: [target.id],
      activeObjectId: target.id,
      meshVersion: state.meshVersion + 1,
      status: `Merged ${sources.length + 1} objects`,
    }));
  },

  booleanWithSelected: async (op) => {
    const state = get();
    if (state.busy) return;
    const { objects, selectedObjectIds } = state;
    const target = activeObject(state);
    if (!target) {
      set({ status: 'Select a cutter and the object to cut it against' });
      return;
    }
    if (target.locked) {
      get().noteLockedAttempt(target.id);
      return;
    }

    const tools = objects.filter(
      (object) =>
        object.id !== target.id && selectedObjectIds.includes(object.id) && !object.locked,
    );
    if (tools.length === 0) {
      set({ status: `Select a cutter as well — ${target.name} is the one that keeps the result` });
      return;
    }

    // A boolean reads the mesh under the stack, not the shape the stack draws:
    // cutting against a sphere with a live REMESH would use the sphere it was
    // built from and hand back a result matching nothing on screen. Refused
    // rather than quietly evaluated, because applying a stack is destructive
    // and is the user's call to make, not this operation's.
    const unapplied = [target, ...tools].filter((object) =>
      object.modifiers.some((modifier) => modifier.enabled),
    );
    if (unapplied.length > 0) {
      const names = unapplied.map((object) => object.name).join(', ');
      get().pushToast(
        'error',
        `Apply the modifiers on ${names} first — a boolean cuts the mesh underneath the stack, not the shape you see.`,
      );
      set({ status: `Apply the modifiers on ${names} before a boolean` });
      return;
    }

    get().recordHistory(BOOLEAN_LABELS[op]);

    // No clone guard as in a merge: each pass builds a new mesh rather than
    // writing into the old one, so an object linked to the target's mesh keeps
    // the shape it had. The target simply stops sharing it.
    const materials = [...target.materials];
    let mesh = target.mesh;

    for (const [index, tool] of tools.entries()) {
      // Slots are merged by identity so a cutter's material does not arrive as
      // a second slot pointing at the one the target already has.
      const slots = tool.materials.map((material) => {
        const existing = materials.findIndex((candidate) => candidate.id === material.id);
        if (existing !== -1) return existing;
        materials.push(structuredClone(material));
        return materials.length - 1;
      });

      const matrix = composeMatrix(tool.transform);
      const inPlace = () =>
        booleanMeshStaged(
          op,
          mesh,
          tool.mesh,
          (point) => inverseTransformPoint(target.transform, transformPoint(matrix, point)),
          (face) => slots[face.materialIndex] ?? 0,
        );

      // Each tool is a slice of the bar, so cutting with three of them runs
      // once from end to end rather than three times from zero.
      const staged = (cut: Generator<number, BMesh> | AsyncGenerator<number, BMesh>) =>
        get().runStaged(
          BOOLEAN_LABELS[op].toUpperCase(),
          (async function* () {
            let step = await cut.next();
            while (!step.done) {
              yield (index + step.value) / tools.length;
              step = await cut.next();
            }
            return step.value;
          })(),
        );

      // A worker where there is one. The cut is the same either way; what the
      // worker buys is a window that keeps drawing, because a dense boolean
      // holds whichever thread runs it for seconds and nothing else on that
      // thread gets a turn. Nothing has been written yet at this point, so a
      // worker that never started can simply be done again here.
      if (!canRunOffThread()) {
        mesh = await staged(inPlace());
      } else {
        try {
          mesh = await staged(
            booleanOffThread(op, mesh, tool.mesh, target.transform, tool.transform, slots),
          );
        } catch (error) {
          if (!(error instanceof WorkerUnavailable)) throw error;
          mesh = await staged(inPlace());
        }
      }
    }

    const consumed = new Set(tools.map((object) => object.id));
    set((state) => ({
      objects: state.objects
        .filter((object) => !consumed.has(object.id))
        .map((object) =>
          object.id === target.id
            ? // The parameters described a primitive shape the result is not.
              { ...object, mesh, materials, primitive: null }
            : object,
        ),
      selectedObjectIds: [target.id],
      activeObjectId: target.id,
      meshVersion: state.meshVersion + 1,
      status:
        mesh.faces.size === 0
          ? `${BOOLEAN_LABELS[op]} left nothing behind`
          : `${BOOLEAN_LABELS[op]} with ${tools.length} object(s)`,
    }));
  },

  /**
   * Breaks the active object's loose parts out into objects of their own.
   *
   * The inverse of a merge, and the reason a merge is not lossy: a part is a
   * shell nothing joins to the rest, so the split is decided by the geometry
   * rather than by the selection. Each part keeps the object's transform,
   * material slots and modifier stack, so nothing moves or re-shades.
   */
  separateLooseParts: () => {
    const state = get();
    const { objects } = state;
    const object = activeObject(state);
    if (!object) return;
    if (object.locked) {
      get().noteLockedAttempt(object.id);
      return;
    }

    // Separating rewrites the mesh this object holds, which every other user of
    // a linked mesh would be dragged along by.
    if (objects.some((other) => other.id !== object.id && other.mesh === object.mesh)) {
      set({ status: 'Linked meshes have to be made single-user first' });
      return;
    }

    const parts = splitLooseParts(object.mesh);
    if (parts.length < 2) {
      set({ status: `${object.name} is one connected piece` });
      return;
    }

    get().recordHistory('Separate');

    const [first, ...rest] = parts;
    const separated = rest.map((mesh, index) => ({
      ...object,
      id: nextObjectId(),
      name: `${object.name}.PART.${index + 2}`,
      mesh,
      transform: structuredClone(object.transform),
      materials: structuredClone(object.materials),
      modifiers: structuredClone(object.modifiers),
      // The parameters described the whole shape, not this piece of it.
      primitive: null,
    }));

    set((state) => ({
      objects: state.objects.flatMap((candidate) =>
        candidate.id === object.id
          ? [
              { ...candidate, mesh: first, name: `${object.name}.PART.1`, primitive: null },
              ...separated,
            ]
          : [candidate],
      ),
      selectedObjectIds: [object.id, ...separated.map((part) => part.id)],
      meshVersion: state.meshVersion + 1,
      status: `Separated ${parts.length} loose parts`,
    }));
  },

  deleteSelected: (ids) => {
    const targetIds = ids ?? get().selectedObjectIds;
    if (targetIds.length === 0) return;
    get().recordHistory('Delete object');

    set((state) => {
      const remaining = state.objects.filter((object) => !targetIds.includes(object.id));
      return {
        objects: remaining,
        // What survived the delete keeps its place in the selection: naming one
        // object from the outliner leaves the rest of a selection alone.
        selectedObjectIds: state.selectedObjectIds.filter((id) => !targetIds.includes(id)),
        activeObjectId: targetIds.includes(state.activeObjectId ?? '')
          ? (remaining[remaining.length - 1]?.id ?? null)
          : state.activeObjectId,
        meshVersion: state.meshVersion + 1,
        status: `Deleted ${targetIds.length} object(s)`,
      };
    });
  },

  /**
   * Bakes rotation and scale into the mesh and resets them to identity.
   *
   * Position is deliberately left alone: the object stays exactly where it
   * sits, and only the numbers behind it change. Everything that reads the raw
   * mesh rather than the world matrix — modifier thickness, bevel width, export
   * — then works on the shape you actually see.
   */
  applyTransformToSelected: (ids) => {
    const { objects, selectedObjectIds } = get();
    const targetIds = ids ?? selectedObjectIds;
    const targets = objects.filter((object) => targetIds.includes(object.id) && !object.locked);
    if (targets.length === 0) return;

    // A linked duplicate shares its mesh instance, so baking one object's
    // rotation and scale into it would drag every other user of that mesh out
    // of shape alongside it.
    const single = targets.filter(
      (object) => objects.filter((other) => other.mesh === object.mesh).length === 1,
    );
    if (single.length === 0) {
      set({ status: 'Linked meshes have to be made single-user first' });
      return;
    }

    get().recordHistory('Apply transform');

    for (const object of single) {
      const { rotation, scale } = object.transform;
      const matrix = composeMatrix({ position: vec3(), rotation, scale });
      for (const vert of object.mesh.verts.values()) vert.co = transformPoint(matrix, vert.co);

      // A negative scale mirrors the mesh. Once it is baked in there is no
      // scale left to flip the winding back, so the faces are turned instead.
      if (scale.x * scale.y * scale.z < 0) {
        flipNormals(object.mesh, [...object.mesh.faces.values()]);
      } else {
        object.mesh.computeNormals();
      }
    }

    const applied = new Set(single.map((object) => object.id));
    set((state) => ({
      objects: state.objects.map((object) =>
        applied.has(object.id)
          ? {
              ...object,
              transform: { ...object.transform, rotation: vec3(), scale: vec3(1, 1, 1) },
              // The primitive parameters described the mesh as it was before
              // the bake; editing them now would regenerate it unrotated.
              primitive: null,
            }
          : object,
      ),
      meshVersion: state.meshVersion + 1,
      status: `Applied rotation and scale to ${single.length} object(s)`,
    }));
  },

  setObjectTransform: (id, transform) => {
    const object = get().objects.find((candidate) => candidate.id === id);
    if (object?.locked) {
      get().noteLockedAttempt(object.id);
      return;
    }

    set((state) => ({
      objects: state.objects.map((candidate) =>
        candidate.id === id
          ? { ...candidate, transform: { ...candidate.transform, ...transform } }
          : candidate,
      ),
      meshVersion: state.meshVersion + 1,
    }));
  },

  /**
   * Same as `setObjectTransform`, but for every dragged object in one `set`
   * call. A multi-object gizmo drag patches every selected object on each
   * pointer-move tick; batching keeps that one store update (and one
   * `syncScene`) instead of N.
   *
   * Locked objects are skipped here too — the gizmo already excludes them
   * from the drag group, but this keeps the guarantee at the one place state
   * actually changes rather than trusting every future caller to filter first.
   */
  setObjectTransforms: (patches) => {
    if (patches.length === 0) return;
    const patchMap = new Map(patches.map((patch) => [patch.id, patch.transform]));

    set((state) => ({
      objects: state.objects.map((object) => {
        const transform = patchMap.get(object.id);
        return transform && !object.locked
          ? { ...object, transform: { ...object.transform, ...transform } }
          : object;
      }),
      meshVersion: state.meshVersion + 1,
    }));
  },

  setCursor: (position, status = 'Cursor placed') => set({ cursor: { ...position }, status }),

  cursorToSelection: () => {
    const anchor = selectionAnchor(get());
    if (!anchor) {
      set({ status: 'Nothing selected' });
      return;
    }
    get().setCursor(anchor, 'Cursor to selection');
  },

  /**
   * Moves the selection so it lands on the cursor, keeping the offsets between
   * objects. Blender stacks every object origin on the cursor by default; here
   * the group moves as a unit and lands on the point the gizmo is showing,
   * which is what the user is actually looking at.
   */
  selectionToCursor: () => {
    const state = get();
    const anchor = selectionAnchor(state);
    if (!anchor) {
      set({ status: 'Nothing selected' });
      return;
    }

    const offset = sub(state.cursor, anchor);
    if (state.mode === 'edit') {
      const object = activeObject(state);
      if (!object || object.locked) return;
      state.recordHistory('Selection to cursor');
      // The gizmo drags in world space but vertices live in object space, so
      // the offset has to come back through the object's own frame.
      const origin = inverseTransformPoint(object.transform, vec3());
      const local = sub(inverseTransformPoint(object.transform, offset), origin);
      translateVerts(object.mesh, object.mesh.selectedVerts(), local);
      set((current) => ({ meshVersion: current.meshVersion + 1, status: 'Selection to cursor' }));
      return;
    }

    const movable = state.objects.filter(
      (object) => state.selectedObjectIds.includes(object.id) && !object.locked,
    );
    if (movable.length === 0) return;

    state.recordHistory('Selection to cursor');
    state.setObjectTransforms(
      movable.map((object) => ({
        id: object.id,
        transform: { position: add(object.transform.position, offset) },
      })),
    );
    set({ status: 'Selection to cursor' });
  },

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

  /**
   * Deletes a material slot.
   *
   * Slots are addressed by position, so removing one renumbers every slot after
   * it. Faces are rewritten to match: the ones past the gap follow the material
   * they were already wearing down a place, and the ones wearing the deleted
   * slot fall back to the first — a face always points at a slot that exists.
   */
  removeMaterial: (index) => {
    const object = activeObject(get());
    const material = object?.materials[index];
    if (!object || !material) return;

    get().recordHistory(`Delete ${material.name}`);

    for (const face of object.mesh.faces.values()) {
      if (face.materialIndex === index) face.materialIndex = 0;
      else if (face.materialIndex > index) face.materialIndex -= 1;
    }

    const materials = object.materials.filter((_, slot) => slot !== index);
    get().patchActiveObject(
      {
        materials,
        activeMaterial: Math.max(0, Math.min(object.activeMaterial, materials.length - 1)),
      },
      { status: `Deleted ${material.name}` },
    );
  },

  setActiveMaterial: (index) => {
    get().patchActiveObject({ activeMaterial: index }, { touchGeometry: false });
  },

  assignMaterialToSelection: () => {
    const object = activeObject(get());
    if (!object) return;

    get().recordHistory('Assign material');
    for (const face of object.mesh.selectedFaces()) face.materialIndex = object.activeMaterial;

    set((state) => ({
      // Per-face assignments are not something the parameters would rebuild, so
      // the shape stops being live rather than losing them to the next tweak.
      objects: state.objects.map((candidate) =>
        candidate.id === object.id ? { ...candidate, primitive: null } : candidate,
      ),
      meshVersion: state.meshVersion + 1,
      status: `Assigned ${object.materials[object.activeMaterial]?.name ?? 'material'}`,
    }));
  },

  addModifier: (type) => {
    if (!activeObject(get())) return;
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
    if (!activeObject(get())) return;
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
    const object = activeObject(get());
    const modifier = object?.modifiers.find((candidate) => candidate.id === id);
    if (!object || !modifier) return;

    get().recordHistory(`Apply ${modifier.name}`);
    get().patchActiveObject(
      {
        mesh: applyModifier(cloneMesh(object.mesh), modifier, {
          cursor: inverseTransformPoint(object.transform, get().cursor),
        }),
        modifiers: object.modifiers.filter((candidate) => candidate.id !== id),
        primitive: null,
      },
      { status: `Applied ${modifier.name}` },
    );
  },

  exec: (name, params = {}, label) => {
    const { selectMode, cursor, proportional } = get();
    const object = activeObject(get());
    if (!object) {
      set({ status: 'No active object' });
      return;
    }
    if (object.locked) {
      get().noteLockedAttempt(object.id);
      return;
    }

    // Nothing about picking more geometry asks for the handles, so they go
    // away here as they do for a click in the viewport.
    if (SELECTION_OPERATORS.has(name)) get().stowTransformTool();

    get().recordHistory(label ?? name);

    try {
      const result = execOperator(
        { mesh: object.mesh, selectMode, cursor, proportional },
        name,
        params,
      );
      // An operator that declined changed nothing, so there is nothing to
      // undo back to and nothing on screen to say what happened.
      if (result.refused) {
        get().discardHistory();
        set({ status: result.status });
        get().pushToast('warning', result.status);
        return;
      }

      // A structural edit invalidates the primitive's live parameters. The
      // object is replaced rather than mutated so the panels see the change.
      set((state) => ({
        objects: state.objects.map((candidate) =>
          candidate.id === object.id ? { ...candidate, primitive: null } : candidate,
        ),
        meshVersion: state.meshVersion + 1,
        status: result.status,
        recentVerts: result.createdVerts?.length
          ? { objectId: object.id, vertIds: result.createdVerts, token: ++recentVertsCounter }
          : null,
        lastOperator: { name, label: label ?? name, params },
      }));
    } catch (error) {
      set({ status: `${name} failed: ${(error as Error).message}` });
      get().pushToast('error', `${name} failed: ${(error as Error).message}`);
    }
  },

  discardHistory: () => {
    history.drop();
    set({ canUndo: history.canUndo, canRedo: history.canRedo });
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

  loadProjectDocument: (document, restoreLayout = false) => {
    const restored = deserializeProject(document);
    // Undo replays the scene, not the shell: a snapshot taken while a panel was
    // folded would otherwise fold it again three operations later.
    if (restoreLayout) get().setCollapsedPanels(document.panels ?? {});
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
      lockedAttempt: null,
      recentVerts: null,
      meshVersion: get().meshVersion + 1,
      // Edit mode with no object is not a reachable state, so a new scene has
      // to drop back to object mode along with the tool that was active.
      mode: 'object',
      activeTool: 'select',
      modal: null,
      dialog: null,
      collapsedPanels: {},
    });
  },
});

/**
 * The object edits land on.
 *
 * Every panel, tool and viewport handler starts from this same lookup, so it is
 * named once here rather than rebuilt at each call site.
 */
export function activeObject(state: {
  objects: readonly SceneObject[];
  activeObjectId: string | null;
}): SceneObject | null {
  return state.objects.find((object) => object.id === state.activeObjectId) ?? null;
}

/**
 * The world-space point the current selection hangs off — the same point the
 * gizmo sits on, so cursor snapping and the handles agree.
 *
 * Null when nothing is selected, which is what the callers report to the user
 * rather than silently snapping to the origin.
 */
function selectionAnchor(state: EditorStore): Vec3 | null {
  const object = activeObject(state);

  if (state.mode === 'edit') {
    const selected = object?.mesh.selectedVerts() ?? [];
    if (!object || selected.length === 0) return null;
    return transformPoint(composeMatrix(object.transform), medianPoint(selected));
  }

  const selected = state.objects.filter((candidate) =>
    state.selectedObjectIds.includes(candidate.id),
  );
  if (selected.length === 0) return null;
  return centroid(
    selected.map((candidate) =>
      displayCenter(candidate, evaluatedMesh(candidate, state.cursor, state.meshVersion)),
    ),
  );
}

interface EvaluatedStack {
  version: number;
  modifiers: readonly Modifier[];
  cursor: Vec3;
  result: BMesh;
}

/** Last stack result per object, so an unchanged stack is not run twice. */
const evaluatedStacks = new Map<string, EvaluatedStack>();

/**
 * Display mesh for an object: its base mesh run through the modifier stack.
 *
 * The 3D cursor arrives in world space and is handed to the kernel in the
 * object's own local frame, which is the only coordinate system a modifier
 * knows about.
 *
 * `version` is the store's `meshVersion`, and passing it turns on the memo.
 * The viewport re-syncs on far more than geometry — selecting an object,
 * entering edit mode, changing the shading — and every one of those was
 * re-running the whole stack for every object in the scene. That was tolerable
 * while the dearest modifier was a subdivision; a REMESH is the better part of
 * a second on its own, and without this a click anywhere would pay for it. The
 * mesh is edited in place, so the version is what says it changed; a caller
 * with no version to offer gets a fresh evaluation.
 */
export function evaluatedMesh(object: SceneObject, cursor: Vec3 = vec3(), version?: number) {
  if (object.modifiers.length === 0) return object.mesh;

  const cached = evaluatedStacks.get(object.id);
  if (
    version !== undefined &&
    cached &&
    cached.version === version &&
    cached.modifiers === object.modifiers &&
    equals(cached.cursor, cursor, 0)
  ) {
    return cached.result;
  }

  const result = evaluateModifiers(object.mesh, object.modifiers, {
    cursor: inverseTransformPoint(object.transform, cursor),
  });

  if (version !== undefined) {
    // Entries for objects that have since been deleted would otherwise sit on
    // a display mesh each for the rest of the session.
    if (evaluatedStacks.size > 64) {
      for (const [id, entry] of evaluatedStacks) {
        if (entry.version !== version) evaluatedStacks.delete(id);
      }
    }
    evaluatedStacks.set(object.id, {
      version,
      modifiers: object.modifiers,
      cursor: { ...cursor },
      result,
    });
  }
  return result;
}

/**
 * World-space centre of what an object actually draws — where its object-mode
 * gizmo sits, so an array modifier carries the handles out to the middle of
 * the array instead of leaving them beside the first copy.
 *
 * Takes the evaluated mesh rather than deriving it, so callers that have
 * already run the modifier stack do not run it twice.
 */
export function displayCenter(object: SceneObject, mesh: BMesh): Vec3 {
  const box = mesh.boundingBox();
  return transformPoint(composeMatrix(object.transform), centroid([box.min, box.max]));
}
