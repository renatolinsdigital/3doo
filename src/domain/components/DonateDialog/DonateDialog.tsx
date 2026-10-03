import { useEffect, useId, useState } from 'react';

import { Button, Modal, TextField } from '@shared/components';
import { cx } from '@shared/utils/cx';

import './DonateDialog.scss';

export const PAYPAL_EMAIL = 'renato.digital.crafts@gmail.com';

const PRESETS = [3, 5, 10, 25];

export interface DonateDialogProps {
  open: boolean;
  onClose: () => void;
}

function paypalDonateUrl(dollars: number) {
  const params = new URLSearchParams({
    business: PAYPAL_EMAIL,
    amount: dollars.toFixed(2),
    currency_code: 'USD',
    item_name: 'Support 3DOO',
  });
  return `https://www.paypal.com/donate/?${params}`;
}

function formatDollars(dollars: number) {
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}

/**
 * The offer to support the project, reached from the page footers.
 *
 * Two routes to the same PayPal account: a donation page opened with the
 * amount already filled in, and the address itself for anyone who would rather
 * send from their own PayPal app.
 */
export function DonateDialog({ open, onClose }: DonateDialogProps) {
  const [preset, setPreset] = useState(5);
  const [other, setOther] = useState('');
  const [copy, setCopy] = useState<'idle' | 'copied' | 'blocked'>('idle');
  const emailId = useId();

  const typed = other.trim();
  // Much of the world writes seven and a half dollars as 7,50.
  const cents = typed ? Math.round(Number(typed.replace(',', '.')) * 100) : preset * 100;
  const valid = Number.isFinite(cents) && cents > 0;
  const dollars = cents / 100;

  useEffect(() => {
    if (copy !== 'copied') return;
    const timer = window.setTimeout(() => setCopy('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copy]);

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(PAYPAL_EMAIL);
      setCopy('copied');
    } catch {
      // The clipboard API is missing outside a secure context and a browser
      // may refuse it. With the address selected, the copy shortcut still works.
      const field = document.getElementById(emailId) as HTMLInputElement | null;
      field?.focus();
      field?.select();
      setCopy('blocked');
    }
  };

  return (
    <Modal title="SUPPORT 3DOO" open={open} onClose={onClose}>
      <div className="donate__lead">
        <p className="donate__headline">KEEP 3DOO FREE</p>
        <p className="donate__pitch">
          No install, no account, no ads. A donation pays for the hours behind the next release.
        </p>
      </div>

      <div className="donate__amounts" role="group" aria-label="Amount in US dollars">
        {PRESETS.map((value) => {
          const active = !typed && value === preset;
          return (
            <button
              key={value}
              type="button"
              className={cx('donate__amount', active && 'donate__amount--active')}
              aria-pressed={active}
              onClick={() => {
                setPreset(value);
                setOther('');
              }}
            >
              {formatDollars(value)}
            </button>
          );
        })}
      </div>

      <label className="donate__other">
        <span className="donate__other-label">OTHER $</span>
        <TextField
          className="donate__other-field"
          label="Other amount in US dollars"
          inputMode="decimal"
          placeholder="0.00"
          value={other}
          onChange={(event) => setOther(event.target.value.replace(/[^\d.,]/g, ''))}
        />
      </label>

      <Button
        className="donate__go"
        label={valid ? `DONATE ${formatDollars(dollars)} WITH PAYPAL` : 'ENTER AN AMOUNT'}
        variant="primary"
        icon="♥"
        fullWidth
        disabled={!valid}
        onClick={() => window.open(paypalDonateUrl(dollars), '_blank', 'noopener,noreferrer')}
      />

      <div className="donate__direct">
        <p className="donate__caption">OR SEND ANY AMOUNT BY PAYPAL TO</p>
        <div className="donate__email">
          <TextField
            id={emailId}
            className="donate__email-field"
            label="PayPal address"
            value={PAYPAL_EMAIL}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button label={copy === 'copied' ? 'COPIED' : 'COPY'} onClick={() => void copyEmail()} />
        </div>
        <p className="donate__status" role="status">
          {copy === 'blocked'
            ? 'The browser blocked copying, so the address is selected: press your copy shortcut.'
            : null}
        </p>
      </div>

      <p className="donate__fine">
        PayPal takes the payment. 3DOO never sees your card or account.
      </p>
    </Modal>
  );
}
