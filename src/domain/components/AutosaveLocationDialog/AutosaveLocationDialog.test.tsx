import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import { AutosaveLocationDialog } from './AutosaveLocationDialog';

/** A location autosave already knows, whose permission a restart took away. */
function lapsedLocation(granted: PermissionState, name = 'Projects') {
  const requestPermission = vi.fn(() => Promise.resolve(granted));
  const location = {
    name,
    queryPermission: () => Promise.resolve('prompt'),
    requestPermission,
  } as unknown as FileSystemDirectoryHandle;
  return { location, requestPermission };
}

describe('AutosaveLocationDialog', () => {
  beforeEach(() => {
    useEditorStore.setState({ dialog: 'autosaveLocation', toasts: [], autosaveEnabled: true });
  });

  it('names the folder it is asking about', () => {
    const { location } = lapsedLocation('granted');
    useEditorStore.getState().setAutosaveLocation(location, false);
    render(<AutosaveLocationDialog />);

    expect(screen.getByRole('dialog', { name: 'AUTOSAVE LOCATION' })).toHaveTextContent(
      'Let autosave write to Projects/3doo-auto-saves again?',
    );
  });

  it('asks the browser for the permission back, and closes once given', async () => {
    const { location, requestPermission } = lapsedLocation('granted');
    useEditorStore.getState().setAutosaveLocation(location, false);
    render(<AutosaveLocationDialog />);

    await userEvent.click(screen.getByRole('button', { name: 'ALLOW' }));

    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    await waitFor(() => expect(useEditorStore.getState().dialog).toBeNull());
    expect(useEditorStore.getState().autosaveLocationReady).toBe(true);
  });

  it('stays up when the browser is refused, with the choice still on it', async () => {
    const { location } = lapsedLocation('denied');
    useEditorStore.getState().setAutosaveLocation(location, false);
    render(<AutosaveLocationDialog />);

    await userEvent.click(screen.getByRole('button', { name: 'ALLOW' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'ALLOW' })).toBeEnabled());
    expect(useEditorStore.getState().dialog).toBe('autosaveLocation');
  });

  it('turns autosave off from here too, keeping the location for later', async () => {
    const { location } = lapsedLocation('granted');
    useEditorStore.getState().setAutosaveLocation(location, false);
    render(<AutosaveLocationDialog />);

    await userEvent.click(screen.getByRole('button', { name: 'TURN AUTOSAVE OFF' }));

    expect(useEditorStore.getState().autosaveEnabled).toBe(false);
    expect(useEditorStore.getState().autosaveLocation).toBe(location);
    expect(useEditorStore.getState().dialog).toBeNull();
  });

  it('leaves autosave on when it is only closed', async () => {
    // Nothing is written until it is allowed, and the question comes back
    // next time.
    const { location } = lapsedLocation('granted');
    useEditorStore.getState().setAutosaveLocation(location, false);
    render(<AutosaveLocationDialog />);

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(useEditorStore.getState().autosaveEnabled).toBe(true);
    expect(useEditorStore.getState().autosaveLocation).toBe(location);
  });
});
