import '@testing-library/jest-dom/vitest';

// jsdom implements neither of these, and both are required just to mount the
// viewport container. Stubbing them here keeps every component test able to
// render the real component tree.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!HTMLCanvasElement.prototype.getContext) {
  HTMLCanvasElement.prototype.getContext = () => null;
}
