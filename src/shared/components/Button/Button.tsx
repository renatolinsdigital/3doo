import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';

import './Button.scss';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: ButtonVariant;
  icon?: ReactNode;
  active?: boolean;
  fullWidth?: boolean;
  /** Shown on hover/focus after a short delay; off when the user disables tooltips. */
  hint?: string;
}

export function Button({
  label,
  variant = 'secondary',
  icon,
  active = false,
  fullWidth = false,
  hint,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  const tooltip = useTooltipTrigger(hint);
  const classes = [
    'button',
    `button--${variant}`,
    active ? 'button--active' : '',
    fullWidth ? 'button--full' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      aria-pressed={active || undefined}
      {...rest}
      {...tooltip}
    >
      {icon ? (
        <span className="button__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="button__label">{label}</span>
    </button>
  );
}
