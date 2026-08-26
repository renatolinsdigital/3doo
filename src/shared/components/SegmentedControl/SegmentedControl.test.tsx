import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import { SegmentedControl, SegmentedToggle } from './SegmentedControl';

const options = [
  { value: 'vertex', label: 'VERT', shortcut: '1' },
  { value: 'edge', label: 'EDGE', shortcut: '2' },
  { value: 'face', label: 'FACE', shortcut: '3' },
] as const;

describe('SegmentedControl', () => {
  beforeEach(() => {
    useEditorStore.setState({ hint: null, tooltipsEnabled: true });
  });

  it('marks only the selected option as pressed', () => {
    render(
      <SegmentedControl label="Select mode" options={options} value="edge" onChange={() => {}} />,
    );

    expect(screen.getByRole('button', { name: 'EDGE' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'VERT' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the chosen value', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl label="Select mode" options={options} value="vertex" onChange={onChange} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'FACE' }));

    expect(onChange).toHaveBeenCalledWith('face');
  });

  it('groups the options for assistive technology', () => {
    render(
      <SegmentedControl label="Select mode" options={options} value="vertex" onChange={() => {}} />,
    );

    expect(screen.getByRole('group', { name: 'Select mode' })).toBeInTheDocument();
  });

  it('shows the shortcut as a hint on focus', () => {
    render(
      <SegmentedControl label="Select mode" options={options} value="vertex" onChange={() => {}} />,
    );

    fireEvent.focus(screen.getByRole('button', { name: 'EDGE' }));

    expect(useEditorStore.getState().hint?.text).toBe('EDGE (2)');
  });
});

describe('SegmentedToggle', () => {
  beforeEach(() => {
    useEditorStore.setState({ hint: null, tooltipsEnabled: true });
  });

  it('reports the flipped value', async () => {
    const onChange = vi.fn();
    render(<SegmentedToggle label="ORTHOGRAPHIC" pressed={false} onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: 'ORTHOGRAPHIC' }));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('carries its pressed state', () => {
    render(<SegmentedToggle label="ORTHOGRAPHIC" pressed onChange={() => {}} />);

    expect(screen.getByRole('button', { name: 'ORTHOGRAPHIC' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('keeps its icon out of the accessible name', () => {
    render(<SegmentedToggle label="ORTHO" icon="▱" pressed={false} onChange={() => {}} />);

    // The glyph is decoration: a screen reader announcing "▱ ORTHO" reads it
    // out as whatever it happens to call that character.
    expect(screen.getByRole('button', { name: 'ORTHO' })).toBeInTheDocument();
  });

  it('keeps naming itself once the label is off the button', () => {
    render(<SegmentedToggle label="ORTHO" icon="▱" iconOnly pressed={false} onChange={() => {}} />);

    const button = screen.getByRole('button', { name: 'ORTHO' });
    expect(button).toHaveTextContent('▱');
    expect(button).not.toHaveTextContent('ORTHO');
  });

  it('stays reachable while disabled, so its hint can say why', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedToggle
        label="PROPORTIONAL"
        pressed={false}
        disabled
        hint="Switch to edit mode first"
        onChange={onChange}
      />,
    );

    const button = screen.getByRole('button', { name: 'PROPORTIONAL' });
    await userEvent.click(button);
    fireEvent.focus(button);

    expect(onChange).not.toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(useEditorStore.getState().hint?.text).toBe('Switch to edit mode first');
  });
});
