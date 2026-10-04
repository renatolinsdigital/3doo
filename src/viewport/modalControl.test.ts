import { describe, expect, it } from 'vitest';

import { pressesModalControl } from './Viewport';

describe('pressesModalControl', () => {
  it('lets a press on the buttons that finish a modal operation through', () => {
    const bar = document.createElement('div');
    bar.innerHTML =
      '<button data-modal-control=""><span>CANCEL</span></button><button>UNDO</button>';
    document.body.append(bar);

    const [cancel, undo] = bar.querySelectorAll('button');
    const press = (target: Element) => {
      const event = new Event('pointerdown', { bubbles: true });
      Object.defineProperty(event, 'target', { value: target });
      return pressesModalControl(event);
    };

    // The label inside the button counts as the button.
    expect(press(cancel.querySelector('span') as Element)).toBe(true);
    expect(press(undo)).toBe(false);
    bar.remove();
  });
});
