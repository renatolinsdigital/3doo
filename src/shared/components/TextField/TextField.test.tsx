import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TextField } from './TextField';

describe('TextField', () => {
  it('names itself for assistive technology without drawing a label', () => {
    render(<TextField label="Project name" value="UNTITLED" onChange={() => {}} />);

    const field = screen.getByRole('textbox', { name: 'Project name' });
    expect(field).toHaveValue('UNTITLED');
    expect(screen.queryByText('Project name')).not.toBeInTheDocument();
  });

  it('reports every keystroke to the caller', async () => {
    const onChange = vi.fn();
    render(<TextField label="Project name" value="" onChange={onChange} />);

    await userEvent.type(screen.getByRole('textbox', { name: 'Project name' }), 'AB');

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('passes uncontrolled use straight through', async () => {
    const onBlur = vi.fn();
    render(<TextField label="Rename BOX" defaultValue="BOX" onBlur={onBlur} />);

    const field = screen.getByRole('textbox', { name: 'Rename BOX' });
    await userEvent.clear(field);
    await userEvent.type(field, 'CHASSIS');
    field.blur();

    expect(field).toHaveValue('CHASSIS');
    expect(onBlur).toHaveBeenCalled();
  });

  it('takes a height override, so a field can be taller than the default row', () => {
    render(<TextField label="Project name" height={64} defaultValue="" />);

    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveStyle({ height: '64px' });
  });
});
