import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AUTOFOCUS, Modal, OWNS_ESCAPE } from './Modal';

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

  it('leaves Escape to an element inside it that answers the key itself', async () => {
    const onClose = vi.fn();
    render(
      <Modal title="SCRIPT" open onClose={onClose}>
        <textarea aria-label="Code" {...{ [OWNS_ESCAPE]: '' }} />
      </Modal>,
    );

    await userEvent.click(screen.getByRole('textbox', { name: 'Code' }));
    await userEvent.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
  });

  it('focuses the element marked for it as it opens', () => {
    render(
      <Modal title="SCRIPT" open onClose={() => {}}>
        <button type="button">first</button>
        <textarea aria-label="Code" {...{ [AUTOFOCUS]: '' }} />
      </Modal>,
    );

    expect(screen.getByRole('textbox', { name: 'Code' })).toHaveFocus();
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
