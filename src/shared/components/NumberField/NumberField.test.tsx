import { fireEvent, render, screen } from '@testing-library/react';
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

  it('rounds a typed fraction when the field is an integer', async () => {
    const onChange = vi.fn();
    render(<NumberField label="SEGMENTS" value={24} integer onChange={onChange} />);

    const input = screen.getByLabelText('SEGMENTS');
    await userEvent.clear(input);
    await userEvent.type(input, '10.286{Enter}');

    expect(onChange).toHaveBeenLastCalledWith(10);
  });

  it('steps an integer field by whole numbers', async () => {
    const onChange = vi.fn();
    render(<NumberField label="RINGS" value={12} integer onChange={onChange} />);

    await userEvent.type(screen.getByLabelText('RINGS'), '{ArrowUp}');

    expect(onChange).toHaveBeenLastCalledWith(13);
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

  it('refuses letters as they are typed, rather than showing them', async () => {
    render(<NumberField label="RADIUS" value={3} onChange={() => {}} />);

    const input = screen.getByLabelText('RADIUS');
    await userEvent.clear(input);
    await userEvent.type(input, '12a3b');

    // Nothing a number cannot follow ever reaches the field: what is left is
    // what was typed with the letters dropped.
    expect(input).toHaveValue('123');
  });

  it('lets a number be typed through the shapes it passes on the way', async () => {
    const onChange = vi.fn();
    render(<NumberField label="OFFSET" value={1} onChange={onChange} />);

    const input = screen.getByLabelText('OFFSET');
    await userEvent.clear(input);
    // "-" and "-0." are both on their way to -0.75 and neither is a number yet.
    await userEvent.type(input, '-0.75{Enter}');

    expect(onChange).toHaveBeenLastCalledWith(-0.75);
  });

  it('puts the value back when the field is emptied and left', async () => {
    const onChange = vi.fn();
    render(<NumberField label="RADIUS" value={3} onChange={onChange} />);

    const input = screen.getByLabelText('RADIUS');
    await userEvent.clear(input);
    await userEvent.tab();

    // An empty field is not a number, and reading it as zero would flatten
    // whatever it holds on the way out.
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('3');
  });

  it('reports the start and end of a scrub once each', async () => {
    const onScrubStart = vi.fn();
    const onScrubEnd = vi.fn();
    render(
      <NumberField
        label="LENGTH"
        value={1}
        onChange={() => {}}
        onScrubStart={onScrubStart}
        onScrubEnd={onScrubEnd}
      />,
    );

    const handle = screen.getByText('LENGTH');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10 });
    // The release that ends no scrub reports nothing.
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10 });

    expect(onScrubStart).toHaveBeenCalledTimes(1);
    expect(onScrubEnd).toHaveBeenCalledTimes(1);
  });

  it('leaves a disabled field unscrubbable', () => {
    const onScrubStart = vi.fn();
    const onChange = vi.fn();
    render(
      <NumberField
        label="LENGTH"
        value={1}
        disabled
        onChange={onChange}
        onScrubStart={onScrubStart}
      />,
    );

    const handle = screen.getByText('LENGTH');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40 });

    expect(onScrubStart).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
