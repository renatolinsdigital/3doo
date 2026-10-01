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
 * `subscribeWithSelector` is what lets the Three.js viewport (which is not a
 * React component) watch narrow pieces of state imperatively, and lets panels
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

// The undo timeline is built before any slice exists, at the size a fresh
// install uses, so a size restored from storage is handed over once here.
useEditorStore.getState().setHistoryLimit(useEditorStore.getState().historySize);

/**
 * What counts as changing the project.
 *
 * Every one of these is written to a file and to the autosave, and every edit
 * in the application replaces one of them by reference, since panels select
 * them and an in-place change would not re-render. Geometry is the exception,
 * being mutated in place, and `meshVersion` is what says it moved.
 *
 * Selection is deliberately absent: clicking an object is not a change worth
 * writing, and it is the whole of what somebody who "did nothing" did. Which
 * panels are folded is absent for the same reason. Edit-mode selection does
 * come through `meshVersion`, because in this kernel a vertex carries its own
 * selected flag.
 */
const documentSignal = (state: EditorStore) =>
  [
    state.meshVersion,
    state.objects,
    state.groups,
    state.projectName,
    state.cursor,
    state.assets,
  ] as const;

/**
 * Raises the dirty flag on the first change since the scene was last stored,
 * and takes away the claim that this scene is in a file on disk.
 *
 * Subscribed here, once, rather than set by each action: the alternative is the
 * same line in thirty actions, and the one place it gets forgotten is a change
 * that silently never reaches the autosave. That is how renaming an object came
 * to be left out of it.
 */
useEditorStore.subscribe(
  documentSignal,
  () => useEditorStore.setState({ dirty: true, savedToFile: false }),
  {
    equalityFn: (a, b) => a.every((value, index) => value === b[index]),
  },
);
