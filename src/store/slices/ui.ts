import type { StateCreator } from 'zustand';

import { type ExportOptions, DEFAULT_EXPORT_OPTIONS } from '@kernel/index';

import type { EditorStore } from '../useEditorStore';
import type { CursorMenuState, DialogId, HintState, Toast } from '../types';

const TOOLTIPS_STORAGE_KEY = '3doo:tooltips-enabled';

/**
 * Reads the tooltip preference from localStorage.
 *
 * Wrapped because private browsing / storage-blocked contexts throw on access
 * rather than just returning null, and a missing preference should not crash
 * the app — it should just default to tooltips on.
 */
function readTooltipsPreference(): boolean {
  try {
    const stored = window.localStorage.getItem(TOOLTIPS_STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

function writeTooltipsPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(TOOLTIPS_STORAGE_KEY, String(enabled));
  } catch {
    // Storage unavailable: the preference just does not persist this session.
  }
}

export interface UiSlice {
  toasts: Toast[];
  dialog: DialogId;
  exportOptions: ExportOptions;
  /** Live preview count for merge by distance, before the user commits. */
  mergePreview: { threshold: number; removed: number } | null;
  tooltipsEnabled: boolean;
  /** The currently visible hover hint, or null when nothing is hovered. */
  hint: HintState | null;
  /** The viewport's right-click cursor menu, or null when it is closed. */
  cursorMenu: CursorMenuState | null;

  pushToast: (variant: Toast['variant'], message: string) => void;
  dismissToast: (id: string) => void;
  openDialog: (dialog: DialogId) => void;
  closeDialog: () => void;
  setExportOptions: (patch: Partial<ExportOptions>) => void;
  setMergePreview: (preview: UiSlice['mergePreview']) => void;
  setTooltipsEnabled: (enabled: boolean) => void;
  showHint: (text: string, anchor: { left: number; bottom: number; top: number }) => void;
  hideHint: () => void;
  openCursorMenu: (menu: CursorMenuState) => void;
  closeCursorMenu: () => void;
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
  tooltipsEnabled: readTooltipsPreference(),
  hint: null,
  cursorMenu: null,

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

  setTooltipsEnabled: (enabled) => {
    writeTooltipsPreference(enabled);
    set({ tooltipsEnabled: enabled, hint: enabled ? get().hint : null });
  },

  showHint: (text, anchor) => {
    if (!get().tooltipsEnabled) return;
    set({ hint: { text, x: anchor.left, y: anchor.bottom, anchorTop: anchor.top } });
  },

  hideHint: () => set({ hint: null }),

  // The hint is dismissed alongside: the pointer is about to be over a menu,
  // and a tooltip left hanging behind it never clears.
  openCursorMenu: (cursorMenu) => set({ cursorMenu, hint: null }),

  closeCursorMenu: () => set({ cursorMenu: null }),
});
