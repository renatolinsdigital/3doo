import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { SCRIPT_EXAMPLES, STARTER_SCRIPT } from '../../scripting/examples';

import { DRAFT_KEY, ScriptDialog } from './ScriptDialog';

const store = () => useEditorStore.getState();
const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Script' });

/** Puts a whole script in the editor at once, as a paste would. */
function write(source: string) {
  fireEvent.change(field(), { target: { value: source } });
}

describe('ScriptDialog', () => {
  beforeEach(() => {
    window.localStorage.removeItem(DRAFT_KEY);
    store().resetScene();
    useEditorStore.setState({ toasts: [] });
    store().openDialog('script');
  });

  it('opens on the starter script the first time', () => {
    render(<ScriptDialog />);
    expect(field()).toHaveValue(STARTER_SCRIPT);
    expect(field()).toHaveFocus();
  });

  it('closes on a run that works, and says what it did in a toast', async () => {
    render(<ScriptDialog />);
    write(`scene.add('cube'); scene.add('torus');`);

    await userEvent.click(screen.getByRole('button', { name: 'RUN' }));

    await waitFor(() => expect(store().dialog).toBeNull());
    expect(store().objects.map((object) => object.name)).toEqual(['CUBE', 'TORUS']);
    expect(store().toasts).toEqual([
      expect.objectContaining({ variant: 'success', message: 'Script ran: 2 objects added' }),
    ]);
  });

  it('stays open on a run that fails, says why in a toast and under the code, and changes nothing', async () => {
    render(<ScriptDialog />);
    write(`scene.add('cube');\nscene.add('sphere');`);

    await userEvent.click(screen.getByRole('button', { name: 'RUN' }));

    await waitFor(() => expect(store().toasts).toHaveLength(1));
    const [toast] = store().toasts;
    expect(toast.variant).toBe('error');
    expect(toast.message).toMatch(/^Script failed on line 2: scene\.add: kind has to be one of/);
    expect(store().dialog).toBe('script');
    expect(store().objects).toHaveLength(0);
    expect(screen.getByText('LINE 2')).toBeInTheDocument();
    expect(screen.getByText(/kind has to be one of/, { selector: 'span' })).toBeInTheDocument();
  });

  it('runs on Ctrl+Enter from the editor', async () => {
    render(<ScriptDialog />);
    write(`scene.add('cone');`);
    field().focus();

    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(store().objects).toHaveLength(1));
  });

  it('keeps the draft for the next visit', () => {
    const { unmount } = render(<ScriptDialog />);
    write('// my script');
    unmount();

    render(<ScriptDialog />);
    expect(field()).toHaveValue('// my script');
  });

  it('loads an example in place of the script', async () => {
    render(<ScriptDialog />);
    const [example] = SCRIPT_EXAMPLES;

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'EXAMPLE' }), example.id);

    expect(field()).toHaveValue(example.source);
  });

  it('takes Escape out of the editor before it closes the dialog', async () => {
    render(<ScriptDialog />);
    field().focus();

    await userEvent.keyboard('{Escape}');
    expect(store().dialog).toBe('script');
    expect(field()).not.toHaveFocus();

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
