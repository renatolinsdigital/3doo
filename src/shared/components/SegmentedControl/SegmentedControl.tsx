import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';

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
        <SegmentedItem key={option.value} option={option} active={option.value === value} onChange={onChange} />
      ))}
    </div>
  );
}

interface SegmentedItemProps<T extends string> {
  option: SegmentedOption<T>;
  active: boolean;
  onChange: (value: T) => void;
}

function SegmentedItem<T extends string>({ option, active, onChange }: SegmentedItemProps<T>) {
  const tooltipText = option.hint ?? (option.shortcut ? `${option.label} (${option.shortcut})` : undefined);
  const tooltip = useTooltipTrigger(tooltipText);

  return (
    <button
      type="button"
      className={`segmented__item${active ? ' segmented__item--active' : ''}`}
      aria-pressed={active}
      onClick={() => onChange(option.value)}
      {...tooltip}
    >
      {option.label}
    </button>
  );
}
