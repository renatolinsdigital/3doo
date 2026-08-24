import type { StateCreator } from 'zustand';

import type { EditorStore } from '../useEditorStore';
import type { NavigationPreset, OverlaySettings, ShadingMode, ViewportSettings } from '../types';

export interface ViewportSlice extends ViewportSettings {
  /** Incremented to ask the viewport to frame geometry; it is not camera state. */
  frameRequest: { target: 'selected' | 'all'; nonce: number } | null;
  axisViewRequest: { axis: 'x' | 'y' | 'z'; negative: boolean; nonce: number } | null;
  /** True once the camera has orbited far enough that the scene is hard to make out. */
  viewLost: boolean;

  setShading: (shading: ShadingMode) => void;
  setOverlay: (patch: Partial<OverlaySettings>) => void;
  setViewportSetting: (patch: Partial<ViewportSettings>) => void;
  setNavigation: (preset: NavigationPreset) => void;
  frameSelected: () => void;
  frameAll: () => void;
  setAxisView: (axis: 'x' | 'y' | 'z', negative?: boolean) => void;
  setViewLost: (lost: boolean) => void;
}

let nonce = 0;

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
  },
  backfaceCulling: false,
  orthographic: false,
  focalLength: 50,
  clipStart: 0.05,
  clipEnd: 2000,
  navigation: 'blender',
  frameRequest: null,
  axisViewRequest: null,
  viewLost: false,

  setShading: (shading) => set({ shading, status: `Shading: ${shading}` }),

  setOverlay: (patch) => set((state) => ({ overlays: { ...state.overlays, ...patch } })),

  setViewportSetting: (patch) => set(patch),

  setNavigation: (navigation) => set({ navigation, status: `${navigation} navigation` }),

  frameSelected: () => set({ frameRequest: { target: 'selected', nonce: ++nonce } }),

  frameAll: () => set({ frameRequest: { target: 'all', nonce: ++nonce } }),

  setAxisView: (axis, negative = false) =>
    set({ axisViewRequest: { axis, negative, nonce: ++nonce } }),

  setViewLost: (viewLost) => set({ viewLost }),
});
