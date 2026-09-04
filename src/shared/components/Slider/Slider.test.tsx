import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Slider } from './Slider';

describe('Slider', () => {
  it('carries its range and its value', () => {
    render(<Slider label="UNDO STEPS" value={30} min={10} max={50} onChange={() => {}} />);

    const input = screen.getByRole('slider', { name: 'UNDO STEPS' });
    expect(input).toHaveValue('30');
    expect(input).toHaveAttribute('min', '10');
    expect(input).toHaveAttribute('max', '50');
  });

  it('reports the figure it was dragged to as a number', () => {
    const onChange = vi.fn();
    render(<Slider label="UNDO STEPS" value={30} min={10} max={50} onChange={onChange} />);

    // A range reports a string; a preference stored as one would fail its own
    // bounds check on the way back in.
    fireEvent.change(screen.getByRole('slider', { name: 'UNDO STEPS' }), {
      target: { value: '35' },
    });

    expect(onChange).toHaveBeenCalledWith(35);
  });

  it('shows the figure beside the track', () => {
    render(
      <Slider label="UNDO STEPS" value={42} min={10} max={50} suffix="steps" onChange={() => {}} />,
    );

    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('steps')).toBeInTheDocument();
  });

  it('does not report a change when disabled', async () => {
    const onChange = vi.fn();
    render(<Slider label="UNDO STEPS" value={30} min={10} max={50} disabled onChange={onChange} />);

    const input = screen.getByRole('slider', { name: 'UNDO STEPS' });
    input.focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(onChange).not.toHaveBeenCalled();
  });
});
