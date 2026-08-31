import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  circleRegion,
  ellipseRegion,
  lassoRegion,
  marqueeShape,
  rectangleRegion,
  regionForShape,
} from './picking';

const at = (x: number, y: number) => new THREE.Vector2(x, y);

describe('selection regions', () => {
  it('draws an oval for a circle drag, taking each radius from its own axis', () => {
    const start = at(100, 100);
    const end = at(130, 150);

    const marquee = marqueeShape('circle', start, end, [], false);
    const region = regionForShape('circle', start, end, [], false);

    // A real ellipse, described as one: a box would be drawn by CSS, and the
    // reset drops border-radius: 0 !important on every element in the app.
    expect(marquee).toEqual({ kind: 'ellipse', cx: 100, cy: 100, rx: 30, ry: 50 });
    // What is drawn is what is picked: out to each radius yes, the corner of
    // the box those radii describe no.
    expect(region.contains(at(100, 149))).toBe(true);
    expect(region.contains(at(129, 100))).toBe(true);
    expect(region.contains(at(126, 140))).toBe(false);
  });

  it('holds the oval round while Shift is down, growing it from the centre', () => {
    const start = at(100, 100);
    const end = at(100, 130);

    const marquee = marqueeShape('circle', start, end, [], true);
    const region = regionForShape('circle', start, end, [], true);

    // Both radii the distance to the pointer, so the circle grows the same
    // amount whichever way the drag goes.
    expect(marquee).toEqual({ kind: 'ellipse', cx: 100, cy: 100, rx: 30, ry: 30 });
    expect(region.contains(at(100, 129))).toBe(true);
    expect(region.contains(at(122, 122))).toBe(false);
    expect(region.contains(at(131, 100))).toBe(false);
  });

  it('sweeps nothing with an oval a drag straight along one axis never opened', () => {
    // No width at all: the guard is what keeps the scaled test off a division
    // by zero, which would put every point an infinite distance from the middle.
    const region = regionForShape('circle', at(100, 100), at(100, 130), [], false);

    expect(region.contains(at(100, 110))).toBe(false);
    expect(region.crosses(at(60, 110), at(140, 110))).toBe(false);
  });

  it('draws a rectangle over the drag itself', () => {
    const marquee = marqueeShape('box', at(30, 40), at(10, 100), [], false);
    const region = regionForShape('box', at(30, 40), at(10, 100), [], false);

    expect(marquee).toEqual({ kind: 'box', left: 10, top: 40, width: 20, height: 60 });
    expect(region.contains(at(11, 41))).toBe(true);
    expect(region.contains(at(31, 41))).toBe(false);
  });

  it('hands the lasso its own path to draw', () => {
    const path = [at(0, 0), at(10, 0), at(10, 10)];

    expect(marqueeShape('lasso', at(0, 0), at(10, 10), path, false)).toEqual({
      kind: 'lasso',
      points: path,
    });
  });

  it('picks the lasso path, not the box around it', () => {
    const path = [at(0, 0), at(30, 0), at(30, 10), at(10, 10), at(10, 30), at(0, 30)];

    const region = regionForShape('lasso', at(0, 0), at(0, 30), path, false);

    expect(region.contains(at(5, 20))).toBe(true);
    expect(region.contains(at(25, 20))).toBe(false);
  });

  it('takes what a rectangle covers', () => {
    const region = rectangleRegion({ minX: 10, minY: 10, maxX: 20, maxY: 20 });

    expect(region.contains(at(15, 15))).toBe(true);
    expect(region.contains(at(10, 20))).toBe(true);
    expect(region.contains(at(21, 15))).toBe(false);
  });

  it('takes what a circle covers, and not the corners of its box', () => {
    const region = circleRegion(at(100, 100), 10);

    expect(region.contains(at(100, 100))).toBe(true);
    expect(region.contains(at(110, 110))).toBe(false);
    expect(region.contains(at(109, 100))).toBe(true);
  });

  it('stretches an oval by each radius on its own', () => {
    const region = ellipseRegion(at(100, 100), 40, 10);

    // Four times as wide as it is tall, so a point the circle of radius 40
    // would hold is well outside this.
    expect(region.contains(at(139, 100))).toBe(true);
    expect(region.contains(at(100, 109))).toBe(true);
    expect(region.contains(at(100, 111))).toBe(false);
    // Inside the box the two radii describe, outside the oval inscribed in it.
    expect(region.contains(at(130, 109))).toBe(false);
  });

  it('is crossed by a segment that only clips the thin waist of an oval', () => {
    const region = ellipseRegion(at(100, 100), 40, 10);

    // Neither end inside, and a circle of radius 40 would be crossed by both:
    // the second passes over the flat top of this one instead.
    expect(region.crosses(at(20, 100), at(180, 100))).toBe(true);
    expect(region.crosses(at(20, 115), at(180, 115))).toBe(false);
  });

  it('takes what a lasso encloses, however it doubles back', () => {
    // A C shape: the notch between its arms is outside the loop even though it
    // sits well inside the bounding box.
    const region = lassoRegion([
      at(0, 0),
      at(30, 0),
      at(30, 10),
      at(10, 10),
      at(10, 20),
      at(30, 20),
      at(30, 30),
      at(0, 30),
    ]);

    expect(region.contains(at(5, 15))).toBe(true);
    expect(region.contains(at(20, 15))).toBe(false);
    expect(region.contains(at(20, 5))).toBe(true);
  });

  it('is crossed by a segment that passes through without stopping', () => {
    const rect = rectangleRegion({ minX: 10, minY: 10, maxX: 20, maxY: 20 });
    const circle = circleRegion(at(100, 100), 10);
    const lasso = lassoRegion([at(0, 0), at(30, 0), at(30, 30), at(0, 30)]);

    // Neither end is inside any of them; the middle is.
    expect(rect.crosses(at(0, 15), at(30, 15))).toBe(true);
    expect(circle.crosses(at(60, 100), at(140, 100))).toBe(true);
    expect(lasso.crosses(at(-10, 15), at(40, 15))).toBe(true);
  });

  it('is not crossed by a segment that stays clear', () => {
    const rect = rectangleRegion({ minX: 10, minY: 10, maxX: 20, maxY: 20 });
    const circle = circleRegion(at(100, 100), 10);
    const lasso = lassoRegion([at(0, 0), at(30, 0), at(30, 30), at(0, 30)]);

    expect(rect.crosses(at(0, 30), at(30, 30))).toBe(false);
    expect(circle.crosses(at(60, 120), at(140, 120))).toBe(false);
    expect(lasso.crosses(at(-10, 40), at(40, 40))).toBe(false);
  });

  it('is crossed however thin it is, where sampling along the edge would skip it', () => {
    // Four pixels tall: a walk in six-pixel steps steps straight over this.
    const sliver = rectangleRegion({ minX: 40, minY: 98, maxX: 160, maxY: 102 });

    expect(sliver.crosses(at(50, 50), at(50, 150))).toBe(true);
  });

  it('encloses nothing until the path is a shape', () => {
    expect(lassoRegion([at(0, 0), at(5, 5)]).contains(at(1, 1))).toBe(false);
  });
});
