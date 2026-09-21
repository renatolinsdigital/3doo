import { useEffect, useId, useRef, useState } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';
import { cx } from '../../utils/cx';

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
  /**
   * Keeps the accessible name but drops the visible label cell, for a field
   * standing in a bar rather than in a column of rows. The label cell is also
   * the scrub handle, so a bare field is typed and arrowed rather than dragged.
   */
  hideLabel?: boolean;
  hint?: string;
  /**
   * The label was pressed and a scrub is about to run, so every `onChange`
   * until `onScrubEnd` belongs to one gesture. A field whose edit is expensive
   * or undoable uses the pair to treat the whole drag as a single change
   * rather than one per pointer tick.
   */
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

/**
 * What a number is allowed to look like part-way through being typed.
 *
 * A keystroke that would take the field somewhere no number can follow is
 * refused outright, so letters never reach the field at all. Partial entries
 * are not: "-", "1." and ".5" are all on their way to a number, and the field
 * would be unusable if they were rejected as they were typed. Integer fields
 * take a decimal point too, and round what was typed when it is committed: a
 * refused point would quietly turn a pasted 10.286 into ten thousand.
 */
const NUMBER_DRAFT = /^-?\d*\.?\d*$/;

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
  hideLabel = false,
  hint,
  onScrubStart,
  onScrubEnd,
}: NumberFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState(() => String(value));
  const [editing, setEditing] = useState(false);
  const scrubbing = useRef<{ startX: number; startValue: number } | null>(null);
  const tooltip = useTooltipTrigger(hint);

  const resolvedStep = step ?? (integer ? 1 : 0.1);
  const resolvedPrecision = integer ? 0 : (precision ?? 3);

  // Every path that produces a value goes through here, so an integer field
  // can never emit a fraction, not by typing, scrubbing, or arrow-stepping.
  const quantize = (raw: number) =>
    clamp(integer ? Math.round(raw) : Number(raw.toFixed(resolvedPrecision)), min, max);

  useEffect(() => {
    if (!editing) setDraft(formatValue(value, resolvedPrecision));
  }, [value, resolvedPrecision, editing]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    // An empty field, or one left holding just "-" or ".", is a field on its
    // way somewhere rather than a number anyone typed. The value goes back
    // instead: read as written, an empty field means zero, and tabbing out of
    // one the user had only cleared would flatten whatever it holds.
    if (raw.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(formatValue(value, resolvedPrecision));
      return;
    }
    onChange(quantize(parsed));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLLabelElement>) => {
    if (disabled) return;
    scrubbing.current = { startX: event.clientX, startValue: value };
    event.currentTarget.setPointerCapture(event.pointerId);
    onScrubStart?.();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLLabelElement>) => {
    const state = scrubbing.current;
    if (!state) return;
    const delta = (event.clientX - state.startX) * resolvedStep;
    onChange(quantize(state.startValue + delta));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLLabelElement>) => {
    const wasScrubbing = scrubbing.current !== null;
    scrubbing.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (wasScrubbing) onScrubEnd?.();
  };

  return (
    <div className={cx('number-field', hideLabel && 'number-field--bare')} {...tooltip}>
      <label
        className={hideLabel ? 'u-visually-hidden' : 'number-field__label'}
        htmlFor={id}
        onPointerDown={hideLabel ? undefined : handlePointerDown}
        onPointerMove={hideLabel ? undefined : handlePointerMove}
        onPointerUp={hideLabel ? undefined : handlePointerUp}
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
          onChange={(event) => {
            const next = event.target.value;
            if (NUMBER_DRAFT.test(next)) setDraft(next);
          }}
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
