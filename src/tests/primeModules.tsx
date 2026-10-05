import { render, waitFor } from '@testing-library/react';

import { App } from '../app/App';

/**
 * The shell loads each module on demand, and React renders a lazy component
 * asynchronously the first time only. Mounting every route once up front lets
 * the tests that follow keep querying synchronously.
 */
export async function primeModules(paths: string[]) {
  for (const path of paths) {
    window.history.pushState(null, '', path);
    const { container, unmount } = render(<App />);
    await waitFor(() => expect(container.childElementCount).toBeGreaterThan(0), {
      timeout: 20000,
    });
    unmount();
  }
}
