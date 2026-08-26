import type { StateCreator } from 'zustand';

import { type ExportOptions, DEFAULT_EXPORT_OPTIONS } from '@kernel/index';

import type { EditorStore } from '../useEditorStore';
import type { CursorMenuState, DialogId, HintState, Toast } from '../types';

export interface UiSlice {
  toasts: Toast[];
  dialog: DialogId;
  exportOptions: ExportOptions;
  /** Live preview count for merge by distance, before the user commits. */
  mergePreview: { threshold: number; removed: number } | null;
  /** The currently visible hover hint, or null when nothing is hovered. */
  hint: HintState | null;
  /** The viewport's right-click cursor menu, or null when it is closed. */
  cursorMenu: CursorMenuState | null;
  /** Panels folded away, keyed by title. Missing means open, so a new scene is all open. */
  collapsedPanels: Record<string, boolean>;

  pushToast: (variant: Toast['variant'], message: string) => void;
  dismissToast: (id: string) => void;
  openDialog: (dialog: DialogId) => void;
  closeDialog: () => void;
  setExportOptions: (patch: Partial<ExportOptions>) => void;
  setMergePreview: (preview: UiSlice['mergePreview']) => void;
  showHint: (text: string, anchor: { left: number; bottom: number; top: number }) => void;
  hideHint: () => void;
  openCursorMenu: (menu: CursorMenuState) => void;
  closeCursorMenu: () => void;
  togglePanel: (title: string) => void;
  setCollapsedPanels: (collapsed: Record<string, boolean>) => void;
}

let toastCounter = 0;

export const createUiSlice: StateCreator<
  EditorStore,
  [['zustand/subscribeWithSelector', never]],
  [],
  UiSlice
> = (set, get) => ({
  toasts: [],
  dialog: null,
  exportOptions: { ...DEFAULT_EXPORT_OPTIONS },
  mergePreview: null,
  hint: null,
  cursorMenu: null,
  collapsedPanels: {},

  pushToast: (variant, message) => {
    toastCounter += 1;
    const toast: Toast = { id: `toast-${toastCounter}`, variant, message };
    set((state) => ({ toasts: [...state.toasts, toast] }));
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  openDialog: (dialog) => set({ dialog }),

  closeDialog: () => set({ dialog: null, mergePreview: null }),

  setExportOptions: (patch) =>
    set((state) => ({ exportOptions: { ...state.exportOptions, ...patch } })),

  setMergePreview: (mergePreview) => set({ mergePreview }),

  showHint: (text, anchor) => {
    if (!get().tooltipsEnabled) return;
    set({ hint: { text, x: anchor.left, y: anchor.bottom, anchorTop: anchor.top } });
  },

  hideHint: () => set({ hint: null }),

  // The hint is dismissed alongside: the pointer is about to be over a menu,
  // and a tooltip left hanging behind it never clears.
  openCursorMenu: (cursorMenu) => set({ cursorMenu, hint: null }),

  closeCursorMenu: () => set({ cursorMenu: null }),

  togglePanel: (title) =>
    set((state) => ({
      collapsedPanels: { ...state.collapsedPanels, [title]: !state.collapsedPanels[title] },
    })),

  setCollapsedPanels: (collapsed) => set({ collapsedPanels: { ...collapsed } }),
});
