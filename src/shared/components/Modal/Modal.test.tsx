import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(
      <Modal title="EXPORT" open={false} onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders as a labelled modal dialog when open', () => {
    render(
      <Modal title="EXPORT" open onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'EXPORT' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Modal title="EXPORT" open onClose={onClose}>
        <p>body</p>
      </Modal>,
    );

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes from the close button', async () => {
    const onClose = vi.fn();
    render(
      <Modal title="EXPORT" open onClose={onClose}>
        <p>body</p>
      </Modal>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
