import { useEffect, useId, useRef, useState } from 'react';

import './NumberField.scss';

export interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places shown while the field is not being edited. */
  precision?: number;
  suffix?: string;
  disabled?: boolean;
}

function clamp(value: number, min?: number, max?: number): number {
  if (min !== undefined && value < min) return min;
  if (max !== undefined && value > max) return max;
  return value;
}

/**
 * Numeric input with drag-to-scrub.
 *
 * The displayed text is only synced from the prop while the field is idle, so
 * typing "0.0" does not get rewritten to "0" mid-entry.
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.1,
  precision = 3,
  suffix,
  disabled = false,
}: NumberFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState(() => String(value));
  const [editing, setEditing] = useState(false);
  const scrubbing = useRef<{ startX: number; startValue: number } | null>(null);

  useEffect(() => {
    if (!editing) setDraft(formatValue(value, precision));
  }, [value, precision, editing]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) onChange(clamp(parsed, min, max));
    else setDraft(formatValue(value, precision));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLLabelElement>) => {
    if (disabled) return;
    scrubbing.current = { startX: event.clientX, startValue: value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLLabelElement>) => {
    const state = scrubbing.current;
    if (!state) return;
    const delta = (event.clientX - state.startX) * step;
    onChange(clamp(Number((state.startValue + delta).toFixed(precision)), min, max));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLLabelElement>) => {
    scrubbing.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="number-field">
      <label
        className="number-field__label"
        htmlFor={id}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {label}
      </label>
      <div className="number-field__input-wrap">
        <input
          id={id}
          className="number-field__input"
          type="text"
          inputMode="decimal"
          value={draft}
          disabled={disabled}
          onFocus={() => setEditing(true)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => {
            setEditing(false);
            commit(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit(event.currentTarget.value);
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              setDraft(formatValue(value, precision));
              event.currentTarget.blur();
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              const direction = event.key === 'ArrowUp' ? 1 : -1;
              onChange(clamp(Number((value + step * direction).toFixed(precision)), min, max));
            }
          }}
        />
        {suffix ? <span className="number-field__suffix">{suffix}</span> : null}
      </div>
    </div>
  );
}

function formatValue(value: number, precision: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(precision)));
}
