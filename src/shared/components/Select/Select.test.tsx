import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Select } from './Select';

const options = [
  { value: 'unity', label: 'UNITY' },
  { value: 'unreal', label: 'UNREAL' },
  { value: 'blender', label: 'BLENDER' },
] as const;

describe('Select', () => {
  it('renders the current value', () => {
    render(<Select label="PRESET" value="unreal" options={options} onChange={() => {}} />);
    expect(screen.getByLabelText('PRESET')).toHaveValue('unreal');
  });

  it('reports the chosen option', async () => {
    const onChange = vi.fn();
    render(<Select label="PRESET" value="unity" options={options} onChange={onChange} />);

    await userEvent.selectOptions(screen.getByLabelText('PRESET'), 'blender');

    expect(onChange).toHaveBeenCalledWith('blender');
  });
});
