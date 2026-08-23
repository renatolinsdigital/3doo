import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { NumberField } from './NumberField';

describe('NumberField', () => {
  it('renders the labelled value', () => {
    render(<NumberField label="WIDTH" value={1.5} onChange={() => {}} />);
    expect(screen.getByLabelText('WIDTH')).toHaveValue('1.5');
  });

  it('commits a typed value on Enter', async () => {
    const onChange = vi.fn();
    render(<NumberField label="OFFSET" value={1} onChange={onChange} />);

    const input = screen.getByLabelText('OFFSET');
    await userEvent.clear(input);
    await userEvent.type(input, '2.25{Enter}');

    expect(onChange).toHaveBeenLastCalledWith(2.25);
  });

  it('clamps to the allowed range', async () => {
    const onChange = vi.fn();
    render(<NumberField label="SEGMENTS" value={2} min={1} max={8} onChange={onChange} />);

    const input = screen.getByLabelText('SEGMENTS');
    await userEvent.clear(input);
    await userEvent.type(input, '99{Enter}');

    expect(onChange).toHaveBeenLastCalledWith(8);
  });

  it('steps with the arrow keys', async () => {
    const onChange = vi.fn();
    render(<NumberField label="DEPTH" value={1} step={0.5} onChange={onChange} />);

    await userEvent.type(screen.getByLabelText('DEPTH'), '{ArrowUp}');

    expect(onChange).toHaveBeenLastCalledWith(1.5);
  });

  it('ignores non-numeric input and restores the value', async () => {
    const onChange = vi.fn();
    render(<NumberField label="RADIUS" value={3} onChange={onChange} />);

    const input = screen.getByLabelText('RADIUS');
    await userEvent.clear(input);
    await userEvent.type(input, 'abc');
    await userEvent.tab();

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('3');
  });
});
