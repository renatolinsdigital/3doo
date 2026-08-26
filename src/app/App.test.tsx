import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    // The editor is a module now, not the whole app, so the tests below have to
    // be standing on its route for it to render at all.
    window.history.pushState(null, '', '/modeling');
    useEditorStore.getState().resetScene();
    useEditorStore.setState({ tooltipsEnabled: true, hint: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the full brutalist layout', () => {
    render(<App />);

    expect(screen.getByRole('button', { name: /3DOO - MODELING/ })).toBeInTheDocument();
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

  it('arms the move tool on the rail when a primitive is added', async () => {
    render(<App />);

    const rail = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(rail).getByRole('button', { name: 'Move' })).not.toHaveAttribute('aria-pressed');

    const addPanel = screen.getByRole('region', { name: 'ADD / SCENE' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));

    // The gizmo only draws for a transform tool, so this is what puts handles
    // on the thing that was just added.
    expect(within(rail).getByRole('button', { name: 'Move' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
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
    expect(within(modifiers).getByText(/Reflects the mesh across a plane/i)).toBeInTheDocument();
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

  it('starts a modal rotation on R, the way Blender does', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD / SCENE' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));

    fireEvent.keyDown(window, { key: 'r' });

    // No handle was grabbed: the keypress alone puts the editor into the turn,
    // which the viewport then drives off the bare pointer.
    expect(useEditorStore.getState().activeTool).toBe('rotate');
    expect(useEditorStore.getState().modal).toMatchObject({ kind: 'rotate', axis: null });
  });

  it('arms the rotate tool but starts no turn when nothing is selected', async () => {
    render(<App />);
    act(() => useEditorStore.getState().setActiveObject(null));

    fireEvent.keyDown(window, { key: 'r' });

    expect(useEditorStore.getState().activeTool).toBe('rotate');
    expect(useEditorStore.getState().modal).toBeNull();
  });

  it('selects all objects when pressing A in object mode', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD / SCENE' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));
    await userEvent.click(within(addPanel).getByRole('button', { name: 'PLANE' }));
    act(() => useEditorStore.getState().setActiveObject(null));
    expect(useEditorStore.getState().selectedObjectIds).toHaveLength(0);

    fireEvent.keyDown(window, { key: 'a' });

    expect(useEditorStore.getState().selectedObjectIds).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('Selected all 2 object(s)');
  });

  it('selects all geometry when pressing A in edit mode', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD / SCENE' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));
    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));

    fireEvent.keyDown(window, { key: 'a' });

    expect(useEditorStore.getState().objects[0].mesh.selectedFaces()).toHaveLength(6);
  });

  it('treats Ctrl+A as a no-op that only suppresses the browser default', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD / SCENE' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));
    act(() => useEditorStore.getState().setActiveObject(null));
    expect(useEditorStore.getState().selectedObjectIds).toHaveLength(0);

    // fireEvent's return value mirrors dispatchEvent: false means preventDefault() ran.
    const notPrevented = fireEvent.keyDown(window, { key: 'a', ctrlKey: true });

    expect(notPrevented).toBe(false);
    expect(useEditorStore.getState().selectedObjectIds).toHaveLength(0);
  });

  it('keeps shortcuts alive while a toggle holds focus, but not in a text field', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD / SCENE' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));
    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));

    // Clicking a toggle leaves its hidden checkbox focused. Read as a field
    // being typed into, that left every shortcut dead until the next click
    // landed somewhere else.
    const enabled = screen.getByRole('checkbox', { name: 'ENABLED' });
    await userEvent.click(enabled);
    expect(useEditorStore.getState().proportional.enabled).toBe(true);

    fireEvent.keyDown(enabled, { key: 'a' });
    expect(useEditorStore.getState().objects[0].mesh.selectedFaces()).toHaveLength(6);

    // The radius field is a real one, and an "a" typed into it stays there.
    act(() => useEditorStore.getState().clearSelection());
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'RADIUS' }), { key: 'a' });
    expect(useEditorStore.getState().objects[0].mesh.selectedFaces()).toHaveLength(0);
  });

  it('shows a hint tooltip after hovering a control, once the delay passes', () => {
    render(<App />);
    const exportButton = screen.getByRole('button', { name: 'EXPORT' });

    vi.useFakeTimers();
    fireEvent.mouseEnter(exportButton);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent(/export the scene/i);

    fireEvent.mouseLeave(exportButton);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('stops showing hint tooltips once disabled from Preferences', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'PREFS' }));
    const dialog = screen.getByRole('dialog', { name: 'PREFERENCES' });
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'SHOW HINT TOOLTIPS' }),
    );
    await userEvent.keyboard('{Escape}');
    expect(useEditorStore.getState().tooltipsEnabled).toBe(false);

    vi.useFakeTimers();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'EXPORT' }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('trembles the Frame All button once the viewport reports the scene is out of view', () => {
    render(<App />);
    const frameAll = screen.getByRole('button', { name: 'FRAME ALL' });
    expect(frameAll.className).not.toMatch(/tremble/);

    act(() => useEditorStore.setState({ viewLost: true }));
    expect(frameAll.className).toMatch(/tremble/);

    act(() => useEditorStore.setState({ viewLost: false }));
    expect(frameAll.className).not.toMatch(/tremble/);
  });

  it('credits the developer in the shortcuts overlay with a LinkedIn link', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: '?' }));

    const dialog = screen.getByRole('dialog', { name: 'KEYBOARD SHORTCUTS' });
    const link = within(dialog).getByRole('link', { name: 'Renato Lins' });

    expect(link).toHaveAttribute('href', 'https://www.linkedin.com/in/renatolinsdigital/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toEqual(expect.stringContaining('noopener'));
  });
});
