import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = '3doo:tooltips-enabled';

/**
 * The tooltip preference is read once, when the store module first evaluates.
 * `resetModules` plus a dynamic import gives each test a fresh store, which is
 * the only way to exercise that read path deterministically.
 */
describe('tooltip preferences', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to enabled when nothing is stored', async () => {
    const { useEditorStore } = await import('../useEditorStore');
    expect(useEditorStore.getState().tooltipsEnabled).toBe(true);
  });

  it('reads a previously stored preference on load', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'false');
    const { useEditorStore } = await import('../useEditorStore');
    expect(useEditorStore.getState().tooltipsEnabled).toBe(false);
  });

  it('persists a change to localStorage', async () => {
    const { useEditorStore } = await import('../useEditorStore');
    useEditorStore.getState().setTooltipsEnabled(false);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('false');
    expect(useEditorStore.getState().tooltipsEnabled).toBe(false);
  });

  it('clears any visible hint the moment tooltips are turned off', async () => {
    const { useEditorStore } = await import('../useEditorStore');
    useEditorStore.setState({ hint: { text: 'hi', x: 0, y: 0 } });

    useEditorStore.getState().setTooltipsEnabled(false);

    expect(useEditorStore.getState().hint).toBeNull();
  });

  it('ignores showHint while tooltips are disabled', async () => {
    const { useEditorStore } = await import('../useEditorStore');
    useEditorStore.getState().setTooltipsEnabled(false);

    useEditorStore.getState().showHint('hi', { left: 0, top: 0, bottom: 0 });

    expect(useEditorStore.getState().hint).toBeNull();
  });

  it('shows a hint positioned under the anchor once tooltips are re-enabled', async () => {
    const { useEditorStore } = await import('../useEditorStore');
    useEditorStore.getState().showHint('Extrude', { left: 10, top: 20, bottom: 40 });

    expect(useEditorStore.getState().hint).toEqual({ text: 'Extrude', x: 10, y: 40 });
  });
});
