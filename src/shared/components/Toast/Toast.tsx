import { useEffect } from 'react';

import './Toast.scss';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastProps {
  variant: ToastVariant;
  message: string;
  onDismiss: () => void;
  /** Auto-dismiss delay; the progress bar is driven from the same value. */
  duration?: number;
}

const VARIANT_GLYPH: Record<ToastVariant, string> = {
  success: '✓',
  error: '✕',
  warning: '!',
  info: 'i',
};

const VARIANT_LABEL: Record<ToastVariant, string> = {
  success: 'Success',
  error: 'Error',
  warning: 'Warning',
  info: 'Information',
};

export function Toast({ variant, message, onDismiss, duration = 3000 }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  }, [duration, onDismiss]);

  return (
    <div
      className={`toast toast--${variant}`}
      // Errors interrupt; everything else waits for a pause in speech.
      role={variant === 'error' ? 'alert' : 'status'}
      aria-live={variant === 'error' ? 'assertive' : 'polite'}
    >
      <span className="toast__glyph" aria-hidden="true">
        {VARIANT_GLYPH[variant]}
      </span>
      <div className="toast__content">
        <span className="toast__variant">{VARIANT_LABEL[variant]}</span>
        <p className="toast__message">{message}</p>
      </div>
      <span
        className="toast__progress"
        style={{ animationDuration: `${duration}ms` }}
        aria-hidden="true"
      />
    </div>
  );
}
