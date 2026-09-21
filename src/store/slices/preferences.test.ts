import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES, coercePreferences } from './preferences';

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

  it('rounds a subdivision count to a line the grid can actually draw', () => {
    expect(coercePreferences({ gridSubdivisions: 4.6 }).gridSubdivisions).toBe(5);
  });

  it('rejects a grid colour that is not #rrggbb', () => {
    expect(coercePreferences({ gridColor: 'grey' }).gridColor).toBe(DEFAULT_PREFERENCES.gridColor);
    expect(coercePreferences({ gridMajorColor: '#B8452F' }).gridMajorColor).toBe('#b8452f');
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
