import type { StateCreator } from 'zustand';

import type { EditorStore } from '../useEditorStore';
import type { Preferences } from '../types';

const STORAGE_KEY = '3doo:preferences';

export const DEFAULT_PREFERENCES: Preferences = {
  tooltipsEnabled: true,
  selectionLineWidth: 2,
  selectionLineColor: '#e5342a',
};

export const MIN_SELECTION_LINE_WIDTH = 1;
export const MAX_SELECTION_LINE_WIDTH = 8;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function clampWidth(value: number): number {
  return Math.min(MAX_SELECTION_LINE_WIDTH, Math.max(MIN_SELECTION_LINE_WIDTH, value));
}

/**
 * Rebuilds a complete preference set from anything shaped roughly like one — a
 * storage blob, an imported file, a build that stored fewer keys.
 *
 * Every field falls back to its default on its own, so one bad value cannot
 * cost the user the rest of their settings, and a width outside the slider's
 * range cannot reach the renderer as a hairline or a slab.
 */
export function coercePreferences(raw: unknown): Preferences {
  const source = (raw ?? {}) as Partial<Record<keyof Preferences, unknown>>;
  const width = Number(source.selectionLineWidth);
  const color = typeof source.selectionLineColor === 'string' ? source.selectionLineColor : '';

  return {
    tooltipsEnabled:
      typeof source.tooltipsEnabled === 'boolean'
        ? source.tooltipsEnabled
        : DEFAULT_PREFERENCES.tooltipsEnabled,
    selectionLineWidth: Number.isFinite(width)
      ? clampWidth(width)
      : DEFAULT_PREFERENCES.selectionLineWidth,
    selectionLineColor: HEX_COLOR.test(color)
      ? color.toLowerCase()
      : DEFAULT_PREFERENCES.selectionLineColor,
  };
}

function readPreferences(): Preferences {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null ? { ...DEFAULT_PREFERENCES } : coercePreferences(JSON.parse(stored));
  } catch {
    // Private browsing throws on the read outright, and a hand-edited value can
    // be unparseable. Neither is a reason to refuse to start the editor.
    return { ...DEFAULT_PREFERENCES };
  }
}

function writePreferences(preferences: Preferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage unavailable: the change applies, it just does not outlive the tab.
  }
}

export interface PreferencesSlice extends Preferences {
  setPreferences: (patch: Partial<Preferences>) => void;
  resetPreferences: () => void;
  /** The persisted fields alone, for the export button and for round-tripping. */
  currentPreferences: () => Preferences;
  /** Applies a preferences file. Throws with a message worth showing in a toast. */
  importPreferences: (text: string) => void;
}

export const createPreferencesSlice: StateCreator<
  EditorStore,
  [['zustand/subscribeWithSelector', never]],
  [],
  PreferencesSlice
> = (set, get) => {
  const apply = (next: Preferences) => {
    writePreferences(next);
    // A hint already on screen would otherwise hang there once tooltips go off.
    set(next.tooltipsEnabled ? { ...next } : { ...next, hint: null });
  };

  return {
    ...readPreferences(),

    setPreferences: (patch) =>
      apply(coercePreferences({ ...get().currentPreferences(), ...patch })),

    resetPreferences: () => apply({ ...DEFAULT_PREFERENCES }),

    currentPreferences: () => {
      const { tooltipsEnabled, selectionLineWidth, selectionLineColor } = get();
      return { tooltipsEnabled, selectionLineWidth, selectionLineColor };
    },

    importPreferences: (text) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('That file is not valid JSON');
      }

      const isRecord = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
      const hasAny =
        isRecord && Object.keys(DEFAULT_PREFERENCES).some((key) => key in (parsed as object));
      if (!hasAny) throw new Error('That file holds no preferences');

      apply(coercePreferences(parsed));
    },
  };
};
