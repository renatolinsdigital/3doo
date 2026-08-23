import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('names the button from its label, not the glyph', () => {
    render(<IconButton label="Extrude" icon="E" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Extrude' })).toBeInTheDocument();
  });

  it('shows the shortcut in the tooltip', () => {
    render(<IconButton label="Extrude" icon="E" shortcut="E" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Extrude' })).toHaveAttribute(
      'title',
      'Extrude (E)',
    );
  });

  it('fires on click', async () => {
    const onClick = vi.fn();
    render(<IconButton label="Bevel" icon="B" onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'Bevel' }));

    expect(onClick).toHaveBeenCalledOnce();
  });
});
