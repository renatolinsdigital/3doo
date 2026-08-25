import { useSyncExternalStore } from 'react';

/**
 * The smallest router that covers three static paths.
 *
 * A dependency would buy nested routes, params and loaders, none of which this
 * has any use for: the module registry already says which path maps to which
 * area. `useSyncExternalStore` is what keeps every subscriber on the same
 * pathname in the same render, which a `useState` + listener pair does not
 * guarantee under concurrent rendering.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

function getSnapshot(): string {
  return window.location.pathname;
}

export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(null, '', path);
  for (const listener of listeners) listener();
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, getSnapshot, () => '/');
}
