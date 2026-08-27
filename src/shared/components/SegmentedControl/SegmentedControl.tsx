import type { ReactNode } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';
import { cx } from '../../utils/cx';

import './SegmentedControl.scss';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  shortcut?: string;
  /** Overrides the default "label (shortcut)" tooltip with a fuller description. */
  hint?: string;
}

export interface SegmentedControlProps<T extends string> {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <SegmentedItem
          key={option.value}
          option={option}
          active={option.value === value}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

export interface SegmentedToggleProps {
  label: string;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  /** Drawn before the label, and hidden from screen readers: the label says it. */
  icon?: ReactNode;
  /** Wear the icon alone: `label` becomes the accessible name, and the hint says the rest. */
  iconOnly?: boolean;
  disabled?: boolean;
  hint?: string;
  className?: string;
}

/**
 * One flag wearing the segmented control's clothes.
 *
 * Same button, same filled-and-underlined pressed state — but on its own, so a
 * row of them reads as a row of independent switches rather than as a set to
 * pick one of. It sits next to the mode picker in the top bar, where a flag has
 * to be as reachable as the mode it applies to.
 */
export function SegmentedToggle({
  label,
  pressed,
  onChange,
  icon,
  iconOnly = false,
  disabled = false,
  hint,
  className,
}: SegmentedToggleProps) {
  const tooltip = useTooltipTrigger(hint);

  return (
    <div
      className={cx('segmented', 'segmented--single', iconOnly && 'segmented--icon', className)}
    >
      <button
        type="button"
        className={cx('segmented__item', pressed && 'segmented__item--active')}
        aria-pressed={pressed}
        // The glyph is decoration either way, so with the label gone there is
        // no text left to name the button.
        aria-label={iconOnly ? label : undefined}
        // `aria-disabled` rather than the native attribute, as in `Button`: a
        // disabled button takes no focus and fires no pointer events, which is
        // exactly when its hint — the one thing saying why — is needed most.
        aria-disabled={disabled || undefined}
        onClick={disabled ? undefined : () => onChange(!pressed)}
        {...tooltip}
      >
        {icon ? (
          <span className="segmented__icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        {iconOnly ? null : label}
      </button>
    </div>
  );
}

interface SegmentedItemProps<T extends string> {
  option: SegmentedOption<T>;
  active: boolean;
  onChange: (value: T) => void;
}

function SegmentedItem<T extends string>({ option, active, onChange }: SegmentedItemProps<T>) {
  const tooltipText =
    option.hint ?? (option.shortcut ? `${option.label} (${option.shortcut})` : undefined);
  const tooltip = useTooltipTrigger(tooltipText);

  return (
    <button
      type="button"
      className={cx('segmented__item', active && 'segmented__item--active')}
      aria-pressed={active}
      onClick={() => onChange(option.value)}
      {...tooltip}
    >
      {option.label}
    </button>
  );
}
