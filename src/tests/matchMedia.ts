/**
 * Stands a `matchMedia` in for the one jsdom does not have, answering the
 * queries given as matching and every other as not. Hands back what puts the
 * window as it was.
 */
export function mockMatchMedia(matching: readonly string[]): () => void {
  const had = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matching.includes(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  return () => {
    if (had) Object.defineProperty(window, 'matchMedia', had);
    else delete (window as { matchMedia?: unknown }).matchMedia;
  };
}
