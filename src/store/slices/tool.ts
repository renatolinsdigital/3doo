import type { StateCreator } from 'zustand';

import type { SelectMode } from '@kernel/index';

import type { EditorStore } from '../useEditorStore';
import { activeObject } from './scene';
import type {
  EditorMode,
  ModalTransform,
  PivotMode,
  ProportionalSettings,
  SelectShape,
  SnapSettings,
  ToolId,
} from '../types';

/** The order V steps through, and the order the select tool's menu lists. */
export const SELECT_SHAPES: readonly SelectShape[] = ['box', 'circle', 'lasso'];

export interface ToolSlice {
  mode: EditorMode;
  selectMode: SelectMode;
  activeTool: ToolId;
  selectShape: SelectShape;
  pivot: PivotMode;
  snap: SnapSettings;
  proportional: ProportionalSettings;
  modal: ModalTransform | null;

  setMode: (mode: EditorMode) => void;
  toggleMode: () => void;
  setSelectMode: (mode: SelectMode) => void;
  setActiveTool: (tool: ToolId) => void;
  setSelectShape: (shape: SelectShape) => void;
  cycleSelectShape: () => void;
  setPivot: (pivot: PivotMode) => void;
  stowTransformTool: () => void;
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
  selectShape: 'box',
  pivot: 'median',
  snap: { enabled: false, mode: 'increment', increment: 0.25 },
  proportional: { enabled: false, radius: 1.5, falloff: 'smooth' },
  modal: null,

  setMode: (mode) => {
    const object = activeObject(get());
    if (mode === 'edit' && !object) {
      set({ status: 'Select an object before entering edit mode' });
      return;
    }
    set({ mode, modal: null, status: mode === 'edit' ? 'Edit mode' : 'Object mode' });
  },

  toggleMode: () => get().setMode(get().mode === 'object' ? 'edit' : 'object'),

  setSelectMode: (selectMode) => {
    const object = activeObject(get());
    // Carry the current selection across so switching modes never loses it.
    if (object) object.mesh.flushSelection(selectMode);
    set((state) => ({ selectMode, meshVersion: state.meshVersion + 1 }));
  },

  setActiveTool: (activeTool) => set({ activeTool, status: activeTool.toUpperCase() }),

  /**
   * Puts the handles away, leaving a fresh selection bare.
   *
   * Picking geometry is not asking to move it: the gizmo used to land on
   * whatever was clicked, covering the very vertex being aimed at and taking
   * the next click for a drag. G, R and S bring it straight back.
   *
   * No status of its own: the selection that triggered it has something more
   * useful to say.
   */
  stowTransformTool: () =>
    set((state) => (state.activeTool === 'select' ? {} : { activeTool: 'select' })),

  // Picking a shape is picking up the select tool: the shape only means
  // anything to a selection drag.
  setSelectShape: (selectShape) =>
    set({ selectShape, activeTool: 'select', status: `${selectShape.toUpperCase()} SELECT` }),

  /**
   * Steps the select tool through its region shapes.
   *
   * The first press only picks the tool up: arriving from the move tool, V
   * should not also change what a drag draws. Every press after that advances
   * square, circle, lasso and round to square again.
   */
  cycleSelectShape: () => {
    const { activeTool, selectShape } = get();
    if (activeTool !== 'select') {
      set({ activeTool: 'select', status: `${selectShape.toUpperCase()} SELECT` });
      return;
    }

    const next = SELECT_SHAPES[(SELECT_SHAPES.indexOf(selectShape) + 1) % SELECT_SHAPES.length];
    get().setSelectShape(next);
  },

  setPivot: (pivot) => set({ pivot }),

  setSnap: (patch) => set((state) => ({ snap: { ...state.snap, ...patch } })),

  setProportional: (patch) =>
    set((state) => ({ proportional: { ...state.proportional, ...patch } })),

  beginModal: (kind) => {
    set({
      modal: {
        kind,
        axis: null,
        excludeAxis: false,
        typed: '',
        // A scale of nothing is 1, and the status bar reads this out live.
        value: kind === 'scale' ? { x: 1, y: 1, z: 1 } : { x: 0, y: 0, z: 0 },
      },
      status: `${kind.toUpperCase()}: move the mouse, X/Y/Z to constrain, click or Enter to confirm, Esc to cancel`,
    });
  },

  updateModal: (patch) =>
    set((state) => (state.modal ? { modal: { ...state.modal, ...patch } } : {})),

  endModal: () => set({ modal: null }),
});
