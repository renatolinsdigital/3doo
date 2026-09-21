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

// jsdom has no PointerEvent, and without one a fired pointer event falls back
// to a plain Event that carries no coordinates, so a dragged field reads every
// move as happening in the same place. A mouse event already carries what a
// scrub reads, and the id is the only thing missing from it.
if (!('PointerEvent' in globalThis)) {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;

    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }

  globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

// Pointer capture is another jsdom gap, and it is what every drag-to-scrub
// field holds the pointer with. Tracked per element so a test can drag one
// without the release throwing on the way back out.
if (!Element.prototype.setPointerCapture) {
  const captured = new WeakMap<Element, Set<number>>();

  Element.prototype.setPointerCapture = function setPointerCapture(pointerId: number) {
    const ids = captured.get(this) ?? new Set<number>();
    ids.add(pointerId);
    captured.set(this, ids);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(pointerId: number) {
    captured.get(this)?.delete(pointerId);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(pointerId: number) {
    return captured.get(this)?.has(pointerId) ?? false;
  };
}
