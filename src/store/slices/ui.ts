import type { StateCreator } from 'zustand';

import { type ExportOptions, DEFAULT_EXPORT_OPTIONS } from '@kernel/index';

import type { EditorStore } from '../useEditorStore';
import type { DialogId, Toast } from '../types';

export interface UiSlice {
  toasts: Toast[];
  dialog: DialogId;
  exportOptions: ExportOptions;
  /** Live preview count for merge by distance, before the user commits. */
  mergePreview: { threshold: number; removed: number } | null;

  pushToast: (variant: Toast['variant'], message: string) => void;
  dismissToast: (id: string) => void;
  openDialog: (dialog: DialogId) => void;
  closeDialog: () => void;
  setExportOptions: (patch: Partial<ExportOptions>) => void;
  setMergePreview: (preview: UiSlice['mergePreview']) => void;
}

let toastCounter = 0;

export const createUiSlice: StateCreator<
  EditorStore,
  [['zustand/subscribeWithSelector', never]],
  [],
  UiSlice
> = (set) => ({
  toasts: [],
  dialog: null,
  exportOptions: { ...DEFAULT_EXPORT_OPTIONS },
  mergePreview: null,

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
});
