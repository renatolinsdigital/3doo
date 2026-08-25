import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';

describe('Button', () => {
  it('renders its label', () => {
    render(<Button label="EXTRUDE" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'EXTRUDE' })).toBeInTheDocument();
  });

  it('calls onClick when pressed', async () => {
    const onClick = vi.fn();
    render(<Button label="INSET" onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'INSET' }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('exposes the active state to assistive technology', () => {
    render(<Button label="MOVE" active onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'MOVE' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not fire when disabled', async () => {
    const onClick = vi.fn();
    render(<Button label="BEVEL" disabled onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'BEVEL' }));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('stays hoverable and focusable while disabled, so its hint is reachable', () => {
    render(<Button label="BEVEL" disabled hint="Select edges first" onClick={() => {}} />);
    const button = screen.getByRole('button', { name: 'BEVEL' });

    // A natively disabled button reports no hover and takes no focus, which
    // would hide the very hint that explains why it cannot be pressed.
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();

    button.focus();
    expect(button).toHaveFocus();
  });
});
