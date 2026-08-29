import { useId, useState, type ReactNode } from 'react';

import './Accordion.scss';

export interface AccordionProps {
  title: string;
  children: ReactNode;
  /** Starts expanded. The state is local, so it resets with whatever holds it. */
  defaultOpen?: boolean;
}

/**
 * A titled group of controls that folds away.
 *
 * `Panel` folds the same way for the layout, but keeps its state in the store
 * and carries it in the project file, right for a workspace someone arranged
 * around their work, wrong for the sections of a dialog, which nobody expects
 * to travel with a scene.
 */
export function Accordion({ title, children, defaultOpen = false }: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <section className="accordion">
      <h3 className="accordion__title">
        <button
          type="button"
          className="accordion__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="accordion__caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          {title}
        </button>
      </h3>
      {open ? (
        <div id={bodyId} className="accordion__body">
          {children}
        </div>
      ) : null}
    </section>
  );
}
