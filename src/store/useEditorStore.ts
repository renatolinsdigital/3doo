import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

import { type PreferencesSlice, createPreferencesSlice } from './slices/preferences';
import { type SceneSlice, createSceneSlice } from './slices/scene';
import { type ToolSlice, createToolSlice } from './slices/tool';
import { type UiSlice, createUiSlice } from './slices/ui';
import { type ViewportSlice, createViewportSlice } from './slices/viewport';

export type EditorStore = SceneSlice & ToolSlice & ViewportSlice & UiSlice & PreferencesSlice;

/**
 * One store, five slices.
 *
 * `subscribeWithSelector` is what lets the Three.js viewport — which is not a
 * React component — watch narrow pieces of state imperatively, and lets panels
 * subscribe to just the field they render so a camera move never re-renders the
 * properties panel.
 */
export const useEditorStore = create<EditorStore>()(
  subscribeWithSelector((...args) => ({
    ...createSceneSlice(...args),
    ...createToolSlice(...args),
    ...createViewportSlice(...args),
    ...createUiSlice(...args),
    ...createPreferencesSlice(...args),
  })),
);

export const editorStore = useEditorStore;
