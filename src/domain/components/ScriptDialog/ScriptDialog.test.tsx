import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { vec3 } from '@kernel/index';
import { useEditorStore } from '@store/index';

import { SCRIPT_EXAMPLES, STARTER_SCRIPT } from '../../scripting/examples';

import { DRAFT_KEY, EMPTY_SCENE, ScriptDialog } from './ScriptDialog';

const store = () => useEditorStore.getState();
const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Script' });
const sceneView = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Scene' });
const button = (name: string) => screen.getByRole('button', { name });

/** Puts a whole script in the editor at once, as a paste would. */
function write(source: string) {
  fireEvent.change(field(), { target: { value: source } });
}

async function openEditor() {
  await userEvent.click(button('EDITOR'));
}

describe('ScriptDialog', () => {
  beforeEach(() => {
    window.localStorage.removeItem(DRAFT_KEY);
    store().resetScene();
    useEditorStore.setState({ toasts: [] });
    store().openDialog('script');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens on the SCENE tab, with the scene written as the script that builds it', () => {
    store().addPrimitive('cube');
    store().setObjectTransform(store().objects[0].id, { position: vec3(1, 2, 0) });
    store().setShading('wireframe');

    render(<ScriptDialog />);

    expect(sceneView()).toHaveValue("scene.add('cube', { position: [1, 2, 0] });");
    expect(sceneView()).toHaveAttribute('readonly');
    expect(sceneView()).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'RUN' })).not.toBeInTheDocument();
  });

  it('offers only CLOSE and COPY, with nothing to clear or hand to the editor', () => {
    store().addPrimitive('cube');
    render(<ScriptDialog />);

    const footer = button('CLOSE').parentElement as HTMLElement;
    expect(
      within(footer)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['CLOSE', 'COPY']);
  });

  it('shows an empty scene as empty, with nothing to copy', () => {
    render(<ScriptDialog />);

    expect(sceneView()).toHaveValue(EMPTY_SCENE);
    expect(button('COPY')).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows nothing for a cube added and deleted again', () => {
    store().addPrimitive('cube');
    store().deleteSelected([store().objects[0].id]);

    render(<ScriptDialog />);

    expect(sceneView()).toHaveValue(EMPTY_SCENE);
  });

  it('follows the scene while it is open', () => {
    render(<ScriptDialog />);

    act(() => store().addPrimitive('torus'));
    expect(sceneView()).toHaveValue("scene.add('torus');");

    act(() => store().undo());
    expect(sceneView()).toHaveValue(EMPTY_SCENE);
  });

  it('cannot be typed into', async () => {
    store().addPrimitive('cone');
    render(<ScriptDialog />);

    await userEvent.type(sceneView(), 'scene.clear();');

    expect(sceneView()).toHaveValue("scene.add('cone');");
  });

  it('copies the script that, run in the editor on a new project, builds the same scene', async () => {
    const user = userEvent.setup();
    store().addPrimitive('cube');
    store().setObjectTransform(store().objects[0].id, { position: vec3(1, 2, 0) });
    store().addPrimitive('cone');
    store().renameObject(store().objects[1].id, 'TIP');
    const built = store().objects.map(({ name, transform }) => ({ name, transform }));
    render(<ScriptDialog />);

    await user.click(button('COPY'));
    const copied = await navigator.clipboard.readText();
    expect(copied).toBe(sceneView().value);
    expect(button('COPIED')).toBeInTheDocument();
    expect(store().toasts).toEqual([]);

    act(() => {
      store().resetScene();
      store().openDialog('script');
    });
    await user.click(button('EDITOR'));
    write(copied);
    await user.click(button('RUN'));

    await waitFor(() => expect(store().dialog).toBeNull());
    expect(store().objects.map(({ name, transform }) => ({ name, transform }))).toEqual(built);
  });

  it('warns on a copy that leaves out what no script can make', async () => {
    const user = userEvent.setup();
    store().addImage({
      id: 'asset-photo',
      name: 'photo.png',
      type: 'image/png',
      width: 64,
      height: 32,
      blob: null,
    });
    store().addPrimitive('cone');
    render(<ScriptDialog />);

    await user.click(button('COPY'));

    expect(await navigator.clipboard.readText()).toBe(
      "// PHOTO.PNG: an image, which a script cannot add\nscene.add('cone');",
    );
    expect(store().toasts).toEqual([
      expect.objectContaining({
        variant: 'warning',
        message: 'Copied. One thing in the scene has no script form yet, so a run leaves it out',
      }),
    ]);
  });

  it('says so when the browser refuses the clipboard', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    store().addPrimitive('cube');
    render(<ScriptDialog />);

    await user.click(button('COPY'));

    expect(button('COPY')).toBeInTheDocument();
    expect(store().toasts).toEqual([
      expect.objectContaining({ variant: 'error', message: expect.stringMatching(/blocked/) }),
    ]);
  });

  it('opens the editor on the starter script the first time', async () => {
    render(<ScriptDialog />);
    await openEditor();
    expect(field()).toHaveValue(STARTER_SCRIPT);
  });

  it('closes on a run that works, and says what it did in a toast', async () => {
    render(<ScriptDialog />);
    await openEditor();
    write(`scene.add('cube'); scene.add('torus');`);

    await userEvent.click(button('RUN'));

    await waitFor(() => expect(store().dialog).toBeNull());
    expect(store().objects.map((object) => object.name)).toEqual(['CUBE', 'TORUS']);
    expect(store().toasts).toEqual([
      expect.objectContaining({ variant: 'success', message: 'Script ran: 2 objects added' }),
    ]);
  });

  it('stays open on a run that fails, says why in a toast and under the code, and changes nothing', async () => {
    render(<ScriptDialog />);
    await openEditor();
    write(`scene.add('cube');\nscene.add('sphere');`);

    await userEvent.click(button('RUN'));

    await waitFor(() => expect(store().toasts).toHaveLength(1));
    const [toast] = store().toasts;
    expect(toast.variant).toBe('error');
    expect(toast.message).toMatch(/^Script failed on line 2: scene\.add: kind has to be one of/);
    expect(store().dialog).toBe('script');
    expect(store().objects).toHaveLength(0);
    expect(screen.getByText('LINE 2')).toBeInTheDocument();
    expect(screen.getByText(/kind has to be one of/, { selector: 'span' })).toBeInTheDocument();
  });

  it('runs on Ctrl+Enter from the editor, and not from the scene', async () => {
    render(<ScriptDialog />);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(store().objects).toHaveLength(0);

    await openEditor();
    write(`scene.add('cone');`);
    field().focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(store().objects).toHaveLength(1));
  });

  it('keeps the draft for the next visit', async () => {
    const { unmount } = render(<ScriptDialog />);
    await openEditor();
    write('// my script');
    unmount();

    render(<ScriptDialog />);
    await openEditor();
    expect(field()).toHaveValue('// my script');
  });

  it('loads an example in place of the script', async () => {
    render(<ScriptDialog />);
    await openEditor();
    const [example] = SCRIPT_EXAMPLES;

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'EXAMPLE' }), example.id);

    expect(field()).toHaveValue(example.source);
  });

  it('takes Escape out of the scene before it closes the dialog', async () => {
    render(<ScriptDialog />);
    expect(sceneView()).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(store().dialog).toBe('script');
    expect(sceneView()).not.toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(store().dialog).toBeNull();
  });

  it('links to the scripting reference', () => {
    render(<ScriptDialog />);
    expect(screen.getByRole('link', { name: /API REFERENCE/ })).toHaveAttribute(
      'href',
      '/docs#scripting',
    );
  });
});
