import { useId } from 'react';

import './Toggle.scss';

export interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ label, checked, onChange, disabled = false }: ToggleProps) {
  const id = useId();

  return (
    <div className="toggle">
      <input
        id={id}
        className="toggle__input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label className="toggle__label" htmlFor={id}>
        <span className="toggle__box" aria-hidden="true">
          {checked ? '×' : ''}
        </span>
        <span className="toggle__text">{label}</span>
      </label>
    </div>
  );
}
