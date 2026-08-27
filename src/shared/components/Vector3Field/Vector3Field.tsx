import type { Vec3 } from '@kernel/index';

import { FieldRow } from '../FieldRow/FieldRow';
import { NumberField } from '../NumberField/NumberField';

const AXES = ['x', 'y', 'z'] as const;

export type Axis = (typeof AXES)[number];

export interface Vector3FieldProps {
  value: Vec3;
  onChange: (value: Vec3) => void;
  /**
   * Section caption. Given one, the three fields are wrapped in a `FieldRow`;
   * without it they are bare siblings of whatever else the panel stacks.
   */
  legend?: string;
  /** Prefixes each axis letter, as "REL X". The letter alone without it. */
  labelPrefix?: string;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  hint?: (axis: Axis) => string;
}

/** The X/Y/Z triple that every vector in the UI is edited through. */
export function Vector3Field({
  value,
  onChange,
  legend,
  labelPrefix,
  step,
  suffix,
  disabled,
  hint,
}: Vector3FieldProps) {
  const fields = AXES.map((axis) => (
    <NumberField
      key={axis}
      label={labelPrefix ? `${labelPrefix} ${axis.toUpperCase()}` : axis.toUpperCase()}
      value={value[axis]}
      step={step}
      suffix={suffix}
      disabled={disabled}
      hint={hint?.(axis)}
      onChange={(next) => onChange({ ...value, [axis]: next })}
    />
  ));

  if (!legend) return <>{fields}</>;

  return (
    <FieldRow legend={legend} columns={1}>
      {fields}
    </FieldRow>
  );
}
