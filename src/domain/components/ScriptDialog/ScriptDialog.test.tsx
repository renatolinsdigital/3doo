import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { SCRIPT_EXAMPLES, STARTER_SCRIPT } from '../../scripting/examples';
import { clearActionLog, installRecorder } from '../../scripting/recorder';

import { DRAFT_KEY, EMPTY_LOG, ScriptDialog } from './ScriptDialog';

const store = () => useEditorStore.getState();
const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Script' });
const log = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Actions' });
const button = (name: string) => screen.getByRole('button', { name });

/** Puts a whole script in the editor at once, as a paste would. */
function write(source: string) {
  fireEvent.change(field(), { target: { value: source } });
}

async function openEditor() {
  await userEvent.click(button('EDITOR'));
}

describe('ScriptDialog', () => {
  beforeAll(installRecorder);

  beforeEach(() => {
    window.localStorage.removeItem(DRAFT_KEY);
    store().resetScene();
    useEditorStore.setState({ toasts: [] });
    clearActionLog();
    store().openDialog('script');
  });

  it('opens on the ACTIONS tab, with what was done in the viewport written as script', () => {
    store().addPrimitive('cube');
    store().setShading('wireframe');

    render(<ScriptDialog />);

    expect(log()).toHaveValue("scene.add('cube');\nview.shading = 'wireframe';");
    expect(log()).toHaveAttribute('readonly');
    expect(log()).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'RUN' })).not.toBeInTheDocument();
  });

  it('says what the log is for while it is empty, with nothing to clear or open', () => {
    render(<ScriptDialog />);

    expect(log()).toHaveValue(EMPTY_LOG);
    expect(button('CLEAR')).toHaveAttribute('aria-disabled', 'true');
    expect(button('OPEN IN EDITOR')).toHaveAttribute('aria-disabled', 'true');
  });

  it('empties the log on CLEAR and leaves the scene alone', async () => {
    store().addPrimitive('cube');
    render(<ScriptDialog />);

    await userEvent.click(button('CLEAR'));

    expect(log()).toHaveValue(EMPTY_LOG);
    expect(store().objects).toHaveLength(1);
  });

  it('hands the log to the editor, where Ctrl+Z would bring the old script back', async () => {
    store().addPrimitive('torus');
    render(<ScriptDialog />);

    await userEvent.click(button('OPEN IN EDITOR'));

    expect(field()).toHaveValue("scene.add('torus');");
    expect(screen.getByRole('button', { name: 'RUN' })).toBeInTheDocument();
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

  it('runs on Ctrl+Enter from the editor, and not from the log', async () => {
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

  it('takes Escape out of the log before it closes the dialog', async () => {
    render(<ScriptDialog />);
    expect(log()).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(store().dialog).toBe('script');
    expect(log()).not.toHaveFocus();

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
