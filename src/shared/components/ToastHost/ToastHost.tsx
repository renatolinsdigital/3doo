import { useEditorStore } from '@store/index';

import { Toast } from '../Toast/Toast';

import './ToastHost.scss';

/** Stacks active toasts in the corner; each one dismisses itself on a timer. */
export function ToastHost() {
  const toasts = useEditorStore((state) => state.toasts);
  const dismissToast = useEditorStore((state) => state.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          variant={toast.variant}
          message={toast.message}
          onDismiss={() => dismissToast(toast.id)}
        />
      ))}
    </div>
  );
}
