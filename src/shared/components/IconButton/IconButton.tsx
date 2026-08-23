import type { ButtonHTMLAttributes, ReactNode } from 'react';

import './IconButton.scss';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: the icon glyph alone is never an accessible name. */
  label: string;
  icon: ReactNode;
  active?: boolean;
  shortcut?: string;
}

export function IconButton({
  label,
  icon,
  active = false,
  shortcut,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const classes = ['icon-button', active ? 'icon-button--active' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active || undefined}
      {...rest}
    >
      <span className="icon-button__glyph" aria-hidden="true">
        {icon}
      </span>
      {shortcut ? (
        <span className="icon-button__shortcut" aria-hidden="true">
          {shortcut}
        </span>
      ) : null}
    </button>
  );
}
