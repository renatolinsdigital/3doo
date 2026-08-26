import { describe, expect, it } from 'vitest';

import { proportionalRadiusStep } from './Viewport';

describe('proportionalRadiusStep', () => {
  it('grows on a wheel-up notch and shrinks on a wheel-down one', () => {
    expect(proportionalRadiusStep(1, -120)).toBeGreaterThan(1);
    expect(proportionalRadiusStep(1, 120)).toBeLessThan(1);
  });

  it('undoes itself: a notch each way comes back to where it started', () => {
    expect(proportionalRadiusStep(proportionalRadiusStep(2, -120), 120)).toBeCloseTo(2, 2);
  });

  it('changes by the same proportion at any size', () => {
    // Additive steps would crawl at scene scale and jump wildly at millimetres.
    const small = proportionalRadiusStep(0.1, -120) / 0.1;
    const large = proportionalRadiusStep(100, -120) / 100;

    expect(small).toBeCloseTo(large, 3);
  });

  it('never scrolls the falloff away to nothing', () => {
    let radius = 1;
    for (let notch = 0; notch < 200; notch += 1) radius = proportionalRadiusStep(radius, 120);

    expect(radius).toBeGreaterThan(0);
  });

  it('rounds to the three decimals the radius field shows', () => {
    const radius = proportionalRadiusStep(1.4641, -120);
    expect(radius).toBe(Number(radius.toFixed(3)));
  });
});
