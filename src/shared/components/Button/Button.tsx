import type { ButtonHTMLAttributes, ReactNode } from 'react';

import './Button.scss';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: ButtonVariant;
  icon?: ReactNode;
  active?: boolean;
  fullWidth?: boolean;
}

export function Button({
  label,
  variant = 'secondary',
  icon,
  active = false,
  fullWidth = false,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
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
    <button type={type} className={classes} aria-pressed={active || undefined} {...rest}>
      {icon ? (
        <span className="button__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="button__label">{label}</span>
    </button>
  );
}
