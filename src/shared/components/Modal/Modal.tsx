import { type ReactNode, useEffect, useRef } from 'react';

import { cx } from '../../utils/cx';

import './Modal.scss';

export interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** On the dialog box itself, for one that needs a size of its own. */
  className?: string;
}

/**
 * Marks an element inside a dialog that answers Escape itself, as a code
 * editor does to close its suggestions: the dialog leaves the key to it.
 */
export const OWNS_ESCAPE = 'data-owns-escape';

/** Marks the element a dialog should focus as it opens, in place of the box. */
export const AUTOFOCUS = 'data-autofocus';

export function Modal({ title, open, onClose, children, footer, className }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    // Focus moves into the dialog on open and back to the trigger on close, so
    // keyboard users are never dropped at the top of the document.
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const target = dialogRef.current?.querySelector<HTMLElement>(`[${AUTOFOCUS}]`);
    (target ?? dialogRef.current)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      const owner = event.target instanceof Element && event.target.closest(`[${OWNS_ESCAPE}]`);
      if (event.key === 'Escape' && !owner) {
        event.stopPropagation();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className={cx('modal__dialog', className)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <h2 className="modal__title">{title}</h2>
          <button type="button" className="modal__close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
