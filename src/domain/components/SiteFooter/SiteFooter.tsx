import './SiteFooter.scss';

export interface SiteFooterProps {
  className?: string;
}

export function SiteFooter({ className }: SiteFooterProps) {
  return (
    <footer className={className ? `site-footer ${className}` : 'site-footer'}>
      <span>
        <strong>3DOO</strong> · LIGHTWEIGHT 3D EDITOR THAT RUNS IN THE BROWSER
      </span>
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
    </footer>
  );
}
