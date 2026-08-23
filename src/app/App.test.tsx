import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import { App } from './App';

// The real viewport needs a WebGL context, which jsdom does not provide. Only
// the Three.js entry point is stubbed; every panel below is the real component.
vi.mock('@viewport/index', () => ({
  Viewport: class {
    resize() {}
    dispose() {}
  },
}));

describe('App shell', () => {
  beforeEach(() => {
    useEditorStore.getState().resetScene();
  });

  it('renders the full brutalist layout', () => {
    render(<App />);

    expect(screen.getByText('3DOO')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Editor mode' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'OUTLINER' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'PROPERTIES' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'MODIFIERS' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'ADD / SCENE' })).toBeInTheDocument();
  });

  it('adds a primitive from the add panel and shows it everywhere', async () => {
    render(<App />);

    const addPanel = screen.getByRole('region', { name: 'ADD / SCENE' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));

    expect(useEditorStore.getState().objects).toHaveLength(1);
    const outliner = screen.getByRole('region', { name: 'OUTLINER' });
    expect(within(outliner).getByRole('button', { name: 'BOX' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Added BOX');
  });

  it('swaps the left panel when entering edit mode', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD / SCENE' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));

    expect(screen.queryByRole('region', { name: 'OPERATIONS' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));

    expect(screen.getByRole('region', { name: 'OPERATIONS' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'SELECT / VIEW' })).toBeInTheDocument();
  });

  it('runs a modelling operation end to end through the UI', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD / SCENE' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));
    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));

    // Select everything, then extrude from the operations panel.
    const mesh = useEditorStore.getState().objects[0].mesh;
    for (const face of mesh.faces.values()) face.selected = true;
    mesh.flushSelection('face');

    const operations = screen.getByRole('region', { name: 'OPERATIONS' });
    await userEvent.click(within(operations).getByRole('button', { name: 'SUBDIVIDE' }));

    expect(useEditorStore.getState().objects[0].mesh.faces.size).toBe(24);
    expect(screen.getByRole('status')).toHaveTextContent('Subdivided');
  });

  it('undoes from the top bar', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD / SCENE' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));
    expect(useEditorStore.getState().objects).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'UNDO' }));

    expect(useEditorStore.getState().objects).toHaveLength(0);
  });

  it('opens the export dialog with its presets', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'EXPORT' }));

    const dialog = screen.getByRole('dialog', { name: 'EXPORT' });
    expect(within(dialog).getByLabelText('PRESET')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'EXPORT FBX' })).toBeInTheDocument();
  });

  it('opens the shortcut overlay', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: '?' }));

    const dialog = screen.getByRole('dialog', { name: 'KEYBOARD SHORTCUTS' });
    expect(within(dialog).getByText('Extrude')).toBeInTheDocument();
  });

  it('adds a modifier and renders it in the stack', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD / SCENE' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));

    const modifiers = screen.getByRole('region', { name: 'MODIFIERS' });
    expect(within(modifiers).getByText(/Stack is empty/i)).toBeInTheDocument();

    await userEvent.selectOptions(within(modifiers).getByLabelText('Add modifier'), 'mirror');

    expect(useEditorStore.getState().objects[0].modifiers).toHaveLength(1);
    // The modifier stack is non-destructive, so the base mesh is untouched.
    expect(useEditorStore.getState().objects[0].mesh.faces.size).toBe(6);

    // Query the rendered stack entry, not the <option> of the same name.
    expect(within(modifiers).queryByText(/Stack is empty/i)).not.toBeInTheDocument();
    expect(
      within(modifiers).getByRole('button', { name: 'Remove MIRROR' }),
    ).toBeInTheDocument();
    // Role query, not getByLabelText: the label also holds the checked glyph.
    expect(within(modifiers).getByRole('checkbox', { name: 'AXIS X' })).toBeChecked();
  });

  it('removes a modifier from the stack', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD / SCENE' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));

    const modifiers = screen.getByRole('region', { name: 'MODIFIERS' });
    await userEvent.selectOptions(within(modifiers).getByLabelText('Add modifier'), 'array');
    await userEvent.click(within(modifiers).getByRole('button', { name: 'Remove ARRAY' }));

    expect(useEditorStore.getState().objects[0].modifiers).toHaveLength(0);
    expect(within(modifiers).getByText(/Stack is empty/i)).toBeInTheDocument();
  });
});
