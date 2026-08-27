import type { StateCreator } from 'zustand';

import {
  type BMesh,
  type ProjectDocument,
  type RemeshMethod,
  type RemeshSettings,
  DEFAULT_REMESH_SETTINGS,
  REMESH_PRESETS,
  faceKinds,
  normalizeRemeshSettings,
  remeshMesh,
} from '@kernel/index';

import type { EditorStore } from '../useEditorStore';
import type { SceneObject } from '../types';

export interface RemeshCounts {
  verts: number;
  edges: number;
  faces: number;
  tris: number;
  quads: number;
  ngons: number;
}

export interface RemeshReport {
  objectId: string;
  objectName: string;
  method: RemeshMethod;
  before: RemeshCounts;
  after: RemeshCounts;
  /** Zero for the decimator, which has no grid. */
  voxelSize: number;
  resolution: { x: number; y: number; z: number };
  elapsedMs: number;
  warnings: string[];
}

/**
 * A result standing in for the mesh it was built from.
 *
 * The viewport draws whatever the object holds, so previewing is a matter of
 * putting the result there and keeping the original to hand — which is also why
 * the undo entry has to be a document captured before the swap rather than the
 * one on screen.
 */
export interface RemeshPreview {
  objectId: string;
  source: BMesh;
  primitive: SceneObject['primitive'];
  document: ProjectDocument;
}

export interface RemeshSlice {
  remesh: RemeshSettings;
  remeshPreview: RemeshPreview | null;
  remeshReport: RemeshReport | null;
  /** True while a solve has the main thread; the panel goes quiet and says so. */
  remeshBusy: boolean;

  setRemeshSettings: (patch: Partial<RemeshSettings>) => void;
  applyRemeshPreset: (id: string) => void;
  /** Rebuilds the active object's topology and shows the result, uncommitted. */
  runRemesh: () => void;
  commitRemesh: () => void;
  revertRemesh: () => void;
}

export function meshCounts(mesh: BMesh): RemeshCounts {
  const stats = mesh.stats();
  const kinds = faceKinds(mesh);
  return {
    verts: stats.verts,
    edges: stats.edges,
    faces: stats.faces,
    tris: stats.tris,
    quads: kinds.quads,
    ngons: kinds.ngons,
  };
}

export const createRemeshSlice: StateCreator<
  EditorStore,
  [['zustand/subscribeWithSelector', never]],
  [],
  RemeshSlice
> = (set, get) => {
  /**
   * The solve itself, deferred one macrotask by `runRemesh`.
   *
   * Everything it needs is read again here rather than captured: the tick it
   * waits for is a tick in which the user could have deleted the object.
   */
  const solve = (objectId: string, source: BMesh, primitive: SceneObject['primitive']) => {
    const state = get();
    const object = state.objects.find((candidate) => candidate.id === objectId);
    if (!object) {
      set({ remeshBusy: false });
      return;
    }

    // Captured before the swap, so undo lands on the mesh as it was.
    const document =
      state.remeshPreview?.objectId === objectId
        ? state.remeshPreview.document
        : state.snapshotDocument();

    const started = performance.now();
    try {
      const result = remeshMesh(source, state.remesh);
      const elapsedMs = performance.now() - started;
      const after = meshCounts(result.mesh);

      set((current) => ({
        objects: current.objects.map((candidate) =>
          candidate.id === objectId
            ? // The parameters described the primitive this no longer is.
              { ...candidate, mesh: result.mesh, primitive: null }
            : candidate,
        ),
        remeshPreview: { objectId, source, primitive, document },
        remeshReport: {
          objectId,
          objectName: object.name,
          method: current.remesh.method,
          before: meshCounts(source),
          after,
          voxelSize: result.voxelSize,
          resolution: result.resolution,
          elapsedMs,
          warnings: result.warnings,
        },
        remeshBusy: false,
        meshVersion: current.meshVersion + 1,
        status: `Remeshed ${object.name} to ${after.faces.toLocaleString()} faces — APPLY to keep it`,
      }));

      for (const warning of result.warnings) get().pushToast('warning', warning);
    } catch (error) {
      const message = (error as Error).message;
      set({ remeshBusy: false, status: `Remesh failed: ${message}` });
      get().pushToast('error', `Remesh failed: ${message}`);
    }
  };

  return {
    remesh: { ...DEFAULT_REMESH_SETTINGS },
    remeshPreview: null,
    remeshReport: null,
    remeshBusy: false,

    setRemeshSettings: (patch) =>
      set((state) => ({ remesh: normalizeRemeshSettings({ ...state.remesh, ...patch }) })),

    applyRemeshPreset: (id) => {
      const preset = REMESH_PRESETS.find((candidate) => candidate.id === id);
      if (!preset) return;
      set((state) => ({
        remesh: normalizeRemeshSettings({ ...state.remesh, ...preset.settings }),
        status: `${preset.label} preset`,
      }));
    },

    runRemesh: () => {
      const state = get();
      if (state.remeshBusy) return;

      const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
      if (!object) {
        set({ status: 'Select an object to remesh' });
        return;
      }
      if (object.locked) {
        get().noteLockedAttempt(object.id);
        return;
      }

      // A second run reads the mesh the first one replaced, not its own output:
      // remeshing a remesh compounds the error rather than changing the setting.
      const live = state.remeshPreview?.objectId === object.id ? state.remeshPreview : null;
      const source = live?.source ?? object.mesh;
      const primitive = live ? live.primitive : object.primitive;

      if (source.faces.size === 0) {
        set({ status: `${object.name} has no faces to rebuild` });
        return;
      }
      // Rebuilding topology rewrites the mesh instance, which every other user
      // of a linked mesh would be dragged along by.
      if (state.objects.some((other) => other.id !== object.id && other.mesh === source)) {
        set({ status: 'Linked meshes have to be made single-user first' });
        get().pushToast('warning', 'Linked meshes have to be made single-user first');
        return;
      }

      set({ remeshBusy: true, status: `Remeshing ${object.name}…` });
      // One macrotask of daylight, so the panel paints its busy state before
      // the solve takes the main thread for a second or two.
      window.setTimeout(() => solve(object.id, source, primitive), 0);
    },

    commitRemesh: () => {
      const { remeshPreview, objects } = get();
      if (!remeshPreview) return;

      const object = objects.find((candidate) => candidate.id === remeshPreview.objectId);
      if (!object) {
        set({ remeshPreview: null });
        return;
      }

      get().recordHistoryDocument('Remesh', remeshPreview.document);
      set({ remeshPreview: null, status: `Applied remesh to ${object.name}` });
    },

    revertRemesh: () => {
      const { remeshPreview } = get();
      if (!remeshPreview) return;

      set((state) => ({
        objects: state.objects.map((candidate) =>
          candidate.id === remeshPreview.objectId
            ? { ...candidate, mesh: remeshPreview.source, primitive: remeshPreview.primitive }
            : candidate,
        ),
        remeshPreview: null,
        remeshReport: null,
        meshVersion: state.meshVersion + 1,
        status: 'Reverted remesh',
      }));
    },
  };
};
