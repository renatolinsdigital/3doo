import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_ENTRIES } from '@domain/scripting/reference';

import { App } from './App';
import { moduleForPath } from './modules';
import { primeModules } from '../tests/primeModules';

// The modeling module mounts the real viewport, which needs a WebGL context
// jsdom does not provide. Only the Three.js entry point is stubbed; the rest of
// the module is real, since the corner axis widget reads its frame channel
// from here.
vi.mock('@viewport/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@viewport/index')>()),
  Viewport: class {
    resize() {}
    dispose() {}
  },
}));

function go(path: string) {
  window.history.pushState(null, '', path);
}

describe('module routing', () => {
  beforeAll(async () => {
    await primeModules(['/', '/docs', '/modeling']);
  }, 30000);

  beforeEach(() => {
    go('/');
  });

  it('lands on home at the root', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: /REAL MODELING/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^3DOO - HOME, switch module/ })).toBeInTheDocument();
  });

  it('credits the developer with a LinkedIn link that opens in a new tab', () => {
    render(<App />);

    const credit = screen.getByRole('link', { name: 'Renato Lins' });

    expect(credit).toHaveAttribute('href', 'https://www.linkedin.com/in/renatolinsdigital/');
    expect(credit).toHaveAttribute('target', '_blank');
    // Without noopener the opened tab gets a handle on this one through
    // `window.opener`.
    expect(credit).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('opens the editor at /modeling and the docs at /docs', () => {
    go('/modeling');
    const editor = render(<App />);
    expect(screen.getByRole('region', { name: 'OUTLINER' })).toBeInTheDocument();
    editor.unmount();

    go('/docs');
    render(<App />);
    expect(screen.getByRole('navigation', { name: 'Documentation' })).toBeInTheDocument();
  });

  it('names the module in the brand plate', () => {
    go('/docs');
    render(<App />);

    expect(screen.getByRole('button', { name: /3DOO - DOCS/ })).toBeInTheDocument();
  });

  it('switches module from the brand plate', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: /switch module/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /DOCS/ }));

    expect(window.location.pathname).toBe('/docs');
    expect(screen.getByRole('navigation', { name: 'Documentation' })).toBeInTheDocument();
  });

  it('closes the switcher on Escape without navigating', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: /switch module/ }));
    expect(screen.getByRole('menu', { name: 'Modules' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu', { name: 'Modules' })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  it('falls back to home for a path no module claims', () => {
    // Matched on a segment boundary, so a path that merely starts with a
    // module's name is not that module.
    expect(moduleForPath('/modelling-guide').id).toBe('home');
    expect(moduleForPath('/nope').id).toBe('home');
    expect(moduleForPath('/docs/selecting').id).toBe('docs');
  });
});

describe('docs module', () => {
  beforeEach(() => {
    go('/docs');
  });

  it('shows the first section and navigates to another from the left menu', async () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'GETTING STARTED' })).toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: 'Documentation' });
    await userEvent.click(within(nav).getByRole('button', { name: /MODIFIERS/ }));

    expect(screen.getByRole('heading', { name: 'MODIFIERS' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#modifiers');
  });

  it('opens the section named by the fragment', () => {
    go('/docs#shortcuts');
    render(<App />);

    expect(screen.getByRole('heading', { name: 'KEYBOARD SHORTCUTS' })).toBeInTheDocument();
    // Built from the live keymap rather than transcribed, so the editor's own
    // bindings are what show up here.
    expect(screen.getByRole('row', { name: /Ctrl \+ R.*Loop cut/ })).toBeInTheDocument();
  });

  it('lands on the row a link names, marked, and keeps it in the address', () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    go('/docs#scripting/mesh.extrude');
    render(<App />);

    expect(screen.getByRole('heading', { name: 'SCRIPTING' })).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /^mesh\.extrude\(/ });
    expect(row).toHaveAttribute('id', 'docs-mesh.extrude');
    expect(row).toHaveClass('docs__row--target');
    expect(scrolled).toHaveBeenCalled();
    expect(window.location.hash).toBe('#scripting/mesh.extrude');
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('documents every name the script editor knows, each on a row of its own', () => {
    go('/docs#scripting');
    const { container } = render(<App />);

    for (const entry of API_ENTRIES) {
      expect(container.querySelector(`[id="docs-${entry.id}"]`), entry.id).not.toBeNull();
    }
  });

  it('searches every section and cuts tables down to the rows that matched', async () => {
    render(<App />);

    await userEvent.type(screen.getByRole('textbox', { name: /Search/ }), 'slide');

    // The operation, its shortcut and the note that goes with it, gathered out
    // of a section the reader would otherwise have to know to open.
    expect(screen.getByRole('row', { name: /Slide .*vertex select/ })).toBeInTheDocument();
    expect(screen.getByText(/the mouse carries the distance/)).toBeInTheDocument();
    // Cut to the rows that matched: its neighbour in the same table is gone.
    expect(screen.queryByRole('row', { name: /Chamfers the selected edges/ })).toBeNull();
  });

  it('opens a section from its search result and clears the query', async () => {
    render(<App />);

    await userEvent.type(screen.getByRole('textbox', { name: /Search/ }), 'remesh');
    await userEvent.click(screen.getByRole('button', { name: /MODIFIERS.*OPEN/ }));

    expect(screen.getByRole('heading', { name: 'MODIFIERS' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Search/ })).toHaveValue('');
  });

  it('says so when nothing matches', async () => {
    render(<App />);

    await userEvent.type(screen.getByRole('textbox', { name: /Search/ }), 'zzzz');

    expect(screen.getByRole('heading', { name: 'NO MATCHES' })).toBeInTheDocument();
  });
});
