import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PREFERENCES,
  MAX_HISTORY_SIZE,
  MAX_ORBIT_SPEED,
  MAX_SNAP_ROTATION,
  MAX_WHEEL_ZOOM_STEP,
  MIN_HISTORY_SIZE,
  MIN_ORBIT_SPEED,
  MIN_SNAP_STEP,
  MIN_WHEEL_ZOOM_STEP,
  autosaveIntervalLabel,
  coercePreferences,
  snapLabel,
} from './preferences';

const STORAGE_KEY = '3doo:preferences';

/**
 * Preferences are read once, when the store module first evaluates.
 * `resetModules` plus a dynamic import gives each test a fresh store, which is
 * the only way to exercise that read path deterministically.
 */
async function freshStore() {
  const { useEditorStore } = await import('../useEditorStore');
  return useEditorStore;
}

describe('preference storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('starts from the defaults when nothing is stored', async () => {
    const store = await freshStore();
    expect(store.getState().currentPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('reads a previously stored set on load', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tooltipsEnabled: false,
        selectionLineWidth: 6,
        selectionLineColor: '#3de0d0',
      }),
    );

    const store = await freshStore();

    expect(store.getState().currentPreferences()).toEqual({
      ...DEFAULT_PREFERENCES,
      tooltipsEnabled: false,
      selectionLineWidth: 6,
      selectionLineColor: '#3de0d0',
    });
  });

  it('falls back to the defaults when the stored blob is unreadable', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'not json');

    const store = await freshStore();

    expect(store.getState().currentPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('persists a change straight away', async () => {
    const store = await freshStore();

    store.getState().setPreferences({ selectionLineWidth: 4 });

    expect(store.getState().selectionLineWidth).toBe(4);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}').selectionLineWidth).toBe(4);
  });

  it('starts with autosave off, set to every three minutes once it is on', async () => {
    const store = await freshStore();

    expect(store.getState().autosaveEnabled).toBe(false);
    expect(store.getState().autosaveInterval).toBe(180);
  });

  it('remembers autosave being switched on, across a reload', async () => {
    const store = await freshStore();

    store.getState().setPreferences({ autosaveEnabled: true });
    vi.resetModules();

    const reloaded = await freshStore();
    expect(reloaded.getState().autosaveEnabled).toBe(true);
  });

  it('remembers dark mode across a reload', async () => {
    const store = await freshStore();

    store.getState().setPreferences({ theme: 'dark' });
    vi.resetModules();

    const reloaded = await freshStore();
    expect(reloaded.getState().theme).toBe('dark');
  });

  it('puts everything back on reset', async () => {
    const store = await freshStore();
    store.getState().setPreferences({ selectionLineWidth: 7, selectionLineColor: '#000000' });

    store.getState().resetPreferences();

    expect(store.getState().currentPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('coercePreferences', () => {
  it('keeps the defaults for anything missing', () => {
    expect(coercePreferences({ selectionLineWidth: 3 })).toEqual({
      ...DEFAULT_PREFERENCES,
      selectionLineWidth: 3,
    });
  });

  it('clamps a width that would render as a hairline or a slab', () => {
    expect(coercePreferences({ selectionLineWidth: 0 }).selectionLineWidth).toBe(1);
    expect(coercePreferences({ selectionLineWidth: 999 }).selectionLineWidth).toBe(8);
  });

  it('rejects a background colour that is not #rrggbb', () => {
    expect(coercePreferences({ viewportBackground: 'black' }).viewportBackground).toBe(
      DEFAULT_PREFERENCES.viewportBackground,
    );
    expect(coercePreferences({ viewportBackground: '#0B0B0B' }).viewportBackground).toBe('#0b0b0b');
  });

  it('rejects a colour that is not #rrggbb', () => {
    expect(coercePreferences({ selectionLineColor: 'red' }).selectionLineColor).toBe(
      DEFAULT_PREFERENCES.selectionLineColor,
    );
    expect(coercePreferences({ selectionLineColor: '#3DE0D0' }).selectionLineColor).toBe('#3de0d0');
  });

  it('clamps grid values that would leave no grid to look at', () => {
    expect(coercePreferences({ gridScale: 0 }).gridScale).toBe(0.001);
    expect(coercePreferences({ gridScale: 1e9 }).gridScale).toBe(1000);
    expect(coercePreferences({ gridSubdivisions: 0 }).gridSubdivisions).toBe(1);
    expect(coercePreferences({ gridSubdivisions: 5000 }).gridSubdivisions).toBe(100);
    expect(coercePreferences({ gridOpacity: -1 }).gridOpacity).toBe(0);
    expect(coercePreferences({ gridMajorOpacity: 5 }).gridMajorOpacity).toBe(1);
  });

  it('keeps a snap step each for location, rotation and scale, inside their ranges', () => {
    expect(DEFAULT_PREFERENCES).toMatchObject({
      snapLocation: 0.1,
      snapRotation: 15,
      snapScale: 0.1,
    });
    expect(
      coercePreferences({ snapLocation: 0.25, snapRotation: 30, snapScale: 0.5 }),
    ).toMatchObject({ snapLocation: 0.25, snapRotation: 30, snapScale: 0.5 });

    // A step of nothing would pin every transform where it stands.
    expect(coercePreferences({ snapLocation: 0 }).snapLocation).toBe(MIN_SNAP_STEP);
    expect(coercePreferences({ snapScale: -2 }).snapScale).toBe(MIN_SNAP_STEP);
    expect(coercePreferences({ snapRotation: 0 }).snapRotation).toBe(MIN_SNAP_STEP);
    expect(coercePreferences({ snapRotation: 720 }).snapRotation).toBe(MAX_SNAP_ROTATION);
  });

  it('carries the one step an older build saved over as the location step', () => {
    // It was a multiple of the grid scale, so 0.055 of a two metre square is
    // 0.11 m. Dropping it with the key would cost the figure somebody typed.
    expect(coercePreferences({ snapStep: 0.055, gridScale: 2 }).snapLocation).toBeCloseTo(0.11);
    expect(coercePreferences({ snapStep: 'lots' }).snapLocation).toBe(
      DEFAULT_PREFERENCES.snapLocation,
    );
    expect(coercePreferences({ snapStep: 0.055, snapLocation: 0.2 }).snapLocation).toBe(0.2);
  });

  it('names the snap in force for the status bar', () => {
    const custom = { snapLocation: 0.25, snapRotation: 30, snapScale: 0.5 };

    expect(snapLabel({ snapMode: 'grid', ...custom })).toBe('GRID');
    // All three whichever is picked: a move still uses the location step while
    // the list is showing the rotation.
    for (const snapMode of ['location', 'rotation', 'scale'] as const) {
      expect(snapLabel({ snapMode, ...custom })).toBe('0.25 M / 30° / 0.5 M');
    }
  });

  it('takes a step the picker offers, and reads an older CUSTOM as the first of them', () => {
    for (const snapMode of ['grid', 'location', 'rotation', 'scale']) {
      expect(coercePreferences({ snapMode }).snapMode).toBe(snapMode);
    }
    // Falling back to the default would have switched somebody's own steps off.
    expect(coercePreferences({ snapMode: 'custom' }).snapMode).toBe('location');
    expect(coercePreferences({ snapMode: 'sideways' }).snapMode).toBe('grid');
  });

  it('rounds a subdivision count to a line the grid can actually draw', () => {
    expect(coercePreferences({ gridSubdivisions: 4.6 }).gridSubdivisions).toBe(5);
  });

  it('rejects a grid colour that is not #rrggbb', () => {
    expect(coercePreferences({ gridColor: 'grey' }).gridColor).toBe(DEFAULT_PREFERENCES.gridColor);
    expect(coercePreferences({ gridMajorColor: '#B8452F' }).gridMajorColor).toBe('#b8452f');
  });

  it('only takes an autosave interval the picker can show back', () => {
    expect(coercePreferences({ autosaveInterval: 30 }).autosaveInterval).toBe(30);
    expect(coercePreferences({ autosaveInterval: 900 }).autosaveInterval).toBe(900);
    expect(coercePreferences({ autosaveInterval: 47 }).autosaveInterval).toBe(
      DEFAULT_PREFERENCES.autosaveInterval,
    );
    expect(coercePreferences({ autosaveInterval: 'often' }).autosaveInterval).toBe(
      DEFAULT_PREFERENCES.autosaveInterval,
    );
  });

  it('stays light unless told to go dark', () => {
    expect(DEFAULT_PREFERENCES.theme).toBe('light');
    expect(coercePreferences({ theme: 'dark' }).theme).toBe('dark');
    expect(coercePreferences({ theme: 'midnight' }).theme).toBe('light');
  });

  it('follows the pointer with the wheel unless told to zoom centred', () => {
    expect(DEFAULT_PREFERENCES.wheelZoom).toBe('pointer');
    expect(coercePreferences({ wheelZoom: 'centred' }).wheelZoom).toBe('centred');
    expect(coercePreferences({ wheelZoom: 'sideways' }).wheelZoom).toBe('pointer');
  });

  it('keeps the wheel zoom step a whole percent inside its range', () => {
    expect(DEFAULT_PREFERENCES.wheelZoomStep).toBe(5);
    expect(coercePreferences({ wheelZoomStep: 12 }).wheelZoomStep).toBe(12);
    expect(coercePreferences({ wheelZoomStep: 7.6 }).wheelZoomStep).toBe(8);
    expect(coercePreferences({ wheelZoomStep: 0 }).wheelZoomStep).toBe(MIN_WHEEL_ZOOM_STEP);
    expect(coercePreferences({ wheelZoomStep: 90 }).wheelZoomStep).toBe(MAX_WHEEL_ZOOM_STEP);
    expect(coercePreferences({ wheelZoomStep: 'fast' }).wheelZoomStep).toBe(
      DEFAULT_PREFERENCES.wheelZoomStep,
    );
  });

  it('keeps a hundred undo steps by default and takes up to two hundred', () => {
    // A fresh install used to keep fifty, and anything past a hundred was cut
    // back to a hundred, so a long session lost the start of its timeline.
    expect(DEFAULT_PREFERENCES.historySize).toBe(100);
    expect(coercePreferences({ historySize: 200 }).historySize).toBe(200);
    expect(coercePreferences({ historySize: 500 }).historySize).toBe(MAX_HISTORY_SIZE);
    expect(MAX_HISTORY_SIZE).toBe(200);
    expect(coercePreferences({ historySize: 2 }).historySize).toBe(MIN_HISTORY_SIZE);
  });

  it('orbits slower with nothing selected than with a selection by default', () => {
    expect(DEFAULT_PREFERENCES.orbitSpeedSelected).toBe(100);
    expect(DEFAULT_PREFERENCES.orbitSpeedUnselected).toBeLessThan(
      DEFAULT_PREFERENCES.orbitSpeedSelected,
    );
  });

  it('keeps both orbit speeds a whole percent inside their range', () => {
    for (const key of ['orbitSpeedSelected', 'orbitSpeedUnselected'] as const) {
      expect(coercePreferences({ [key]: 45 })[key]).toBe(45);
      expect(coercePreferences({ [key]: 72.4 })[key]).toBe(72);
      expect(coercePreferences({ [key]: 0 })[key]).toBe(MIN_ORBIT_SPEED);
      expect(coercePreferences({ [key]: 900 })[key]).toBe(MAX_ORBIT_SPEED);
      expect(coercePreferences({ [key]: 'slow' })[key]).toBe(DEFAULT_PREFERENCES[key]);
    }
  });

  it('names every interval, thirty seconds to fifteen minutes', () => {
    expect(autosaveIntervalLabel(30)).toBe('30 SECONDS');
    expect(autosaveIntervalLabel(60)).toBe('1 MINUTE');
    expect(autosaveIntervalLabel(180)).toBe('3 MINUTES');
    expect(autosaveIntervalLabel(900)).toBe('15 MINUTES');
  });

  it('does not let one bad value cost the user the rest', () => {
    expect(coercePreferences({ tooltipsEnabled: false, selectionLineWidth: 'wide' })).toEqual({
      ...DEFAULT_PREFERENCES,
      tooltipsEnabled: false,
    });
  });

  it('shows every panel a stored set says nothing about', () => {
    // A build that ships a new panel meets preferences written before it
    // existed. The panel arrives on screen rather than missing.
    expect(coercePreferences({ panels: { outliner: false } }).panels).toEqual({
      ...DEFAULT_PREFERENCES.panels,
      outliner: false,
    });
  });

  it('drops a panel key that is no longer one, and a value that is not a switch', () => {
    const panels = coercePreferences({
      panels: { statusBar: 'off', sidebar: false },
    }).panels;

    expect(panels).toEqual(DEFAULT_PREFERENCES.panels);
    expect('sidebar' in panels).toBe(false);
  });

  it('takes the whole set back when panels is not an object at all', () => {
    expect(coercePreferences({ panels: 'none' }).panels).toEqual(DEFAULT_PREFERENCES.panels);
  });
});

describe('importing a preferences file', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it('round-trips what the export button writes', async () => {
    const store = await freshStore();
    store.getState().setPreferences({
      selectionLineWidth: 5,
      selectionLineColor: '#f2a03d',
      viewportBackground: '#0b0b0b',
    });
    const exported = JSON.stringify(store.getState().currentPreferences());

    store.getState().resetPreferences();
    store.getState().importPreferences(exported);

    expect(store.getState().currentPreferences()).toEqual({
      ...DEFAULT_PREFERENCES,
      selectionLineWidth: 5,
      selectionLineColor: '#f2a03d',
      viewportBackground: '#0b0b0b',
    });
  });

  it('refuses a file that is not preferences, leaving the current set alone', async () => {
    const store = await freshStore();
    store.getState().setPreferences({ selectionLineWidth: 5 });

    expect(() => store.getState().importPreferences('{"objects":[]}')).toThrow(
      'holds no preferences',
    );
    expect(() => store.getState().importPreferences('v 0 0 0')).toThrow('not valid JSON');
    expect(store.getState().selectionLineWidth).toBe(5);
  });
});
