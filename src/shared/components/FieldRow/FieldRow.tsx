import type { ReactNode } from 'react';

import './FieldRow.scss';

export interface FieldRowProps {
  children: ReactNode;
  /** Section caption rendered above the row. */
  legend?: string;
  columns?: 1 | 2 | 3;
}

/** Layout primitive for grouping form controls inside a panel. */
export function FieldRow({ children, legend, columns = 1 }: FieldRowProps) {
  return (
    <div className="field-row">
      {legend ? <span className="field-row__legend">{legend}</span> : null}
      <div className={`field-row__grid field-row__grid--${columns}`}>{children}</div>
    </div>
  );
}
