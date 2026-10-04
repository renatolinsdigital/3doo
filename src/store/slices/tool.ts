import type { StateCreator } from 'zustand';

import type { BMesh, SelectMode } from '@kernel/index';

import type { EditorStore } from '../useEditorStore';
import { activeObject } from './scene';
import type {
  AutoMergeSettings,
  EditorMode,
  ModalTransform,
  PivotMode,
  ProportionalSettings,
  SelectShape,
  SlidePreview,
  ToolId,
} from '../types';

/**
 * How each modal operation is driven, for the hint the status bar carries.
 *
 * Only a move, a turn and a scale have an axis to pin, which is what X, Y and Z
 * offer mid-drag. A slide is already running along one, the edge under it, and
 * the three pointer-driven operators are one distance each with nothing to pin
 * it to: what they need saying instead is which way that distance opens. A
 * knife cut is clicked out point by point, so a click adds to it rather than
 * ending it, and Enter is what makes the cut.
 */
const MODAL_HINTS: Record<ModalTransform['kind'], string> = {
  move: 'move the mouse, X/Y/Z to constrain',
  rotate: 'move the mouse, X/Y/Z to constrain',
  scale: 'move the mouse, X/Y/Z to constrain',
  slide: 'move the mouse',
  bevel: 'draw the guide line out from the selection',
  inset: 'push the pointer in toward the selection',
  extrude: 'move the pointer along the normal',
  knife: 'click to add points, Enter to cut, Backspace to take one back, E for a new line',
};

/** What the status bar says while the knife is in hand and no cut has been started. */
const KNIFE_READY = 'KNIFE: click on the mesh to start a cut';

/** What each pointer-driven operator is called, and what it needs selected. */
const OFFSET_OPERATORS = {
  bevel: {
    label: 'Bevelling',
    refusal: 'Select edges to bevel',
    ready: (mesh: BMesh) => mesh.selectedEdges().length > 0,
  },
  inset: {
    label: 'Insetting',
    refusal: 'Select faces to inset',
    ready: (mesh: BMesh) => mesh.selectedFaces().length > 0,
  },
  extrude: {
    label: 'Extruding',
    refusal: 'Select faces or edges to extrude',
    ready: (mesh: BMesh) => mesh.selectedFaces().length > 0 || mesh.selectedEdges().length > 0,
  },
} as const;

/** The order V steps through, and the order the select tool's menu lists. */
export const SELECT_SHAPES: readonly SelectShape[] = ['box', 'circle', 'lasso'];

export interface ToolSlice {
  mode: EditorMode;
  selectMode: SelectMode;
  activeTool: ToolId;
  selectShape: SelectShape;
  pivot: PivotMode;
  proportional: ProportionalSettings;
  autoMerge: AutoMergeSettings;
  modal: ModalTransform | null;
  slidePreview: SlidePreview | null;
  /**
   * Whether a click builds on the selection the way Shift+click does, with no
   * Shift held. A touch screen has no keys to hold, and this is how a finger
   * picks more than one thing.
   */
  selectExtend: boolean;

  setMode: (mode: EditorMode) => void;
  toggleMode: () => void;
  setSelectMode: (mode: SelectMode) => void;
  setActiveTool: (tool: ToolId) => void;
  setSelectShape: (shape: SelectShape) => void;
  cycleSelectShape: () => void;
  setPivot: (pivot: PivotMode) => void;
  setProportional: (patch: Partial<ProportionalSettings>) => void;
  setAutoMerge: (patch: Partial<AutoMergeSettings>) => void;
  setSlidePreview: (preview: SlidePreview | null) => void;
  beginSlide: () => void;
  beginOffset: (kind: 'bevel' | 'inset' | 'extrude') => void;
  beginModal: (kind: ModalTransform['kind'], element?: ModalTransform['element']) => void;
  updateModal: (patch: Partial<ModalTransform>) => void;
  endModal: (status?: string) => void;
  setSelectExtend: (extend: boolean) => void;
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
  // Half the height of a fresh primitive. A turned loop round the middle of a
  // cylinder then bends the walls and leaves the caps where they are; at 1.5
  // the falloff reached the caps at three quarters strength and the whole
  // cylinder swung round with the loop.
  proportional: { enabled: false, radius: 0.5, falloff: 'smooth' },
  // Off by default, and a tenth of the default grid square when it is switched
  // on: wide enough to catch a slide run all the way onto its neighbour,
  // narrow enough to leave detail the user modelled on purpose alone.
  autoMerge: { enabled: false, threshold: 0.01 },
  modal: null,
  slidePreview: null,
  selectExtend: false,

  setMode: (mode) => {
    const object = activeObject(get());
    if (mode === 'edit' && !object) {
      set({ status: 'Select an object before entering edit mode' });
      get().pushToast('warning', 'Select an object before entering edit mode');
      return;
    }
    // Edit mode opens on a clean mesh. Selection flags live on the geometry
    // itself, so they outlast the session that made them: a mesh comes back
    // holding whatever was picked last time, and an object-mode operation that
    // works on the whole mesh (a boolean, a normals pass) can leave everything
    // flagged. Either way what lit up on the way in was nothing the user chose.
    if (mode === 'edit' && object) object.mesh.deselectAll();

    // The delete menu goes too: its entries are edit-mode operations, and one
    // left open across the switch would come back on the next visit. So does
    // the knife, which cuts faces and has nothing to cut in object mode.
    set((state) => ({
      mode,
      modal: null,
      deleteMenu: null,
      activeTool: mode === 'object' && state.activeTool === 'knife' ? 'select' : state.activeTool,
      meshVersion: state.meshVersion + 1,
      status: mode === 'edit' ? 'Edit mode' : 'Object mode',
    }));
  },

  toggleMode: () => get().setMode(get().mode === 'object' ? 'edit' : 'object'),

  /**
   * Switching what you are picking, not what is picked.
   *
   * Nothing is flushed here. Every selection already propagates to all three
   * element types as it is made, so the mesh arrives consistent and the switch
   * only changes which of them is on show. Flushing again on the way in
   * re-derived the new mode's own type from one it had just derived, which
   * invented selections nobody made: take the side faces of a cylinder and
   * every rim vertex is selected, so asking for the faces the vertices cover
   * hands back the caps as well, and one more switch spreads that to the whole
   * mesh. It lost work in the other direction too, since vertices that never
   * closed a face were dropped on the way to face mode and could not come back.
   */
  setSelectMode: (selectMode) => {
    set((state) => ({ selectMode, meshVersion: state.meshVersion + 1 }));
  },

  setActiveTool: (activeTool) =>
    set({ activeTool, status: activeTool === 'knife' ? KNIFE_READY : activeTool.toUpperCase() }),

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

  setProportional: (patch) =>
    set((state) => ({ proportional: { ...state.proportional, ...patch } })),

  setAutoMerge: (patch) => set((state) => ({ autoMerge: { ...state.autoMerge, ...patch } })),

  /**
   * Publishes where the panel's numbered slide would leave the selection, for
   * the preview the viewport draws over the mesh. Null while there is none.
   */
  setSlidePreview: (slidePreview) => set({ slidePreview }),

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
    const selected = element === 'edge' ? object.mesh.selectedEdges() : object.mesh.selectedVerts();
    if (selected.length === 0) {
      set({ status: `Select ${element === 'edge' ? 'edges' : 'vertices'} to slide` });
      return;
    }

    get().beginModal('slide', element);
  },

  /**
   * Starts a bevel, an inset or an extrude whose distance comes from the
   * pointer, or says why it cannot.
   *
   * All three take one distance, and a distance typed in before the shape it
   * makes has been seen is guesswork. The shortcuts drag it out against the
   * model instead, the way Blender's do; the OPERATIONS panel keeps its number
   * fields for when the exact figure is the point.
   */
  beginOffset: (kind) => {
    const state = get();
    const object = activeObject(state);
    const { label, refusal, ready } = OFFSET_OPERATORS[kind];

    if (state.mode !== 'edit' || !object) {
      set({ status: `${label} works on mesh elements: enter edit mode first (Tab)` });
      return;
    }
    if (object.locked) {
      get().noteLockedAttempt(object.id);
      return;
    }
    if (!ready(object.mesh)) {
      set({ status: refusal });
      return;
    }

    get().beginModal(kind);
  },

  beginModal: (kind, element) => {
    // A turn or a scale about the 3D cursor swings the selection round a point
    // that may be nowhere near it, which looks like the object flying off until
    // you know the pivot is set that way. Said here because this is the moment
    // it decides what happens, not just a flag to notice in the status bar.
    const orbiting = (kind === 'rotate' || kind === 'scale') && get().pivot === 'cursor';
    const about = orbiting ? ' about the 3D cursor' : '';
    const ending = kind === 'knife' ? 'Esc to cancel' : 'click or Enter to confirm, Esc to cancel';

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
      status: `${kind.toUpperCase()}${about}: ${MODAL_HINTS[kind]}, ${ending}`,
    });
  },

  updateModal: (patch) =>
    set((state) => (state.modal ? { modal: { ...state.modal, ...patch } } : {})),

  // The status is how a modal transform reports what it did: the instruction
  // text it put up while it was running has nothing left to say once it ends.
  endModal: (status) => set(status ? { modal: null, status } : { modal: null }),

  setSelectExtend: (selectExtend) =>
    set({
      selectExtend,
      status: selectExtend
        ? 'ADD: a tap adds to the selection, and a tap on something selected takes it back out'
        : 'ADD off: a tap replaces the selection',
    }),
});
