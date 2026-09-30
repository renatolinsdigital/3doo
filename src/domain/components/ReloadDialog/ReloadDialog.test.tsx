import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import type { SaveResult } from '../../services/download';

import { ReloadDialog } from './ReloadDialog';

const reload = vi.fn();
const realLocation = window.location;

/** A save that ends the way the test wants it to. */
function saving(status: SaveResult['status']) {
  return vi.fn(() => Promise.resolve({ status, filename: 'scene.3doo' }) as Promise<SaveResult>);
}

describe('ReloadDialog', () => {
  beforeEach(() => {
    reload.mockClear();
    // jsdom refuses to navigate, so the one call that matters is stubbed and
    // counted instead.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, reload },
    });
    // Set before the render, so nothing here is a store update landing on a
    // mounted dialog.
    useEditorStore.setState({ dialog: 'reload', autosaveEnabled: true });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('reloads on the spot when the save is turned down', async () => {
    const onSave = saving('saved');
    render(<ReloadDialog onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: 'RELOAD WITHOUT SAVING' }));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('waits for the file to be written before it reloads', async () => {
    const onSave = saving('saved');
    render(<ReloadDialog onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: 'SAVE AND RELOAD' }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('leaves the choice standing when the picker is dismissed', async () => {
    const onSave = saving('cancelled');
    render(<ReloadDialog onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: 'SAVE AND RELOAD' }));

    // Reloading over a save that never happened is exactly the loss the dialog
    // exists to prevent, so a dismissed picker changes nothing.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'SAVE AND RELOAD' })).toBeEnabled(),
    );
    expect(reload).not.toHaveBeenCalled();
    expect(useEditorStore.getState().dialog).toBe('reload');
  });

  it('stays put when the name is already taken', async () => {
    const onSave = saving('exists');
    render(<ReloadDialog onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: 'SAVE AND RELOAD' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(reload).not.toHaveBeenCalled();
  });

  it('says a reload opens a fresh scene, and what goes with it', () => {
    useEditorStore.setState({ autosaveEnabled: false, dirty: true });
    render(<ReloadDialog onSave={saving('saved')} />);

    const dialog = screen.getByRole('dialog', { name: 'RELOAD THE PAGE' });
    // The browser keeps no copy of the project to come back on.
    expect(dialog).toHaveTextContent('Reloading opens a fresh scene');
    expect(dialog).toHaveTextContent('Changes since the last save are in no file yet');
    expect(dialog).toHaveTextContent(/Autosave is off/);
  });

  it('says where the auto-saves are, for FILE > OPEN to bring back', () => {
    useEditorStore.setState({
      autosaveLocation: { name: 'Projects' } as FileSystemDirectoryHandle,
      dirty: false,
    });
    render(<ReloadDialog onSave={saving('saved')} />);

    const dialog = screen.getByRole('dialog', { name: 'RELOAD THE PAGE' });
    expect(dialog).toHaveTextContent('Auto-saves are in Projects/3doo-auto-saves');
    expect(dialog).toHaveTextContent('Nothing on screen has changed since the last save.');
  });
});
