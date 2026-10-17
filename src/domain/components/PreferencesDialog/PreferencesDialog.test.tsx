import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { PreferencesDialog } from './PreferencesDialog';

const store = () => useEditorStore.getState();

describe('PreferencesDialog', () => {
  beforeEach(() => {
    store().resetPreferences();
    store().openDialog('preferences');
  });

  it('switches dark mode on and off under INTERFACE', async () => {
    render(<PreferencesDialog />);
    await userEvent.click(screen.getByRole('button', { name: /INTERFACE/ }));
    const dark = screen.getByRole('checkbox', { name: 'DARK MODE' });
    expect(dark).not.toBeChecked();

    await userEvent.click(dark);
    expect(store().theme).toBe('dark');
    expect(dark).toBeChecked();

    await userEvent.click(dark);
    expect(store().theme).toBe('light');
  });

  it('shows dark mode as on when the top bar switched it', async () => {
    render(<PreferencesDialog />);
    await userEvent.click(screen.getByRole('button', { name: /INTERFACE/ }));

    act(() => store().setPreferences({ theme: 'dark' }));

    expect(screen.getByRole('checkbox', { name: 'DARK MODE' })).toBeChecked();
  });
});
