import { useId } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';

import './Slider.scss';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Written after the figure in the readout: a unit, or what it counts. */
  suffix?: string;
  disabled?: boolean;
  hint?: string;
  onChange: (value: number) => void;
}

/**
 * A field row whose value is dragged along a track rather than typed.
 *
 * For a setting with a real floor and ceiling, where the shape of the range
 * matters more than the exact figure: the readout beside the track still names
 * it, and the arrow keys still step it one at a time.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  disabled = false,
  hint,
  onChange,
}: SliderProps) {
  const id = useId();
  const tooltip = useTooltipTrigger(hint);

  return (
    <div className="slider" {...tooltip}>
      <label className="slider__label" htmlFor={id}>
        {label}
      </label>
      <span className="slider__control">
        <input
          id={id}
          className="slider__input"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {/* The range itself already announces its value: read out again here it
            would be said twice. */}
        <span className="slider__value" aria-hidden="true">
          {value}
          {suffix ? <span className="slider__suffix">{suffix}</span> : null}
        </span>
      </span>
    </div>
  );
}
