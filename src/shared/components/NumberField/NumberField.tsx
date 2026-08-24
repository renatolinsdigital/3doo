import { useEffect, useId, useRef, useState } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';

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
  /** Counts (segments, rings, subdivisions) that must never carry a fraction. */
  integer?: boolean;
  suffix?: string;
  disabled?: boolean;
  hint?: string;
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
  step,
  precision,
  integer = false,
  suffix,
  disabled = false,
  hint,
}: NumberFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState(() => String(value));
  const [editing, setEditing] = useState(false);
  const scrubbing = useRef<{ startX: number; startValue: number } | null>(null);
  const tooltip = useTooltipTrigger(hint);

  const resolvedStep = step ?? (integer ? 1 : 0.1);
  const resolvedPrecision = integer ? 0 : (precision ?? 3);

  // Every path that produces a value goes through here, so an integer field
  // can never emit a fraction — not by typing, scrubbing, or arrow-stepping.
  const quantize = (raw: number) =>
    clamp(integer ? Math.round(raw) : Number(raw.toFixed(resolvedPrecision)), min, max);

  useEffect(() => {
    if (!editing) setDraft(formatValue(value, resolvedPrecision));
  }, [value, resolvedPrecision, editing]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) onChange(quantize(parsed));
    else setDraft(formatValue(value, resolvedPrecision));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLLabelElement>) => {
    if (disabled) return;
    scrubbing.current = { startX: event.clientX, startValue: value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLLabelElement>) => {
    const state = scrubbing.current;
    if (!state) return;
    const delta = (event.clientX - state.startX) * resolvedStep;
    onChange(quantize(state.startValue + delta));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLLabelElement>) => {
    scrubbing.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="number-field" {...tooltip}>
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
          inputMode={integer ? 'numeric' : 'decimal'}
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
              setDraft(formatValue(value, resolvedPrecision));
              event.currentTarget.blur();
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              const direction = event.key === 'ArrowUp' ? 1 : -1;
              onChange(quantize(value + resolvedStep * direction));
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
