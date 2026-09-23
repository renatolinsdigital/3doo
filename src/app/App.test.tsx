import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setOpeningSceneDone } from '@domain/hooks/useAutosave';
import { DEFAULT_PREFERENCES, useEditorStore } from '@store/index';

import { App } from './App';

// The real viewport needs a WebGL context, which jsdom does not provide. Only
// the Three.js entry point is stubbed; every panel below is the real component,
// and the rest of the module is real too, since the corner axis widget reads
// its frame channel from here.
vi.mock('@viewport/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@viewport/index')>()),
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
    // Every test below builds the scene it needs. The cube a fresh tab opens
    // on would arrive a microtask after the render and land in the middle of
    // one of them; `useAutosave.test.tsx` is where that is tested instead.
    setOpeningSceneDone(true);
    useEditorStore.getState().resetScene();
    useEditorStore.setState({
      tooltipsEnabled: true,
      hint: null,
      panels: DEFAULT_PREFERENCES.panels,
      // A toast left up by one test is a second role="status" in the next one.
      toasts: [],
    });
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
    expect(screen.getByRole('navigation', { name: 'Tool rail' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'OUTLINER' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'PROPERTIES' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'MODIFIERS' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'PRIMITIVES' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'OBJECT' })).toBeInTheDocument();
  });

  it('adds a primitive from the add panel and shows it everywhere', async () => {
    render(<App />);

    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));

    expect(useEditorStore.getState().objects).toHaveLength(1);
    const outliner = screen.getByRole('region', { name: 'OUTLINER' });
    expect(within(outliner).getByRole('button', { name: 'CUBE' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Added CUBE');
  });

  it('arms the move tool on the rail when a primitive is added', async () => {
    render(<App />);

    const rail = screen.getByRole('navigation', { name: 'Tool rail' });
    expect(within(rail).getByRole('button', { name: 'Move' })).not.toHaveAttribute('aria-pressed');

    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));

    // The gizmo only draws for a transform tool, so this is what puts handles
    // on the thing that was just added.
    expect(within(rail).getByRole('button', { name: 'Move' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('swaps the left panel when entering edit mode', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));

    expect(screen.queryByRole('region', { name: 'OPERATIONS' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));

    expect(screen.getByRole('region', { name: 'OPERATIONS' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'SELECT' })).toBeInTheDocument();
  });

  it('runs a modelling operation end to end through the UI', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));
    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));

    // Select everything, then subdivide from the loop operations panel.
    const mesh = useEditorStore.getState().objects[0].mesh;
    for (const face of mesh.faces.values()) face.selected = true;
    mesh.flushSelection('face');

    const operations = screen.getByRole('region', { name: 'LOOP OPERATIONS' });
    await userEvent.click(within(operations).getByRole('button', { name: 'SUBDIVIDE' }));

    expect(useEditorStore.getState().objects[0].mesh.faces.size).toBe(24);
    expect(screen.getByRole('status')).toHaveTextContent('Subdivided');
  });

  it('cuts one object out of another from the boolean panel', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });

    // Nothing to cut against yet, so the operations say so rather than run.
    const booleans = screen.getByRole('region', { name: 'BOOLEAN' });
    expect(within(booleans).getByRole('button', { name: 'DIFFERENCE' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));
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
    // The origin follows the cut onto the middle of the half that survived, so
    // the far edge is read in world space.
    expect(useEditorStore.getState().objects).toHaveLength(1);
    const cut = useEditorStore.getState().objects[0];
    const box = cut.mesh.boundingBox();
    expect(cut.transform.position.x + box.max.x).toBeCloseTo(0, 5);
    expect(screen.getByRole('status')).toHaveTextContent('Difference');
  });

  it('undoes from the keyboard', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));
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

  it('asks before a new project throws the autosaved one away', async () => {
    render(<App />);
    act(() => useEditorStore.getState().addPrimitive('torus'));

    await userEvent.click(screen.getByRole('button', { name: 'FILE' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'NEW' }));

    const dialog = screen.getByRole('dialog', { name: 'START A NEW PROJECT' });
    expect(
      within(dialog).getByText('Auto-saved data will be lost. Save this project to a file first?'),
    ).toBeInTheDocument();
    // Still there: asking is not doing.
    expect(useEditorStore.getState().objects).toHaveLength(1);

    await userEvent.click(within(dialog).getByRole('button', { name: 'CANCEL' }));
    expect(useEditorStore.getState().objects[0].name).toBe('TORUS');
  });

  it('still asks on a scene that has only reached the autosave', async () => {
    render(<App />);
    act(() => useEditorStore.getState().addPrimitive('torus'));
    // The autosave has caught up, so nothing is pending against the browser's
    // copy. NEW clears that copy all the same, and a file is the only thing
    // that would have survived it.
    act(() => useEditorStore.getState().markSaved());

    await userEvent.click(screen.getByRole('button', { name: 'FILE' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'NEW' }));

    expect(screen.getByRole('dialog', { name: 'START A NEW PROJECT' })).toBeInTheDocument();
  });

  it('starts a new project without asking when a file already holds it', async () => {
    render(<App />);
    act(() => useEditorStore.getState().addPrimitive('torus'));
    act(() => useEditorStore.getState().markFileSaved());

    await userEvent.click(screen.getByRole('button', { name: 'FILE' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'NEW' }));

    // A confirmation about losing nothing is one people learn to click
    // straight past, which is how a real warning gets missed later.
    expect(screen.queryByRole('dialog', { name: 'START A NEW PROJECT' })).not.toBeInTheDocument();
    expect(useEditorStore.getState().objects[0].name).toBe('CUBE');
  });

  it('asks again as soon as the saved project is edited', async () => {
    render(<App />);
    act(() => useEditorStore.getState().markFileSaved());
    act(() => useEditorStore.getState().addPrimitive('torus'));

    await userEvent.click(screen.getByRole('button', { name: 'FILE' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'NEW' }));

    expect(screen.getByRole('dialog', { name: 'START A NEW PROJECT' })).toBeInTheDocument();
  });

  it('starts the new project on a cube once that is confirmed', async () => {
    render(<App />);
    act(() => useEditorStore.getState().addPrimitive('torus'));

    await userEvent.click(screen.getByRole('button', { name: 'FILE' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'NEW' }));
    const dialog = screen.getByRole('dialog', { name: 'START A NEW PROJECT' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'START WITHOUT SAVING' }));

    await waitFor(() => expect(useEditorStore.getState().objects).toHaveLength(1));
    expect(useEditorStore.getState().objects[0].name).toBe('CUBE');
  });

  it('asks before a file opened from disk throws the autosaved project away', async () => {
    render(<App />);
    act(() => useEditorStore.getState().addPrimitive('torus'));

    await userEvent.click(screen.getByRole('button', { name: 'FILE' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'OPEN' }));

    // Opening costs what NEW costs: the browser keeps one project, and the
    // file about to be loaded is what replaces it.
    const dialog = screen.getByRole('dialog', { name: 'OPEN A PROJECT FILE' });
    expect(
      within(dialog).getByText('Auto-saved data will be lost. Save this project to a file first?'),
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'CANCEL' }));
    expect(useEditorStore.getState().objects[0].name).toBe('TORUS');
  });

  it('opens without asking when a file already holds the project', async () => {
    render(<App />);
    act(() => useEditorStore.getState().addPrimitive('torus'));
    act(() => useEditorStore.getState().markFileSaved());

    await userEvent.click(screen.getByRole('button', { name: 'FILE' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'OPEN' }));

    expect(screen.queryByRole('dialog', { name: 'OPEN A PROJECT FILE' })).not.toBeInTheDocument();
  });

  it('opens the shortcut overlay', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: '?' }));

    const dialog = screen.getByRole('dialog', { name: 'KEYBOARD SHORTCUTS' });
    // Matched on the operator rather than the whole label: what is being
    // checked is that the overlay lists the keymap, not how a row is worded.
    expect(within(dialog).getByText(/^Extrude/)).toBeInTheDocument();
  });

  it('adds a modifier and renders it in the stack', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));

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
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));

    const modifiers = screen.getByRole('region', { name: 'MODIFIERS' });
    await userEvent.selectOptions(within(modifiers).getByLabelText('Add modifier'), 'array');
    await userEvent.click(within(modifiers).getByRole('button', { name: 'Remove ARRAY' }));

    expect(useEditorStore.getState().objects[0].modifiers).toHaveLength(0);
    expect(within(modifiers).getByText(/Stack is empty/i)).toBeInTheDocument();
  });

  it('starts a modal rotation on R, the way Blender does', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));

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
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));
    await userEvent.click(within(addPanel).getByRole('button', { name: 'PLANE' }));
    act(() => useEditorStore.getState().setActiveObject(null));
    expect(useEditorStore.getState().selectedObjectIds).toHaveLength(0);

    fireEvent.keyDown(window, { key: 'a' });

    expect(useEditorStore.getState().selectedObjectIds).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('Selected all 2 object(s)');
  });

  it('selects all geometry when pressing A in edit mode', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));
    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));

    fireEvent.keyDown(window, { key: 'a' });

    expect(useEditorStore.getState().objects[0].mesh.selectedFaces()).toHaveLength(6);
  });

  describe('the browser reload keys', () => {
    const addCube = async () => {
      const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
      await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));
    };

    it('answers F5 with the save offer rather than letting the tab go', async () => {
      render(<App />);
      await addCube();

      // false means preventDefault() ran, so the browser never saw the key.
      expect(fireEvent.keyDown(window, { key: 'F5' })).toBe(false);
      expect(screen.getByRole('dialog', { name: 'RELOAD THE PAGE' })).toBeInTheDocument();
    });

    it('catches the hard reload too, and F5 from inside a text field', async () => {
      render(<App />);
      await addCube();

      expect(fireEvent.keyDown(window, { key: 'r', ctrlKey: true, shiftKey: true })).toBe(false);
      expect(useEditorStore.getState().dialog).toBe('reload');

      act(() => useEditorStore.getState().closeDialog());

      // A refresh is a refresh whatever had focus: the guard that keeps
      // shortcuts out of typing fields must not hand this one to the browser.
      const field = screen.getByLabelText('Project name');
      expect(fireEvent.keyDown(field, { key: 'F5' })).toBe(false);
      expect(useEditorStore.getState().dialog).toBe('reload');
    });

    it('swallows Ctrl+R in object mode, where there is no loop to cut', async () => {
      render(<App />);
      await addCube();
      const before = useEditorStore.getState().objects[0].mesh.verts.size;

      expect(fireEvent.keyDown(window, { key: 'r', ctrlKey: true })).toBe(false);

      // Nothing happened, and nothing was asked: the editor has taken the key
      // from the browser, and object mode has nothing to spend it on.
      expect(useEditorStore.getState().dialog).toBeNull();
      expect(useEditorStore.getState().objects[0].mesh.verts.size).toBe(before);
    });

    it('still cuts a loop with Ctrl+R in edit mode', async () => {
      render(<App />);
      await addCube();
      await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));
      act(() => useEditorStore.getState().exec('selectAll', {}, 'Select all'));
      const before = useEditorStore.getState().objects[0].mesh.verts.size;

      fireEvent.keyDown(window, { key: 'r', ctrlKey: true });

      expect(useEditorStore.getState().objects[0].mesh.verts.size).toBeGreaterThan(before);
      expect(useEditorStore.getState().dialog).toBeNull();
    });
  });

  it('treats Ctrl+A as a no-op that only suppresses the browser default', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));
    act(() => useEditorStore.getState().setActiveObject(null));
    expect(useEditorStore.getState().selectedObjectIds).toHaveLength(0);

    // fireEvent's return value mirrors dispatchEvent: false means preventDefault() ran.
    const notPrevented = fireEvent.keyDown(window, { key: 'a', ctrlKey: true });

    expect(notPrevented).toBe(false);
    expect(useEditorStore.getState().selectedObjectIds).toHaveLength(0);
  });

  it('keeps shortcuts alive while a toggle holds focus, but not in a text field', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));
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
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));

    const prop = screen.getByRole('button', { name: 'PROP' });
    expect(prop).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(prop);
    expect(useEditorStore.getState().proportional.enabled).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));
    await userEvent.click(screen.getByRole('button', { name: 'PROP' }));

    expect(useEditorStore.getState().proportional.enabled).toBe(true);
    expect(screen.getByRole('button', { name: 'PROP' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('flips snapping from the top bar, in either mode', async () => {
    render(<App />);

    const snap = screen.getByRole('button', { name: 'SNAP' });
    // Unlike PROP and AUTO MERGE: a move on the grid is as useful for placing a
    // whole object as it is for placing a vertex, so it is never disabled.
    expect(snap).not.toHaveAttribute('aria-disabled');

    await userEvent.click(snap);

    expect(useEditorStore.getState().snapEnabled).toBe(true);
    expect(screen.getByRole('button', { name: 'SNAP' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('SNAP GRID')).toBeInTheDocument();
  });

  it('types a step of its own once CUSTOM is picked, and saves it', async () => {
    // Snapping is a preference, so it outlives a scene reset: put back by hand.
    act(() =>
      useEditorStore
        .getState()
        .setPreferences({ snapEnabled: true, snapMode: 'grid', snapStep: 0.1 }),
    );
    render(<App />);

    // Nothing to type into while the grid is what the steps are measured in.
    expect(screen.queryByLabelText('Snap step')).not.toBeInTheDocument();
    expect(screen.getByText('SNAP GRID')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Snap to'), 'custom');
    const field = screen.getByLabelText('Snap step');

    await userEvent.clear(field);
    await userEvent.type(field, '0.03');
    fireEvent.blur(field);

    // Saved as a preference, not just held on the bar: it is what the export
    // writes out and what the next session reads back.
    expect(useEditorStore.getState().currentPreferences()).toMatchObject({
      snapEnabled: true,
      snapMode: 'custom',
      snapStep: 0.03,
    });
    expect(screen.getByText('SNAP 0.03 GRID')).toBeInTheDocument();

    // Back to the grid and the figure is kept, not thrown away.
    await userEvent.selectOptions(screen.getByLabelText('Snap to'), 'grid');
    expect(screen.getByText('SNAP GRID')).toBeInTheDocument();
    expect(useEditorStore.getState().snapStep).toBe(0.03);
  });

  it('holds the same snap setting in the top bar and in preferences', async () => {
    act(() =>
      useEditorStore
        .getState()
        .setPreferences({ snapEnabled: false, snapMode: 'grid', snapStep: 0.1 }),
    );
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'PREFS' }));
    const dialog = screen.getByRole('dialog', { name: 'PREFERENCES' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'SNAPPING' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'SNAP TRANSFORMS' }));

    // One setting read from two places, so the bar is already showing it.
    expect(useEditorStore.getState().snapEnabled).toBe(true);
    expect(screen.getByRole('button', { name: 'SNAP' })).toHaveAttribute('aria-pressed', 'true');

    // The step has no effect until the mode says to use it, so the field says
    // so rather than taking a figure that would change nothing.
    expect(within(dialog).getByLabelText('CUSTOM STEP')).toBeDisabled();

    await userEvent.selectOptions(within(dialog).getByLabelText('SNAP TO'), 'custom');
    const step = within(dialog).getByLabelText('CUSTOM STEP');
    await userEvent.clear(step);
    await userEvent.type(step, '0.03');
    fireEvent.blur(step);

    expect(screen.getByLabelText('Snap to')).toHaveValue('custom');
    expect(screen.getByLabelText('Snap step')).toHaveValue('0.03');
  });

  it('takes a panel, the tool rail and the status bar off the screen from preferences', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'PREFS' }));
    const dialog = screen.getByRole('dialog', { name: 'PREFERENCES' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'PANELS VISIBILITY' }));

    for (const label of ['OBJECT', 'TOOL RAIL', 'STATUS BAR']) {
      await userEvent.click(within(dialog).getByRole('checkbox', { name: label }));
    }

    // The switches say what is on screen rather than the other way round.
    expect(within(dialog).getByRole('checkbox', { name: 'OBJECT' })).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'DONE' }));

    expect(screen.queryByRole('region', { name: 'OBJECT' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Tool rail' })).not.toBeInTheDocument();
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();

    // The ones left alone are untouched.
    expect(screen.getByRole('region', { name: 'PRIMITIVES' })).toBeInTheDocument();

    // These belong to the person, not to the scene, so a fresh one comes up
    // with the same things put away.
    act(() => useEditorStore.getState().resetScene());
    expect(screen.queryByRole('region', { name: 'OBJECT' })).not.toBeInTheDocument();
  });

  it('flips auto merge from the top bar, and only in edit mode', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));

    const merge = screen.getByRole('button', { name: 'AUTO MERGE' });
    expect(merge).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(merge);
    expect(useEditorStore.getState().autoMerge.enabled).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));
    await userEvent.click(screen.getByRole('button', { name: 'AUTO MERGE' }));

    expect(useEditorStore.getState().autoMerge.enabled).toBe(true);
    expect(screen.getByRole('button', { name: 'AUTO MERGE' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('sets the auto merge distance from the topology panel', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));
    await userEvent.click(screen.getByRole('button', { name: 'EDIT' }));
    // Switched on through the store rather than the button: `resetScene` leaves
    // the flag as the previous test set it, so clicking would toggle it off.
    act(() => useEditorStore.getState().setAutoMerge({ enabled: true, threshold: 0.01 }));

    const distance = screen.getByLabelText('DISTANCE');
    await userEvent.clear(distance);
    await userEvent.type(distance, '0.05{Enter}');

    expect(useEditorStore.getState().autoMerge.threshold).toBeCloseTo(0.05, 6);
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
    const pivot = screen.getByRole('combobox', { name: 'PIVOT' });
    expect(pivot).toHaveValue('median');

    await userEvent.selectOptions(pivot, 'cursor');
    expect(useEditorStore.getState().pivot).toBe('cursor');

    await userEvent.selectOptions(pivot, 'origin');
    expect(useEditorStore.getState().pivot).toBe('origin');
  });

  it('moves the cursor and the selection with the keys the menu names', () => {
    const store = useEditorStore.getState();
    store.addPrimitive('cube');
    store.setObjectTransform(useEditorStore.getState().objects[0].id, {
      position: { x: 0, y: 5, z: 0 },
    });
    render(<App />);

    // Alt+Shift+C: the origin of the selection, not the middle of its shape.
    fireEvent.keyDown(window, { key: 'C', shiftKey: true, altKey: true });
    expect(useEditorStore.getState().cursor.y).toBeCloseTo(5);

    act(() => useEditorStore.getState().setCursor({ x: 0, y: 2, z: 0 }));
    // Alt+Shift+V: the origin travels to the cursor and the shape stays put.
    fireEvent.keyDown(window, { key: 'V', shiftKey: true, altKey: true });
    expect(useEditorStore.getState().objects[0].transform.position.y).toBeCloseTo(2);
  });

  it('hides and shows the cursor with Alt+C', () => {
    render(<App />);
    expect(useEditorStore.getState().overlays.cursor).toBe(true);

    fireEvent.keyDown(window, { key: 'C', altKey: true });
    expect(useEditorStore.getState().overlays.cursor).toBe(false);

    fireEvent.keyDown(window, { key: 'C', altKey: true });
    expect(useEditorStore.getState().overlays.cursor).toBe(true);
  });

  it('hands the snaps under the pointer to the viewport, which owns the raycast', () => {
    render(<App />);

    // The menu resolves these as the right-click lands. From the keyboard there
    // is no click, so the viewport is asked for a pass at the pointer instead.
    const keys = [
      ['c', false, 'point'],
      ['v', true, 'vertex'],
      ['e', true, 'edge'],
      ['f', true, 'face'],
    ] as const;

    for (const [key, alt, kind] of keys) {
      fireEvent.keyDown(window, { key, altKey: alt });
      expect(useEditorStore.getState().cursorSnapRequest?.kind).toBe(kind);
    }
  });
  it('steps the pivot through all three from the keyboard', () => {
    // The pivot outlives resetScene, so the test before this one leaves it
    // wherever it finished.
    useEditorStore.getState().setPivot('origin');
    render(<App />);

    // Ctrl rather than Shift: `Shift+.` arrives as `>` and matches nothing.
    fireEvent.keyDown(window, { key: '.', ctrlKey: true });
    expect(useEditorStore.getState().pivot).toBe('median');

    fireEvent.keyDown(window, { key: '.', ctrlKey: true });
    expect(useEditorStore.getState().pivot).toBe('cursor');

    fireEvent.keyDown(window, { key: '.', ctrlKey: true });
    expect(useEditorStore.getState().pivot).toBe('origin');
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

    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));

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
    await userEvent.click(within(dialog).getByRole('button', { name: 'INTERFACE' }));
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

  it('draws every top bar icon at one size, whatever it is a picture of', () => {
    render(<App />);
    const glyphs = [...document.querySelectorAll('.top-bar .top-bar__glyph')];

    // Snap, proportional, auto merge, ortho, smooth, history and the two frame
    // buttons. They were Unicode glyphs, and the crosshair on FRAME SEL came
    // out at about half the height of the ruled square on SNAP.
    expect(glyphs).toHaveLength(8);
    for (const glyph of glyphs) {
      expect(glyph.tagName.toLowerCase()).toBe('svg');
      // One box, and drawings that fill it, so no font gets a say in the size.
      expect(glyph.getAttribute('viewBox')).toBe('0 0 16 16');
      expect(glyph.getAttribute('width')).toBeNull();
      expect(glyph.getAttribute('height')).toBeNull();
    }
  });

  it('gives each icon button a picture rather than a character', () => {
    render(<App />);

    for (const name of ['HISTORY', 'FRAME SEL', 'FRAME ALL', 'SNAP', 'ORTHO']) {
      const button = screen.getByRole('button', { name });
      expect(button.querySelector('.top-bar__glyph')).not.toBeNull();
    }
  });

  it('trembles the Frame All button once the viewport reports the scene is out of view', () => {
    render(<App />);
    const frameAll = screen.getByRole('button', { name: 'FRAME ALL' });
    expect(frameAll.className).not.toMatch(/tremble/);

    act(() => useEditorStore.setState({ viewLost: 'far' }));
    expect(frameAll.className).toMatch(/tremble/);

    act(() => useEditorStore.setState({ viewLost: null }));
    expect(frameAll.className).not.toMatch(/tremble/);
  });

  it('trembles it for a zoom that has stopped biting, and says which trap it is', () => {
    render(<App />);
    const frameAll = screen.getByRole('button', { name: 'FRAME ALL' });

    act(() => useEditorStore.setState({ viewLost: 'stuck' }));

    expect(frameAll.className).toMatch(/tremble/);

    // The tremble says something is wrong; only the hint says which of the two
    // traps the camera is in, and so which way out the click takes.
    vi.useFakeTimers();
    fireEvent.mouseEnter(frameAll);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent(/run out of zoom/);
  });

  it('opens the history from the top bar and travels back through it', async () => {
    render(<App />);
    const addPanel = screen.getByRole('region', { name: 'PRIMITIVES' });
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CUBE' }));
    await userEvent.click(within(addPanel).getByRole('button', { name: 'CYLINDER' }));

    await userEvent.click(screen.getByRole('button', { name: 'HISTORY' }));
    const dialog = screen.getByRole('dialog', { name: 'HISTORY' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Add CUBE/ }));

    // Two steps in one click, and the scene is back to where the box arrived.
    expect(useEditorStore.getState().objects).toHaveLength(0);
  });

  it('unlocks the vertical orbit by default and locks it from preferences', async () => {
    render(<App />);
    // Off out of the box: a vertical drag rolls over the top rather than
    // stopping dead at the bottom or top face.
    expect(useEditorStore.getState().lockVerticalOrbit).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'PREFS' }));
    const dialog = screen.getByRole('dialog', { name: 'PREFERENCES' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'VIEWPORT' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'LOCK VERTICAL ORBIT' }));

    expect(useEditorStore.getState().lockVerticalOrbit).toBe(true);
  });

  it('sets the number of undo steps from preferences', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'PREFS' }));
    const dialog = screen.getByRole('dialog', { name: 'PREFERENCES' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'HISTORY' }));

    fireEvent.change(within(dialog).getByRole('slider', { name: 'UNDO STEPS' }), {
      target: { value: '10' },
    });

    expect(useEditorStore.getState().historySize).toBe(10);
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
