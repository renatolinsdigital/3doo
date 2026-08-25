import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import { Button } from './Button';

describe('Button', () => {
  beforeEach(() => {
    useEditorStore.setState({ hint: null, tooltipsEnabled: true });
  });

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

  it('drops its hint when pressed, instead of leaving it over the panel', async () => {
    render(<Button label="BEVEL" hint="Round off the selected edges" onClick={() => {}} />);
    const button = screen.getByRole('button', { name: 'BEVEL' });

    fireEvent.focus(button);
    expect(useEditorStore.getState().hint?.text).toBe('Round off the selected edges');

    // The press focuses the button as well, and that focus must not raise the
    // hint again while the pointer is still sitting on the control.
    await userEvent.click(button);

    expect(useEditorStore.getState().hint).toBeNull();
  });
});
