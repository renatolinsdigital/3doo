import type { Marquee } from './picking';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** The SVG shapes the selection overlay draws with. */
export interface MarqueeLayer {
  circle: SVGCircleElement;
  polygon: SVGPolygonElement;
}

/**
 * Adds the SVG the overlay draws its non-rectangular shapes in.
 *
 * Built once per overlay and kept: a drag repaints it on every pointer move.
 */
export function createMarqueeLayer(overlay: HTMLElement): MarqueeLayer {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'viewport-canvas__shape');

  const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
  const polygon = document.createElementNS(SVG_NAMESPACE, 'polygon');
  svg.append(circle, polygon);
  overlay.append(svg);

  return { circle, polygon };
}

/**
 * Draws the region a drag is sweeping out.
 *
 * A rectangle is the overlay itself, sized and placed. A circle and a lasso are
 * drawn in SVG over the whole canvas instead: a lasso has no box to size a div
 * with, and the reset lands `border-radius: 0 !important` on every element in
 * the app, so a round div is not something CSS here can be asked for.
 */
export function drawMarquee(overlay: HTMLElement, layer: MarqueeLayer, marquee: Marquee): void {
  overlay.style.display = 'block';

  if (marquee.kind === 'box') {
    overlay.classList.remove('viewport-canvas__marquee--drawn');
    clearMarqueeShapes(layer);
    overlay.style.left = `${marquee.left}px`;
    overlay.style.top = `${marquee.top}px`;
    overlay.style.width = `${marquee.width}px`;
    overlay.style.height = `${marquee.height}px`;
    return;
  }

  if (marquee.kind === 'circle') {
    layer.circle.setAttribute('cx', `${marquee.cx}`);
    layer.circle.setAttribute('cy', `${marquee.cy}`);
    layer.circle.setAttribute('r', `${marquee.radius}`);
    layer.polygon.setAttribute('points', '');
  } else {
    layer.polygon.setAttribute(
      'points',
      marquee.points.map((point) => `${point.x},${point.y}`).join(' '),
    );
    layer.circle.setAttribute('r', '0');
  }

  // The overlay stops being the shape and becomes the surface it is drawn on,
  // so the SVG's coordinates are the canvas's own.
  overlay.classList.add('viewport-canvas__marquee--drawn');
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
}

export function hideMarquee(overlay: HTMLElement, layer: MarqueeLayer | null): void {
  overlay.style.display = 'none';
  overlay.classList.remove('viewport-canvas__marquee--drawn');
  if (layer) clearMarqueeShapes(layer);
}

function clearMarqueeShapes(layer: MarqueeLayer): void {
  layer.circle.setAttribute('r', '0');
  layer.polygon.setAttribute('points', '');
}
