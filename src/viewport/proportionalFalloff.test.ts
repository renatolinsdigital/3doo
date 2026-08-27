import { describe, expect, it } from 'vitest';

import { fitProportionalRadius, proportionalRadiusStep } from './Viewport';

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

describe('fitProportionalRadius', () => {
  // 0.01 radius units to the pixel across an 800px viewport: the ring may reach
  // 3.6 before it is wider than the view, and has to clear 0.32 to be seen.
  const perPixel = 0.01;
  const span = 800;

  it('caps a radius that would appear wider than the viewport', () => {
    expect(fitProportionalRadius(50, perPixel, span)).toBe(3.6);
  });

  it('grows a radius that would appear too small to make out', () => {
    expect(fitProportionalRadius(0.05, perPixel, span)).toBe(0.32);
  });

  it('leaves a radius the viewport can already show', () => {
    expect(fitProportionalRadius(2, perPixel, span)).toBe(2);
  });

  it('settles: a fitted radius is not moved again', () => {
    const capped = fitProportionalRadius(50, perPixel, 777);
    expect(fitProportionalRadius(capped, perPixel, 777)).toBe(capped);

    const grown = fitProportionalRadius(0.05, perPixel, span);
    expect(fitProportionalRadius(grown, perPixel, span)).toBe(grown);
  });

  it('leaves the radius alone when there is no view to measure against', () => {
    expect(fitProportionalRadius(2, 0, span)).toBe(2);
    expect(fitProportionalRadius(2, perPixel, 0)).toBe(2);
  });

  it('never fits the falloff away to nothing, however far the view is zoomed in', () => {
    expect(fitProportionalRadius(1, 1e-9, span)).toBeGreaterThan(0);
  });
});
