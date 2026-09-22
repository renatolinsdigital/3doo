import { useEffect, useRef } from 'react';

import './Toast.scss';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastProps {
  variant: ToastVariant;
  message: string;
  onDismiss: () => void;
  /** Auto-dismiss delay; the progress bar is driven from the same value. */
  duration?: number;
  /**
   * How many times this message has been raised. Bumping it restarts the
   * countdown and replays the progress bar in place, which is what a repeat
   * of a message already on screen looks like.
   */
  issued?: number;
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

export function Toast({ variant, message, onDismiss, duration = 3000, issued = 1 }: ToastProps) {
  // Callers hand in an inline closure more often than not, and a timer keyed
  // on the callback would restart on every render of the host and never fire.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss.current(), duration);
    return () => window.clearTimeout(timer);
  }, [duration, issued]);

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
        // Remounting is what restarts the CSS animation from the top.
        key={issued}
        className="toast__progress"
        style={{ animationDuration: `${duration}ms` }}
        aria-hidden="true"
      />
    </div>
  );
}
