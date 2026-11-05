import { act, fireEvent, render, screen } from '@testing-library/react';
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

  it('changes one axis colour under COLORS and leaves the other two alone', async () => {
    render(<PreferencesDialog />);
    await userEvent.click(screen.getByRole('button', { name: /COLORS/ }));
    const defaults = store().axisColors;

    fireEvent.change(screen.getByLabelText('Y AXIS'), { target: { value: '#102030' } });

    expect(store().axisColors).toEqual({ ...defaults, y: '#102030' });
    expect(screen.getByLabelText('Y AXIS')).toHaveValue('#102030');
  });

  it('puts the axis colours back on RESET', async () => {
    render(<PreferencesDialog />);
    const defaults = store().axisColors;
    act(() => store().setPreferences({ axisColors: { ...defaults, x: '#102030' } }));

    await userEvent.click(screen.getByRole('button', { name: 'RESET' }));

    expect(store().axisColors).toEqual(defaults);
  });

  it('carries the axis colours through a preferences file', () => {
    const defaults = store().axisColors;
    act(() => store().setPreferences({ axisColors: { ...defaults, z: '#102030' } }));
    const file = JSON.stringify(store().currentPreferences());

    act(() => store().resetPreferences());
    act(() => store().importPreferences(file));

    expect(store().axisColors.z).toBe('#102030');
  });
});
