import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RenameField } from './RenameField';

describe('RenameField', () => {
  it('opens focused on the current name', () => {
    render(<RenameField name="CUBE" onRename={() => {}} onCancel={() => {}} />);

    const field = screen.getByRole('textbox', { name: 'Rename CUBE' });
    expect(field).toHaveValue('CUBE');
    expect(field).toHaveFocus();
  });

  it('commits the trimmed name on Enter', async () => {
    const onRename = vi.fn();
    render(<RenameField name="CUBE" onRename={onRename} onCancel={() => {}} />);

    const field = screen.getByRole('textbox', { name: 'Rename CUBE' });
    await userEvent.clear(field);
    await userEvent.type(field, '  CHASSIS {Enter}');

    expect(onRename).toHaveBeenCalledWith('CHASSIS');
  });

  it('keeps the old name when the field is left empty', async () => {
    const onRename = vi.fn();
    render(<RenameField name="CUBE" onRename={onRename} onCancel={() => {}} />);

    const field = screen.getByRole('textbox', { name: 'Rename CUBE' });
    await userEvent.clear(field);
    await userEvent.type(field, '{Enter}');

    expect(onRename).toHaveBeenCalledWith('CUBE');
  });

  it('hands Escape to the caller rather than committing', async () => {
    const onRename = vi.fn();
    const onCancel = vi.fn();
    render(<RenameField name="CUBE" onRename={onRename} onCancel={onCancel} />);

    await userEvent.type(screen.getByRole('textbox', { name: 'Rename CUBE' }), 'X{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
  });
});
