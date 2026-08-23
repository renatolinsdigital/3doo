import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('reflects the checked state', () => {
    render(<Toggle label="GRID" checked onChange={() => {}} />);
    expect(screen.getByRole('checkbox', { name: 'GRID' })).toBeChecked();
  });

  it('reports the new value when clicked', async () => {
    const onChange = vi.fn();
    render(<Toggle label="X-RAY" checked={false} onChange={onChange} />);

    await userEvent.click(screen.getByRole('checkbox', { name: 'X-RAY' }));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not change when disabled', async () => {
    const onChange = vi.fn();
    render(<Toggle label="NORMALS" checked={false} disabled onChange={onChange} />);

    await userEvent.click(screen.getByRole('checkbox', { name: 'NORMALS' }));

    expect(onChange).not.toHaveBeenCalled();
  });
});
