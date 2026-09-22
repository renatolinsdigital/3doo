import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';
import { cx } from '../../utils/cx';

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
  disabled = false,
  onClick,
  ...rest
}: ButtonProps) {
  const tooltip = useTooltipTrigger(hint);

  /**
   * Runs the click, then drops the focus if a pointer brought it.
   *
   * A clicked button keeps the focus, and Enter on a focused button is a
   * second click: press BOX and then Enter, and the scene gets two boxes. A
   * keyboard activation reports no click count, and that one keeps its focus,
   * because a hand on the keyboard has nowhere else to put it and pressing
   * Enter twice there is a deliberate second press.
   */
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail > 0) event.currentTarget.blur();
    onClick?.(event);
  };
  const classes = cx(
    'button',
    `button--${variant}`,
    active && 'button--active',
    fullWidth && 'button--full',
    className,
  );

  return (
    <button
      type={type}
      className={classes}
      aria-pressed={active || undefined}
      // `aria-disabled` rather than the native attribute: a disabled button
      // fires no pointer events and takes no focus, which makes its hint
      // unreachable, and the hint is the one thing that says why the button
      // is unavailable, so that is exactly when it is needed most.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : handleClick}
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
