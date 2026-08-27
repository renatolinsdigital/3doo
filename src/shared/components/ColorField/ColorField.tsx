import { useId } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';

import './ColorField.scss';

export interface ColorFieldProps {
  label: string;
  /** Hex, as an `<input type="color">` reads and writes it. */
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}

/** A swatch row laid out like `NumberField`, so the two line up in a column. */
export function ColorField({ label, value, hint, onChange }: ColorFieldProps) {
  const id = useId();
  const tooltip = useTooltipTrigger(hint);

  return (
    <div className="color-field" {...tooltip}>
      <label className="color-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="color-field__swatch"
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
