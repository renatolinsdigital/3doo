import { useId } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';

import './Toggle.scss';

export interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  hint?: string;
}

export function Toggle({ label, checked, onChange, disabled = false, hint }: ToggleProps) {
  const id = useId();
  const tooltip = useTooltipTrigger(hint);

  return (
    <div className="toggle" {...tooltip}>
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
