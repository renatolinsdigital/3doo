import { useId } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';
import { cx } from '../../utils/cx';

import './Select.scss';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string> {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Keeps the accessible name but drops the visible label cell. */
  hideLabel?: boolean;
  hint?: string;
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  hideLabel = false,
  hint,
}: SelectProps<T>) {
  const id = useId();
  const tooltip = useTooltipTrigger(hint);

  return (
    <div className={cx('select', hideLabel && 'select--bare')} {...tooltip}>
      <label className={hideLabel ? 'u-visually-hidden' : 'select__label'} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="select__input"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
