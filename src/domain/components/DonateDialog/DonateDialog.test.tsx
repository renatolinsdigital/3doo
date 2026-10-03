import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DonateDialog, PAYPAL_EMAIL } from './DonateDialog';

/** The PayPal page the donate button opened, read back as its query. */
function openedQuery(open: { mock: { calls: unknown[][] } }) {
  return new URL(open.mock.calls[0][0] as string).searchParams;
}

describe('DonateDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the PayPal donation page with the picked amount', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<DonateDialog open onClose={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: '$10' }));
    await userEvent.click(screen.getByRole('button', { name: /DONATE \$10 WITH PAYPAL/ }));

    const query = openedQuery(open);
    expect(query.get('business')).toBe(PAYPAL_EMAIL);
    expect(query.get('amount')).toBe('10.00');
    expect(query.get('currency_code')).toBe('USD');
  });

  it('lets a typed amount, comma decimals included, override the presets', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<DonateDialog open onClose={() => {}} />);

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Other amount in US dollars' }),
      '7,5',
    );

    expect(screen.getByRole('button', { name: '$5' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: /DONATE \$7\.50 WITH PAYPAL/ }));
    expect(openedQuery(open).get('amount')).toBe('7.50');
  });

  it('refuses an amount of zero', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<DonateDialog open onClose={() => {}} />);

    await userEvent.type(screen.getByRole('textbox', { name: 'Other amount in US dollars' }), '0');
    await userEvent.click(screen.getByRole('button', { name: /ENTER AN AMOUNT/ }));

    expect(open).not.toHaveBeenCalled();
  });

  it('copies the PayPal address', async () => {
    const user = userEvent.setup();
    render(<DonateDialog open onClose={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'COPY' }));

    await expect(navigator.clipboard.readText()).resolves.toBe(PAYPAL_EMAIL);
    expect(screen.getByRole('button', { name: 'COPIED' })).toBeInTheDocument();
  });
});
