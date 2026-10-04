import type { StateCreator } from 'zustand';

import type { EditorStore } from '../useEditorStore';
import type {
  CameraPose,
  CursorSnapKind,
  ModalCommand,
  NavigationPreset,
  OrbitStep,
  OverlaySettings,
  ShadingMode,
  ViewLostReason,
  ViewportSettings,
} from '../types';

export interface ViewportSlice extends ViewportSettings {
  /** Incremented to ask the viewport to frame geometry; it is not camera state. */
  frameRequest: { target: 'selected' | 'all'; nonce: number } | null;
  axisViewRequest: { axis: 'x' | 'y' | 'z'; negative: boolean; nonce: number } | null;
  /** Asks the viewport to turn the camera by a step, or round to the far side. */
  orbitRequest: { step: OrbitStep; nonce: number } | null;
  /**
   * Incremented to ask the viewport for a snap at the pointer.
   *
   * The targets are resolved by a raycast, which only the viewport can run, and
   * the pointer is only known there too. The keyboard asks from here; the
   * right-click menu resolves its own targets as the click lands.
   */
  cursorSnapRequest: { kind: CursorSnapKind; nonce: number } | null;
  /**
   * Incremented to ask the viewport to open the delete menu at the pointer.
   *
   * The Delete key has no click to take a position from, and only the
   * viewport knows where the pointer was left.
   */
  deleteMenuRequest: { nonce: number } | null;
  /**
   * Incremented to finish the modal operation in progress from a button: make
   * it, call it off, or take the knife's last point back.
   *
   * The keyboard does this with Enter, Esc and Backspace, and the viewport
   * holds the operation, so a touch screen with no keys asks it from here.
   */
  modalCommandRequest: { command: ModalCommand; nonce: number } | null;
  /** Why the scene is out of view, or null while it is where the camera can see it. */
  viewLost: ViewLostReason | null;
  /**
   * Where the camera was left, written once as the viewport is torn down.
   *
   * The camera itself lives inside the Three.js viewport, which is destroyed
   * and rebuilt every time the module changes: without this, walking from
   * MODELING to DOCS and back would drop you at the default view of a scene
   * you had just framed. Not written per frame: only the handover needs it.
   */
  cameraPose: CameraPose | null;

  setShading: (shading: ShadingMode) => void;
  setOverlay: (patch: Partial<OverlaySettings>) => void;
  setViewportSetting: (patch: Partial<ViewportSettings>) => void;
  setNavigation: (preset: NavigationPreset) => void;
  frameSelected: () => void;
  frameAll: () => void;
  setAxisView: (axis: 'x' | 'y' | 'z', negative?: boolean) => void;
  orbitView: (step: OrbitStep) => void;
  snapCursorUnderPointer: (kind: CursorSnapKind) => void;
  openDeleteMenuAtPointer: () => void;
  commandModal: (command: ModalCommand) => void;
  setViewLost: (lost: ViewLostReason | null) => void;
  setCameraPose: (pose: CameraPose) => void;
}

let nonce = 0;

/**
 * What each end of each axis is called on screen.
 *
 * One table for the status line, the corner widget and anything else that has
 * to name a view, so the six names cannot drift apart between them.
 */
export function axisViewName(axis: 'x' | 'y' | 'z', negative: boolean): string {
  if (axis === 'y') return negative ? 'Bottom' : 'Top';
  if (axis === 'x') return negative ? 'Left' : 'Right';
  return negative ? 'Back' : 'Front';
}

/** What the status bar says when the keyboard turns the camera. */
const ORBIT_STATUS: Record<OrbitStep, string> = {
  left: 'Orbit left',
  right: 'Orbit right',
  up: 'Orbit up',
  down: 'Orbit down',
  opposite: 'Opposite side',
};

export const createViewportSlice: StateCreator<
  EditorStore,
  [['zustand/subscribeWithSelector', never]],
  [],
  ViewportSlice
> = (set) => ({
  shading: 'solidWire',
  overlays: {
    grid: true,
    axes: true,
    normals: false,
    faceOrientation: false,
    statistics: true,
    cursor: true,
    origins: true,
  },
  backfaceCulling: false,
  orthographic: false,
  focalLength: 50,
  clipStart: 0.05,
  clipEnd: 2000,
  navigation: 'blender',
  frameRequest: null,
  axisViewRequest: null,
  orbitRequest: null,
  cursorSnapRequest: null,
  deleteMenuRequest: null,
  modalCommandRequest: null,
  viewLost: null,
  cameraPose: null,

  setShading: (shading) => set({ shading, status: `Shading: ${shading}` }),

  setOverlay: (patch) => set((state) => ({ overlays: { ...state.overlays, ...patch } })),

  setViewportSetting: (patch) => set(patch),

  setNavigation: (navigation) => set({ navigation, status: `${navigation} navigation` }),

  frameSelected: () => set({ frameRequest: { target: 'selected', nonce: ++nonce } }),

  frameAll: () => set({ frameRequest: { target: 'all', nonce: ++nonce } }),

  setAxisView: (axis, negative = false) =>
    set({
      axisViewRequest: { axis, negative, nonce: ++nonce },
      status: `${axisViewName(axis, negative)} view`,
    }),

  orbitView: (step) => set({ orbitRequest: { step, nonce: ++nonce }, status: ORBIT_STATUS[step] }),

  snapCursorUnderPointer: (kind) => set({ cursorSnapRequest: { kind, nonce: ++nonce } }),

  openDeleteMenuAtPointer: () => set({ deleteMenuRequest: { nonce: ++nonce } }),

  commandModal: (command) => set({ modalCommandRequest: { command, nonce: ++nonce } }),

  setViewLost: (viewLost) => set({ viewLost }),

  setCameraPose: (cameraPose) => set({ cameraPose }),
});
