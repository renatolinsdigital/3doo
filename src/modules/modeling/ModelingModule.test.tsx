import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@app/App';
import { setOpeningSceneDone } from '@domain/hooks/useAutosave';
import { COMPACT_LAYOUT, NARROW_LAYOUT, TOUCH_FIRST } from '@shared/hooks/useMediaQuery';
import { DEFAULT_PREFERENCES, useEditorStore } from '@store/index';
import { mockMatchMedia } from '@/tests/matchMedia';
import { primeModules } from '@/tests/primeModules';

// The viewport needs WebGL, which jsdom does not have. See `App.test.tsx`.
vi.mock('@viewport/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@viewport/index')>()),
  Viewport: class {
    resize() {}
    dispose() {}
  },
}));

const shell = () => document.querySelector('.modeling-shell') as HTMLElement;

describe('ModelingModule on phones and tablets', () => {
  let restore: (() => void) | null = null;

  beforeAll(async () => {
    setOpeningSceneDone(true);
    await primeModules(['/modeling']);
  }, 30000);

  beforeEach(() => {
    window.history.pushState(null, '', '/modeling');
    setOpeningSceneDone(true);
    useEditorStore.getState().resetScene();
    useEditorStore.setState({ panels: DEFAULT_PREFERENCES.panels, toasts: [], hint: null });
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('keeps the desktop as it was: no quick bar, the columns in place', () => {
    render(<App />);

    expect(screen.queryByRole('navigation', { name: 'Quick actions' })).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Tool panels' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Scene panels' })).toBeInTheDocument();
  });

  it('starts a phone with both drawers shut, and keeps only one out at a time', async () => {
    restore = mockMatchMedia([COMPACT_LAYOUT, NARROW_LAYOUT, TOUCH_FIRST]);
    render(<App />);

    const tools = screen.getByRole('button', { name: 'TOOLS' });
    const scene = screen.getByRole('button', { name: 'SCENE' });
    expect(tools).toHaveAttribute('aria-expanded', 'false');
    expect(scene).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(tools);
    expect(shell()).toHaveClass('modeling-shell--tools-open');

    await userEvent.click(scene);
    expect(shell()).toHaveClass('modeling-shell--scene-open');
    expect(shell()).not.toHaveClass('modeling-shell--tools-open');
    expect(tools).toHaveAttribute('aria-expanded', 'false');

    // The keys a hand without a keyboard cannot press are there too.
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('starts a tablet with the scene drawer out, as the layout was before', async () => {
    restore = mockMatchMedia([COMPACT_LAYOUT]);
    render(<App />);

    expect(screen.getByRole('button', { name: 'SCENE' })).toHaveAttribute('aria-expanded', 'true');
    // Room for both beside each other, so opening one leaves the other.
    await userEvent.click(screen.getByRole('button', { name: 'TOOLS' }));
    expect(shell()).toHaveClass('modeling-shell--tools-open', 'modeling-shell--scene-open');
    // A mouse on a narrow window has its keyboard: no stand-ins for it.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('names the editor and tells a screen reader how the viewport is steered', () => {
    render(<App />);

    expect(screen.getByRole('main')).toBeInTheDocument();
    const viewport = screen.getByRole('region', { name: 'Viewport' });
    expect(viewport).toHaveAccessibleDescription(/pinch to zoom/i);
  });
});
