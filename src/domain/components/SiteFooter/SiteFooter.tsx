import { useCallback, useState } from 'react';

import { DonateDialog } from '../DonateDialog/DonateDialog';

import './SiteFooter.scss';

export interface SiteFooterProps {
  className?: string;
}

export function SiteFooter({ className }: SiteFooterProps) {
  const [donateOpen, setDonateOpen] = useState(false);
  // Stable on purpose: the modal re-runs its focus handling whenever onClose
  // changes, which would pull the focus out of a field on every keystroke.
  const closeDonate = useCallback(() => setDonateOpen(false), []);

  return (
    <>
      <footer className={className ? `site-footer ${className}` : 'site-footer'}>
        <span>
          <strong>3DOO</strong> · LIGHTWEIGHT 3D EDITOR THAT RUNS IN THE BROWSER
        </span>
        <div className="site-footer__end">
          <span>
            © {new Date().getFullYear()} BY{' '}
            <a
              className="site-footer__credit-link"
              href="https://www.linkedin.com/in/renatolinsdigital/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Renato Lins
            </a>
          </span>
          <button type="button" className="site-footer__donate" onClick={() => setDonateOpen(true)}>
            <span aria-hidden="true">♥</span> DONATE
          </button>
        </div>
      </footer>
      {/* Outside the footer, which would otherwise hand its muted mono type to the dialog. */}
      <DonateDialog open={donateOpen} onClose={closeDonate} />
    </>
  );
}
