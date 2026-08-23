import type { ReactNode } from 'react';

import './Panel.scss';

export interface PanelProps {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  /** Lets the panel body scroll instead of growing the layout. */
  scrollable?: boolean;
  className?: string;
}

export function Panel({ title, children, actions, scrollable = true, className }: PanelProps) {
  return (
    <section className={['panel', className ?? ''].filter(Boolean).join(' ')} aria-label={title}>
      <header className="panel__header">
        <h2 className="panel__title">{title}</h2>
        {actions ? <div className="panel__actions">{actions}</div> : null}
      </header>
      <div className={`panel__body${scrollable ? ' panel__body--scroll' : ''}`}>{children}</div>
    </section>
  );
}
