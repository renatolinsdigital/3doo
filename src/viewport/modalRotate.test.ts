import { describe, expect, it } from 'vitest';

import { shortestAngle } from './Viewport';

describe('shortestAngle', () => {
  it('leaves a small step alone', () => {
    expect(shortestAngle(0.4)).toBeCloseTo(0.4);
    expect(shortestAngle(-0.4)).toBeCloseTo(-0.4);
  });

  it('folds a step that crosses the wrap point', () => {
    // Dragging from just under +pi to just over it comes out of `atan2` as a
    // jump of nearly a full turn backwards. Unfolded, the object would spin the
    // wrong way every time the pointer passed the far side of the pivot.
    const justUnder = Math.PI - 0.05;
    const justOver = -Math.PI + 0.05;

    expect(shortestAngle(justOver - justUnder)).toBeCloseTo(0.1);
    expect(shortestAngle(justUnder - justOver)).toBeCloseTo(-0.1);
  });

  it('never returns a step longer than half a turn', () => {
    for (const delta of [-7, -Math.PI, -1, 0, 1, Math.PI, 7, 100]) {
      const folded = shortestAngle(delta);
      expect(folded).toBeGreaterThan(-Math.PI - 1e-9);
      expect(folded).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('accumulates past a full turn instead of resetting', () => {
    // A running total is what lets a drag carry round more than once. Walking
    // the pointer all the way round in steps has to add up to a whole turn.
    const steps = 24;
    let previous = 0;
    let total = 0;

    for (let step = 1; step <= steps; step++) {
      // Bearings as `atan2` would report them: wrapped into (-pi, pi].
      const bearing = shortestAngle((step / steps) * 2 * Math.PI);
      total += shortestAngle(bearing - previous);
      previous = bearing;
    }

    expect(total).toBeCloseTo(2 * Math.PI, 5);
  });
});
