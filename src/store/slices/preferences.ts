import type { StateCreator } from 'zustand';

import type { EditorStore } from '../useEditorStore';
import type { PanelId, PanelVisibility, Preferences, SnapMode } from '../types';

const STORAGE_KEY = '3doo:preferences';

/** Everything on screen, which is what a fresh install shows. */
const DEFAULT_PANELS: PanelVisibility = {
  toolRail: true,
  primitives: true,
  object: true,
  boolean: true,
  operations: true,
  loopOperations: true,
  topology: true,
  outliner: true,
  properties: true,
  modifiers: true,
  statusBar: true,
};

export const DEFAULT_PREFERENCES: Preferences = {
  tooltipsEnabled: true,
  panels: { ...DEFAULT_PANELS },
  selectionLineWidth: 2,
  selectionLineColor: '#e5342a',
  viewportBackground: '#1a1918',
  gridScale: 1,
  gridSubdivisions: 10,
  lockVerticalOrbit: false,
  wheelZoom: 'pointer',
  snapEnabled: false,
  snapMode: 'grid',
  snapStep: 0.1,
  historySize: 50,
  autosaveEnabled: false,
  autosaveInterval: 180,
  // VIEWPORT_COLORS.grid and .rust, which the viewport used to hard-code. Named
  // there in hex ints, written here as CSS so the colour inputs can show them.
  gridColor: '#3a2a28',
  gridOpacity: 0.3,
  gridMajorColor: '#b8452f',
  gridMajorOpacity: 0.65,
};

export const MIN_SELECTION_LINE_WIDTH = 1;
export const MAX_SELECTION_LINE_WIDTH = 8;

/** Three decades either side of the step the zoom picks, which is past useful both ways. */
export const MIN_GRID_SCALE = 0.001;
export const MAX_GRID_SCALE = 1000;
/** One is no subdivision at all (every line heavy) and the cap keeps the mesh sane. */
export const MIN_GRID_SUBDIVISIONS = 1;
export const MAX_GRID_SUBDIVISIONS = 100;

/** The same range as the grid scale it multiplies: past useful either way. */
export const MIN_SNAP_STEP = MIN_GRID_SCALE;
export const MAX_SNAP_STEP = MAX_GRID_SCALE;

/**
 * How many steps undo keeps.
 *
 * Ten is enough to back out of a bad idea, fifty is what a fresh install keeps,
 * and a hundred is the ceiling because every step holds a whole copy of the
 * scene: what history costs is this figure times the size of the model.
 */
export const MIN_HISTORY_SIZE = 10;
export const MAX_HISTORY_SIZE = 100;

/**
 * How often the autosave may run, in seconds: thirty seconds to fifteen minutes.
 *
 * A short list rather than a free number: the difference between seven
 * minutes and eight is nothing anybody needs, and every entry here is a round
 * figure somebody can hold in their head while deciding what a crash may cost
 * them.
 */
export const AUTOSAVE_INTERVALS = [30, 60, 120, 180, 300, 600, 900] as const;

/** What each interval is called, in the picker and in the status messages. */
export function autosaveIntervalLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} SECONDS`;
  const minutes = seconds / 60;
  return minutes === 1 ? '1 MINUTE' : `${minutes} MINUTES`;
}

/**
 * The multiple of the grid scale actually in force.
 *
 * The grid is a step of one, by definition. The custom figure is kept aside
 * while the grid is chosen, so this is the one place that decides which of the
 * two the viewport and the status bar are looking at.
 */
export function snapStepFor(mode: SnapMode, step: number): number {
  return mode === 'grid' ? 1 : step;
}

/** What the snap in force is called, on the status bar. */
export function snapStepLabel(mode: SnapMode, step: number): string {
  return mode === 'grid' || step === 1 ? 'GRID' : `${step} GRID`;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A finite number inside its range, or the default when it is neither. */
function coerceNumber(raw: unknown, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** A `#rrggbb` colour, lowercased, or the default. */
function coerceColor(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && HEX_COLOR.test(raw) ? raw.toLowerCase() : fallback;
}

function coerceBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

/**
 * Every surface shown unless the stored blob says otherwise.
 *
 * Keyed off the defaults rather than off what was stored, so a panel added
 * after someone last saved their preferences arrives visible instead of
 * missing, and a key that is no longer a panel is dropped.
 */
function coercePanels(raw: unknown): PanelVisibility {
  const source = (raw ?? {}) as Partial<Record<PanelId, unknown>>;
  const panels = { ...DEFAULT_PANELS };

  for (const id of Object.keys(panels) as PanelId[]) {
    panels[id] = coerceBoolean(source[id], panels[id]);
  }

  return panels;
}

/**
 * Rebuilds a complete preference set from anything shaped roughly like one: a
 * storage blob, an imported file, a build that stored fewer keys.
 *
 * Every field falls back to its default on its own, so one bad value cannot
 * cost the user the rest of their settings, and a width outside the slider's
 * range cannot reach the renderer as a hairline or a slab.
 */
export function coercePreferences(raw: unknown): Preferences {
  const source = (raw ?? {}) as Partial<Record<keyof Preferences, unknown>>;

  return {
    tooltipsEnabled: coerceBoolean(source.tooltipsEnabled, DEFAULT_PREFERENCES.tooltipsEnabled),
    panels: coercePanels(source.panels),
    selectionLineWidth: coerceNumber(
      source.selectionLineWidth,
      MIN_SELECTION_LINE_WIDTH,
      MAX_SELECTION_LINE_WIDTH,
      DEFAULT_PREFERENCES.selectionLineWidth,
    ),
    selectionLineColor: coerceColor(
      source.selectionLineColor,
      DEFAULT_PREFERENCES.selectionLineColor,
    ),
    viewportBackground: coerceColor(
      source.viewportBackground,
      DEFAULT_PREFERENCES.viewportBackground,
    ),
    gridScale: coerceNumber(
      source.gridScale,
      MIN_GRID_SCALE,
      MAX_GRID_SCALE,
      DEFAULT_PREFERENCES.gridScale,
    ),
    // Rounded: half a subdivision is a line the grid cannot draw.
    gridSubdivisions: Math.round(
      coerceNumber(
        source.gridSubdivisions,
        MIN_GRID_SUBDIVISIONS,
        MAX_GRID_SUBDIVISIONS,
        DEFAULT_PREFERENCES.gridSubdivisions,
      ),
    ),
    lockVerticalOrbit: coerceBoolean(
      source.lockVerticalOrbit,
      DEFAULT_PREFERENCES.lockVerticalOrbit,
    ),
    wheelZoom: source.wheelZoom === 'centred' ? 'centred' : DEFAULT_PREFERENCES.wheelZoom,
    snapEnabled: coerceBoolean(source.snapEnabled, DEFAULT_PREFERENCES.snapEnabled),
    snapMode: source.snapMode === 'custom' ? 'custom' : DEFAULT_PREFERENCES.snapMode,
    snapStep: coerceNumber(
      source.snapStep,
      MIN_SNAP_STEP,
      MAX_SNAP_STEP,
      DEFAULT_PREFERENCES.snapStep,
    ),
    // Rounded: half a step is not a state anything can be restored to.
    historySize: Math.round(
      coerceNumber(
        source.historySize,
        MIN_HISTORY_SIZE,
        MAX_HISTORY_SIZE,
        DEFAULT_PREFERENCES.historySize,
      ),
    ),
    autosaveEnabled: coerceBoolean(source.autosaveEnabled, DEFAULT_PREFERENCES.autosaveEnabled),
    // One of the offered figures or the default: an interval read off a
    // hand-edited file has to be one the picker can show back.
    autosaveInterval: (AUTOSAVE_INTERVALS as readonly number[]).includes(
      Number(source.autosaveInterval),
    )
      ? Number(source.autosaveInterval)
      : DEFAULT_PREFERENCES.autosaveInterval,
    gridColor: coerceColor(source.gridColor, DEFAULT_PREFERENCES.gridColor),
    gridOpacity: coerceNumber(source.gridOpacity, 0, 1, DEFAULT_PREFERENCES.gridOpacity),
    gridMajorColor: coerceColor(source.gridMajorColor, DEFAULT_PREFERENCES.gridMajorColor),
    gridMajorOpacity: coerceNumber(
      source.gridMajorOpacity,
      0,
      1,
      DEFAULT_PREFERENCES.gridMajorOpacity,
    ),
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
    // Re-capped as the figure changes rather than at the next edit, so lowering
    // it hands the memory back while the user is still looking at the slider.
    get().setHistoryLimit(next.historySize);
    // A hint already on screen would otherwise hang there once tooltips go off.
    set(next.tooltipsEnabled ? { ...next } : { ...next, hint: null });
  };

  return {
    ...readPreferences(),

    setPreferences: (patch) =>
      apply(coercePreferences({ ...get().currentPreferences(), ...patch })),

    resetPreferences: () => apply({ ...DEFAULT_PREFERENCES }),

    currentPreferences: () => {
      const {
        tooltipsEnabled,
        panels,
        selectionLineWidth,
        selectionLineColor,
        viewportBackground,
        lockVerticalOrbit,
        wheelZoom,
        gridScale,
        gridSubdivisions,
        snapEnabled,
        snapMode,
        snapStep,
        historySize,
        autosaveEnabled,
        autosaveInterval,
        gridColor,
        gridOpacity,
        gridMajorColor,
        gridMajorOpacity,
      } = get();
      return {
        tooltipsEnabled,
        panels,
        selectionLineWidth,
        selectionLineColor,
        viewportBackground,
        lockVerticalOrbit,
        wheelZoom,
        gridScale,
        gridSubdivisions,
        snapEnabled,
        snapMode,
        snapStep,
        historySize,
        autosaveEnabled,
        autosaveInterval,
        gridColor,
        gridOpacity,
        gridMajorColor,
        gridMajorOpacity,
      };
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
