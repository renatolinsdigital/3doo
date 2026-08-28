import type { StateCreator } from 'zustand';

import { type ExportOptions, DEFAULT_EXPORT_OPTIONS } from '@kernel/index';

import type { EditorStore } from '../useEditorStore';
import type { CursorMenuState, DialogId, HintState, OperationProgress, Toast } from '../types';

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
  /** The long operation under way, or null. Drawn as a bar in the status bar. */
  progress: OperationProgress | null;
  /**
   * Whether a staged operation is running.
   *
   * Set the moment one starts, unlike `progress`, which waits to see whether
   * the operation is slow enough to be worth drawing. A staged operation hands
   * control back to the browser between its stages, so without this the button
   * that started it is still live and a second run would race the first over
   * the same mesh.
   */
  busy: boolean;

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
  /**
   * Runs a staged operation, showing its progress once it is slow enough to
   * be worth saying anything about.
   */
  runStaged: <T>(label: string, steps: Generator<number, T>) => Promise<T>;
}

/**
 * How long an operation may run before it earns a progress bar.
 *
 * Most cuts land well inside this and finish before anything is drawn, which is
 * the point: a bar that flashes up and vanishes on every small operation is
 * noise, and the ones worth reporting are the ones that outlast it.
 */
const PROGRESS_AFTER_MS = 150;

/**
 * Hands the browser a chance to paint.
 *
 * A frame, then a turn of the event loop: `requestAnimationFrame` runs before
 * the paint it is scheduled against, so resolving there alone would put the
 * next chunk of work in front of the very repaint it is waiting for.
 */
function paint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
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
  progress: null,
  busy: false,

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

  runStaged: async (label, steps) => {
    const started = performance.now();
    set({ busy: true });

    try {
      let showing = false;
      let step = steps.next();

      while (!step.done) {
        // The work between two stages has already happened by the time we get
        // here, so elapsed time is the honest test of whether this is an
        // operation the user is sitting and waiting on.
        if (!showing && performance.now() - started > PROGRESS_AFTER_MS) showing = true;

        if (showing) {
          set({ progress: { label, value: step.value } });
          await paint();
        }
        step = steps.next();
      }

      return step.value;
    } finally {
      // Whatever happened, the bar comes down and the buttons come back.
      set({ progress: null, busy: false });
    }
  },
});
