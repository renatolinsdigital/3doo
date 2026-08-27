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

  describe('right-click', () => {
    const rightClick = (target: Element) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };

    it('is a no-op over a surface with no menu of its own', () => {
      render(<App />);

      // The status bar answers nothing, so the gesture stops here rather than
      // handing the page's own menu to someone reaching for the editor's.
      expect(rightClick(screen.getByRole('contentinfo')).defaultPrevented).toBe(true);
    });

    it('leaves the native menu to a typing field, where the clipboard lives', () => {
      render(<App />);

      expect(rightClick(screen.getByLabelText('Project name')).defaultPrevented).toBe(false);
    });
  });

  it('renders the full brutalist layout', () => {
    render(<App />);

    expect(screen.getByRole('button', { name: /3DOO - MODELING/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Editor mode' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'OUTLINER' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'PROPERTIES' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'MODIFIERS' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'ADD' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'OBJECT' })).toBeInTheDocument();
  });

  it('adds a primitive from the add panel and shows it everywhere', async () => {
    render(<App />);

    const addPanel = screen.getByRole('region', { name: 'ADD' });
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

    const addPanel = screen.getByRole('region', { name: 'ADD' });
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
    const addPanel = screen.getByRole('region', { name: 'ADD' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));

    expect(screen.queryByRole('region', { name: 'OPERATIONS' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));

    expect(screen.getByRole('region', { name: 'OPERATIONS' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'SELECT' })).toBeInTheDocument();
  });

  it('runs a modelling operation end to end through the UI', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD' });
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

  it('cuts one object out of another from the boolean panel', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD' });

    // Nothing to cut against yet, so the operations say so rather than run.
    const booleans = screen.getByRole('region', { name: 'BOOLEAN' });
    expect(within(booleans).getByRole('button', { name: 'DIFFERENCE' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));
    act(() =>
      useEditorStore.setState((state) => ({
        // The second box overlaps the first by half, and the first is active,
        // so it is the one that keeps the result.
        objects: state.objects.map((object, index) =>
          index === 1
            ? { ...object, transform: { ...object.transform, position: { x: 0.5, y: 0, z: 0 } } }
            : object,
        ),
        selectedObjectIds: state.objects.map((object) => object.id),
        activeObjectId: state.objects[0].id,
      })),
    );

    await userEvent.click(within(booleans).getByRole('button', { name: 'DIFFERENCE' }));

    // The cutter is consumed, and what is left is smaller than the box was.
    expect(useEditorStore.getState().objects).toHaveLength(1);
    const box = useEditorStore.getState().objects[0].mesh.boundingBox();
    expect(box.max.x).toBeCloseTo(0, 5);
    expect(screen.getByRole('status')).toHaveTextContent('Difference');
  });

  it('undoes from the keyboard', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));
    expect(useEditorStore.getState().objects).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

    expect(useEditorStore.getState().objects).toHaveLength(0);
  });

  it('folds a panel away by its title, and keeps it folded in the saved document', async () => {
    render(<App />);

    const outliner = screen.getByRole('region', { name: 'OUTLINER' });
    const title = within(outliner).getByRole('button', { name: 'OUTLINER' });
    expect(title).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(title);

    expect(title).toHaveAttribute('aria-expanded', 'false');
    expect(useEditorStore.getState().snapshotDocument().panels).toEqual({ OUTLINER: true });
  });

  it('opens the export dialog with its presets from the file menu', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'FILE' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'EXPORT' }));

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
    const addPanel = screen.getByRole('region', { name: 'ADD' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));

    const modifiers = screen.getByRole('region', { name: 'MODIFIERS' });
    expect(within(modifiers).getByText(/Stack is empty/i)).toBeInTheDocument();

    await userEvent.selectOptions(within(modifiers).getByLabelText('Add modifier'), 'mirror');

    expect(useEditorStore.getState().objects[0].modifiers).toHaveLength(1);
    // The modifier stack is non-destructive, so the base mesh is untouched.
    expect(useEditorStore.getState().objects[0].mesh.faces.size).toBe(6);

    // Query the rendered stack entry, not the <option> of the same name.
    expect(within(modifiers).queryByText(/Stack is empty/i)).not.toBeInTheDocument();
    expect(within(modifiers).getByRole('button', { name: 'Remove MIRROR' })).toBeInTheDocument();
    // Role query, not getByLabelText: the label also holds the checked glyph.
    expect(within(modifiers).getByRole('checkbox', { name: 'AXIS X' })).toBeChecked();
    expect(within(modifiers).getByText(/Reflects the mesh across a plane/i)).toBeInTheDocument();
  });

  it('removes a modifier from the stack', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));

    const modifiers = screen.getByRole('region', { name: 'MODIFIERS' });
    await userEvent.selectOptions(within(modifiers).getByLabelText('Add modifier'), 'array');
    await userEvent.click(within(modifiers).getByRole('button', { name: 'Remove ARRAY' }));

    expect(useEditorStore.getState().objects[0].modifiers).toHaveLength(0);
    expect(within(modifiers).getByText(/Stack is empty/i)).toBeInTheDocument();
  });

  it('starts a modal rotation on R, the way Blender does', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD' });
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
    const addPanel = screen.getByRole('region', { name: 'ADD' });
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
    const addPanel = screen.getByRole('region', { name: 'ADD' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));
    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));

    fireEvent.keyDown(window, { key: 'a' });

    expect(useEditorStore.getState().objects[0].mesh.selectedFaces()).toHaveLength(6);
  });

  it('treats Ctrl+A as a no-op that only suppresses the browser default', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD' });
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
    const addPanel = screen.getByRole('region', { name: 'ADD' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));
    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));

    // Clicking a toggle leaves its hidden checkbox focused. Read as a field
    // being typed into, that left every shortcut dead until the next click
    // landed somewhere else.
    const toggle = screen.getByRole('checkbox', { name: 'INDIVIDUAL' });
    await userEvent.click(toggle);
    expect(toggle).toBeChecked();

    fireEvent.keyDown(toggle, { key: 'a' });
    expect(useEditorStore.getState().objects[0].mesh.selectedFaces()).toHaveLength(6);

    // The radius field is a real one, and an "a" typed into it stays there.
    act(() => useEditorStore.getState().clearSelection());
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'RADIUS' }), { key: 'a' });
    expect(useEditorStore.getState().objects[0].mesh.selectedFaces()).toHaveLength(0);
  });

  it('flips proportional editing from the top bar, and only in edit mode', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'ADD' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));

    const prop = screen.getByRole('button', { name: 'PROP' });
    expect(prop).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(prop);
    expect(useEditorStore.getState().proportional.enabled).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));
    await userEvent.click(screen.getByRole('button', { name: 'PROP' }));

    expect(useEditorStore.getState().proportional.enabled).toBe(true);
    expect(screen.getByRole('button', { name: 'PROP' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('ticks overlays from the top bar menu, which stays open across them', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'OVERLAYS' }));
    const grid = screen.getByRole('menuitemcheckbox', { name: 'GRID' });
    expect(grid).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(grid);
    expect(useEditorStore.getState().overlays.grid).toBe(false);

    // Still up, so a run of boxes can be set without reopening it each time.
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'NORMALS' }));
    expect(useEditorStore.getState().overlays.normals).toBe(true);
    expect(screen.getByRole('menuitemcheckbox', { name: 'GRID' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('switches the transform pivot from the top bar', async () => {
    render(<App />);
    const pivot = screen.getByRole('group', { name: 'Pivot' });
    expect(within(pivot).getByRole('button', { name: 'MEDIAN' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(within(pivot).getByRole('button', { name: 'CURSOR' }));

    expect(useEditorStore.getState().pivot).toBe('cursor');
  });

  it('asks the viewport to frame from the top bar buttons', async () => {
    render(<App />);

    // The glyphs are decoration, so the label is the only thing naming these.
    await userEvent.click(screen.getByRole('button', { name: 'FRAME SEL' }));
    expect(useEditorStore.getState().frameRequest).toMatchObject({ target: 'selected' });

    await userEvent.click(screen.getByRole('button', { name: 'FRAME ALL' }));
    expect(useEditorStore.getState().frameRequest).toMatchObject({ target: 'all' });
  });

  it('picks a shading mode from the top bar menu', async () => {
    render(<App />);

    // The trigger wears the mode in force, so it is named by the value it holds.
    await userEvent.click(screen.getByRole('button', { name: 'Shading: SOLID + WIRE' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'X-RAY' }));

    expect(useEditorStore.getState().shading).toBe('xray');
    expect(screen.getByRole('button', { name: 'Shading: X-RAY' })).toBeInTheDocument();
  });

  it('flips the orthographic camera from the top bar', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'ORTHO' }));

    expect(useEditorStore.getState().orthographic).toBe(true);
  });

  it('shades the active object smooth from the top bar, and back', async () => {
    render(<App />);
    const smooth = screen.getByRole('button', { name: 'SMOOTH' });

    // Nothing selected, nothing to shade.
    expect(smooth).toHaveAttribute('aria-disabled', 'true');
    expect(smooth).toHaveAttribute('aria-pressed', 'false');

    const addPanel = screen.getByRole('region', { name: 'ADD' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'BOX' }));

    const faces = () => [...useEditorStore.getState().objects[0].mesh.faces.values()];
    expect(faces().every((face) => face.smooth)).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'SMOOTH' }));
    expect(faces().every((face) => face.smooth)).toBe(true);
    expect(screen.getByRole('button', { name: 'SMOOTH' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'SMOOTH' }));
    expect(faces().some((face) => face.smooth)).toBe(false);
    expect(screen.getByRole('button', { name: 'SMOOTH' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows a hint tooltip after hovering a control, once the delay passes', () => {
    render(<App />);
    const fileButton = screen.getByRole('button', { name: 'FILE' });

    vi.useFakeTimers();
    fireEvent.mouseEnter(fileButton);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent(/project files/i);

    fireEvent.mouseLeave(fileButton);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('stops showing hint tooltips once disabled from Preferences', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'PREFS' }));
    const dialog = screen.getByRole('dialog', { name: 'PREFERENCES' });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'SHOW HINT TOOLTIPS' }));
    await userEvent.keyboard('{Escape}');
    expect(useEditorStore.getState().tooltipsEnabled).toBe(false);

    vi.useFakeTimers();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'FILE' }));
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
