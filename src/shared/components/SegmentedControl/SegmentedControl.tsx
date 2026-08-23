import './SegmentedControl.scss';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  shortcut?: string;
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
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={`segmented__item${active ? ' segmented__item--active' : ''}`}
            aria-pressed={active}
            title={option.shortcut ? `${option.label} (${option.shortcut})` : option.label}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
