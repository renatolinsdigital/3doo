import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SegmentedControl } from './SegmentedControl';

const options = [
  { value: 'vertex', label: 'VERT', shortcut: '1' },
  { value: 'edge', label: 'EDGE', shortcut: '2' },
  { value: 'face', label: 'FACE', shortcut: '3' },
] as const;

describe('SegmentedControl', () => {
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
});
