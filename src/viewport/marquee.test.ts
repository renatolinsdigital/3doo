import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMarqueeLayer, drawMarquee, hideMarquee } from './marquee';
import { marqueeShape } from './picking';

describe('selection marquee', () => {
  let overlay: HTMLElement;
  let layer: ReturnType<typeof createMarqueeLayer>;

  beforeEach(() => {
    overlay = document.createElement('div');
    overlay.className = 'viewport-canvas__marquee';
    layer = createMarqueeLayer(overlay);
  });

  const drag = (shape: 'box' | 'circle' | 'lasso', from: [number, number], to: [number, number]) =>
    drawMarquee(
      overlay,
      layer,
      marqueeShape(shape, new THREE.Vector2(...from), new THREE.Vector2(...to), [
        new THREE.Vector2(...from),
        new THREE.Vector2(from[0], to[1]),
        new THREE.Vector2(...to),
      ]),
    );

  it('draws a circle drag as a circle', () => {
    drag('circle', [100, 100], [100, 130]);

    // An SVG circle, not a div with a border-radius: the app's reset drops
    // `border-radius: 0 !important` on every element, so a round div is not
    // something CSS here can be asked for.
    expect(layer.circle.getAttribute('r')).toBe('30');
    expect(layer.circle.getAttribute('cx')).toBe('100');
    expect(layer.circle.getAttribute('cy')).toBe('100');
    // The overlay is only the surface it is drawn on, stretched over the canvas.
    expect(overlay.classList.contains('viewport-canvas__marquee--drawn')).toBe(true);
    expect(overlay.style.width).toBe('100%');
  });

  it('draws a box drag as the overlay itself', () => {
    drag('box', [30, 40], [10, 100]);

    expect(overlay.style.left).toBe('10px');
    expect(overlay.style.top).toBe('40px');
    expect(overlay.style.width).toBe('20px');
    expect(overlay.style.height).toBe('60px');
    expect(overlay.classList.contains('viewport-canvas__marquee--drawn')).toBe(false);
  });

  it('draws a lasso drag as its own path', () => {
    drag('lasso', [0, 0], [10, 20]);

    expect(layer.polygon.getAttribute('points')).toBe('0,0 0,20 10,20');
    expect(layer.circle.getAttribute('r')).toBe('0');
  });

  it('leaves no shape behind when the next drag is a different one', () => {
    drag('lasso', [0, 0], [10, 20]);
    drag('circle', [50, 50], [50, 60]);
    expect(layer.polygon.getAttribute('points')).toBe('');

    drag('box', [0, 0], [5, 5]);
    expect(layer.circle.getAttribute('r')).toBe('0');
  });

  it('puts everything away when the drag ends', () => {
    drag('circle', [100, 100], [100, 130]);

    hideMarquee(overlay, layer);

    expect(overlay.style.display).toBe('none');
    expect(layer.circle.getAttribute('r')).toBe('0');
    expect(overlay.classList.contains('viewport-canvas__marquee--drawn')).toBe(false);
  });
});
