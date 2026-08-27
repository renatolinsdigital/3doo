import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';
import { cx } from '../../utils/cx';

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
  disabled = false,
  onClick,
  ...rest
}: IconButtonProps) {
  const tooltipText = hint ?? (shortcut ? `${label} (${shortcut})` : label);
  const tooltip = useTooltipTrigger(tooltipText);
  const classes = cx('icon-button', active && 'icon-button--active', className);

  return (
    <button
      type={type}
      className={classes}
      aria-label={label}
      aria-pressed={active || undefined}
      // See Button: the native attribute would take the hint down with it.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
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
