import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import type { SaveResult } from '../../services/download';

import { ReplaceProjectDialog } from './ReplaceProjectDialog';

/** A save that ends the way the test wants it to. */
function saving(status: SaveResult['status']) {
  return vi.fn(() => Promise.resolve({ status, filename: 'scene.3doo' }) as Promise<SaveResult>);
}

function replacing() {
  return vi.fn(() => Promise.resolve());
}

describe('ReplaceProjectDialog', () => {
  beforeEach(() => {
    useEditorStore.setState({ dialog: 'newProject', autosaveEnabled: true });
  });

  it('starts the new project on the spot when the save is turned down', async () => {
    const onNew = replacing();
    const onSave = saving('saved');
    render(<ReplaceProjectDialog onNew={onNew} onOpen={replacing()} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: 'START WITHOUT SAVING' }));

    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1));
    expect(onSave).not.toHaveBeenCalled();
    expect(useEditorStore.getState().dialog).toBe(null);
  });

  it('waits for the file to be written before it discards anything', async () => {
    const onNew = replacing();
    const onSave = saving('saved');
    render(<ReplaceProjectDialog onNew={onNew} onOpen={replacing()} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: 'SAVE AND START' }));

    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('leaves the choice standing when the picker is dismissed', async () => {
    const onNew = replacing();
    render(
      <ReplaceProjectDialog onNew={onNew} onOpen={replacing()} onSave={saving('cancelled')} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'SAVE AND START' }));

    // Discarding the project over a save that never happened is exactly the
    // loss the dialog exists to prevent.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'SAVE AND START' })).toBeEnabled(),
    );
    expect(onNew).not.toHaveBeenCalled();
    expect(useEditorStore.getState().dialog).toBe('newProject');
  });

  it('stays put when the name is already taken', async () => {
    const onNew = replacing();
    render(<ReplaceProjectDialog onNew={onNew} onOpen={replacing()} onSave={saving('exists')} />);

    await userEvent.click(screen.getByRole('button', { name: 'SAVE AND START' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'SAVE AND START' })).toBeEnabled(),
    );
    expect(onNew).not.toHaveBeenCalled();
  });

  it('cancels without touching either route', async () => {
    const onNew = replacing();
    const onOpen = replacing();
    render(<ReplaceProjectDialog onNew={onNew} onOpen={onOpen} onSave={saving('saved')} />);

    await userEvent.click(screen.getByRole('button', { name: 'CANCEL' }));

    expect(onNew).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(useEditorStore.getState().dialog).toBe(null);
  });

  describe('opening a file over the project', () => {
    beforeEach(() => {
      useEditorStore.setState({ dialog: 'openProject' });
    });

    it('asks on the same terms, because it costs the same thing', () => {
      render(
        <ReplaceProjectDialog onNew={replacing()} onOpen={replacing()} onSave={saving('saved')} />,
      );

      const dialog = screen.getByRole('dialog', { name: 'OPEN A PROJECT FILE' });
      expect(dialog).toHaveTextContent('Auto-saved data will be lost.');
    });

    it('reaches the picker rather than the reset', async () => {
      const onNew = replacing();
      const onOpen = replacing();
      render(<ReplaceProjectDialog onNew={onNew} onOpen={onOpen} onSave={saving('saved')} />);

      await userEvent.click(screen.getByRole('button', { name: 'OPEN WITHOUT SAVING' }));

      await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
      expect(onNew).not.toHaveBeenCalled();
    });

    it('writes the file first when asked to', async () => {
      const onOpen = replacing();
      const onSave = saving('downloaded');
      render(<ReplaceProjectDialog onNew={replacing()} onOpen={onOpen} onSave={onSave} />);

      await userEvent.click(screen.getByRole('button', { name: 'SAVE AND OPEN' }));

      await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  });

  it('says what there is to lose when autosave is off', () => {
    useEditorStore.setState({ autosaveEnabled: false });
    render(
      <ReplaceProjectDialog onNew={replacing()} onOpen={replacing()} onSave={saving('saved')} />,
    );

    expect(screen.getByRole('dialog', { name: 'START A NEW PROJECT' })).toHaveTextContent(
      /Autosave is off/,
    );
  });
});
