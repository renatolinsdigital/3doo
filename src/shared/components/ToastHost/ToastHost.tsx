import { useEditorStore } from '@store/index';

import { Toast } from '../Toast/Toast';

import './ToastHost.scss';

/**
 * How many toasts may be on screen at once.
 *
 * Anything past this waits its turn and takes the next free slot, because a
 * stack tall enough to reach the top of the viewport covers the work behind it.
 */
const MAX_VISIBLE = 4;

/** Stacks active toasts in the corner; each one dismisses itself on a timer. */
export function ToastHost() {
  const toasts = useEditorStore((state) => state.toasts);
  const dismissToast = useEditorStore((state) => state.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host">
      {toasts.slice(0, MAX_VISIBLE).map((toast) => (
        <Toast
          key={toast.id}
          variant={toast.variant}
          message={toast.message}
          issued={toast.issued}
          onDismiss={() => dismissToast(toast.id)}
        />
      ))}
    </div>
  );
}
