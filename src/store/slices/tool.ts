import type { StateCreator } from 'zustand';

import type { SelectMode } from '@kernel/index';

import type { EditorStore } from '../useEditorStore';
import { activeObject } from './scene';
import type {
  AutoMergeSettings,
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
  autoMerge: AutoMergeSettings;
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
  setAutoMerge: (patch: Partial<AutoMergeSettings>) => void;
  beginSlide: () => void;
  beginModal: (kind: ModalTransform['kind'], element?: ModalTransform['element']) => void;
  updateModal: (patch: Partial<ModalTransform>) => void;
  endModal: (status?: string) => void;
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
  // Off by default, and a tenth of the default grid square when it is switched
  // on: wide enough to catch a slide run all the way onto its neighbour,
  // narrow enough to leave detail the user modelled on purpose alone.
  autoMerge: { enabled: false, threshold: 0.01 },
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

  setAutoMerge: (patch) => set((state) => ({ autoMerge: { ...state.autoMerge, ...patch } })),

  /**
   * Starts a slide, or says why it cannot.
   *
   * Which element slides is the select mode, since that is what the user is
   * looking at: vertices run along the edges leaving them, edges run across the
   * faces either side. Faces have no one rail to travel along, so face mode is
   * turned away rather than guessing at one.
   */
  beginSlide: () => {
    const state = get();
    const object = activeObject(state);

    if (state.mode !== 'edit' || !object) {
      set({ status: 'Sliding works on mesh elements: enter edit mode first (Tab)' });
      return;
    }
    if (state.selectMode === 'face') {
      set({ status: 'Sliding runs along edges: switch to vertex or edge select (1 or 2)' });
      return;
    }

    const element = state.selectMode;
    const selected =
      element === 'edge' ? object.mesh.selectedEdges() : object.mesh.selectedVerts();
    if (selected.length === 0) {
      set({ status: `Select ${element === 'edge' ? 'edges' : 'vertices'} to slide` });
      return;
    }

    get().beginModal('slide', element);
  },

  beginModal: (kind, element) => {
    set({
      modal: {
        kind,
        element,
        axis: null,
        excludeAxis: false,
        typed: '',
        // A scale of nothing is 1, and the status bar reads this out live.
        value: kind === 'scale' ? { x: 1, y: 1, z: 1 } : { x: 0, y: 0, z: 0 },
      },
      // A slide has no axis to constrain: it already runs along one, the edge
      // under it.
      status:
        kind === 'slide'
          ? 'SLIDE: move the mouse, click or Enter to confirm, Esc to cancel'
          : `${kind.toUpperCase()}: move the mouse, X/Y/Z to constrain, click or Enter to confirm, Esc to cancel`,
    });
  },

  updateModal: (patch) =>
    set((state) => (state.modal ? { modal: { ...state.modal, ...patch } } : {})),

  // The status is how a modal transform reports what it did: the instruction
  // text it put up while it was running has nothing left to say once it ends.
  endModal: (status) => set(status ? { modal: null, status } : { modal: null }),
});
