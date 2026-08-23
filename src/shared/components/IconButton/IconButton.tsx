import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';

import './IconButton.scss';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: the icon glyph alone is never an accessible name. */
  label: string;
  icon: ReactNode;
  active?: boolean;
  shortcut?: string;
  /** Overrides the default "label (shortcut)" tooltip with a fuller description. */
  hint?: string;
}

export function IconButton({
  label,
  icon,
  active = false,
  shortcut,
  hint,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const tooltipText = hint ?? (shortcut ? `${label} (${shortcut})` : label);
  const tooltip = useTooltipTrigger(tooltipText);
  const classes = ['icon-button', active ? 'icon-button--active' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      aria-label={label}
      aria-pressed={active || undefined}
      {...rest}
      {...tooltip}
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
