import type { StateCreator } from 'zustand';

import type { SelectMode } from '@kernel/index';

import type { EditorStore } from '../useEditorStore';
import type {
  EditorMode,
  ModalTransform,
  PivotMode,
  ProportionalSettings,
  SnapSettings,
  ToolId,
} from '../types';

export interface ToolSlice {
  mode: EditorMode;
  selectMode: SelectMode;
  activeTool: ToolId;
  pivot: PivotMode;
  snap: SnapSettings;
  proportional: ProportionalSettings;
  modal: ModalTransform | null;

  setMode: (mode: EditorMode) => void;
  toggleMode: () => void;
  setSelectMode: (mode: SelectMode) => void;
  setActiveTool: (tool: ToolId) => void;
  setPivot: (pivot: PivotMode) => void;
  setSnap: (patch: Partial<SnapSettings>) => void;
  setProportional: (patch: Partial<ProportionalSettings>) => void;
  beginModal: (kind: ModalTransform['kind']) => void;
  updateModal: (patch: Partial<ModalTransform>) => void;
  endModal: () => void;
}

export const createToolSlice: StateCreator<
  EditorStore,
  [['zustand/subscribeWithSelector', never]],
  [],
  ToolSlice
> = (set, get) => ({
  mode: 'object',
  selectMode: 'vertex',
  activeTool: 'select',
  pivot: 'median',
  snap: { enabled: false, mode: 'increment', increment: 0.25 },
  proportional: { enabled: false, radius: 1.5, falloff: 'smooth' },
  modal: null,

  setMode: (mode) => {
    const { objects, activeObjectId } = get();
    const object = objects.find((candidate) => candidate.id === activeObjectId);
    if (mode === 'edit' && !object) {
      set({ status: 'Select an object before entering edit mode' });
      return;
    }
    set({ mode, modal: null, status: mode === 'edit' ? 'Edit mode' : 'Object mode' });
  },

  toggleMode: () => get().setMode(get().mode === 'object' ? 'edit' : 'object'),

  setSelectMode: (selectMode) => {
    const { objects, activeObjectId } = get();
    const object = objects.find((candidate) => candidate.id === activeObjectId);
    // Carry the current selection across so switching modes never loses it.
    if (object) object.mesh.flushSelection(selectMode);
    set((state) => ({ selectMode, meshVersion: state.meshVersion + 1 }));
  },

  setActiveTool: (activeTool) => set({ activeTool, status: activeTool.toUpperCase() }),

  setPivot: (pivot) => set({ pivot }),

  setSnap: (patch) => set((state) => ({ snap: { ...state.snap, ...patch } })),

  setProportional: (patch) =>
    set((state) => ({ proportional: { ...state.proportional, ...patch } })),

  beginModal: (kind) => {
    set({
      modal: { kind, axis: null, excludeAxis: false, typed: '', value: { x: 0, y: 0, z: 0 } },
      status: `${kind.toUpperCase()}: move mouse, X/Y/Z to constrain, type a value, Enter to confirm`,
    });
  },

  updateModal: (patch) =>
    set((state) => (state.modal ? { modal: { ...state.modal, ...patch } } : {})),

  endModal: () => set({ modal: null }),
});
