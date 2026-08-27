import { useId, type ReactNode } from 'react';

import { useEditorStore } from '@store/index';

import './Panel.scss';

export interface PanelProps {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  /**
   * Lets the panel body scroll instead of growing the layout.
   *
   * Off by default, and deliberately: a panel keeps its own height and the
   * column it sits in scrolls as one, so the body has nothing to scroll — but
   * the container it takes to do the scrolling clips whatever hangs out of it,
   * and the menu a `Select` drops is exactly that. Only a panel given a height
   * of its own has any use for this.
   */
  scrollable?: boolean;
  className?: string;
}

/**
 * A titled region that folds away.
 *
 * The title is the handle, so a panel collapses from the strip it is already
 * named by; `actions` stays beside it rather than inside it, since a control
 * nested in a button is neither clickable nor announceable.
 *
 * Collapsed panels are keyed by title in the store and travel in the project
 * file, so a layout someone arranged around their work comes back with it.
 */
export function Panel({ title, children, actions, scrollable = false, className }: PanelProps) {
  const collapsed = useEditorStore((state) => state.collapsedPanels[title] ?? false);
  const togglePanel = useEditorStore((state) => state.togglePanel);
  const bodyId = useId();

  return (
    <section
      className={['panel', collapsed ? 'panel--collapsed' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      aria-label={title}
    >
      <header className="panel__header">
        <h2 className="panel__title">
          <button
            type="button"
            className="panel__toggle"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={() => togglePanel(title)}
          >
            <span className="panel__caret" aria-hidden="true">
              {collapsed ? '▸' : '▾'}
            </span>
            {title}
          </button>
        </h2>
        {actions ? <div className="panel__actions">{actions}</div> : null}
      </header>
      {collapsed ? null : (
        <div id={bodyId} className={`panel__body${scrollable ? ' panel__body--scroll' : ''}`}>
          {children}
        </div>
      )}
    </section>
  );
}
