import { describe, expect, it } from 'vitest';

import { polygonArea, vec3, type Vec3 } from '../math';

import { triangulatePolygon } from './triangulate';

/** What the triangulation actually paints, counting any overlap twice. */
function paintedArea(points: readonly Vec3[]): number {
  const indices = triangulatePolygon(points);
  let total = 0;
  for (let i = 0; i < indices.length; i += 3) {
    total += polygonArea([points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]]);
  }
  return total;
}

/** The diagonal the split ran along, as the pair of corner indices it joins. */
function diagonal(points: readonly Vec3[]): string {
  const indices = triangulatePolygon(points);
  const first = indices.slice(0, 3);
  const second = indices.slice(3, 6);
  return first
    .filter((index) => second.includes(index))
    .sort((a, b) => a - b)
    .join('-');
}

/** A quad folded inwards at one corner, in the XY plane. */
function concaveQuad(reflexAt: number): Vec3[] {
  // Folded at index 2 as written (the third corner sits inside the triangle
  // the other three make), then rotated so the fold lands where it is wanted.
  // Deliberately a dart: the diagonal through the fold is the *longer* of the
  // two, which is the case a shorter-diagonal rule gets wrong.
  const ring = [vec3(-5, 0, 0), vec3(0, -1, 0), vec3(-0.2, 0, 0), vec3(0, 1, 0)];
  const shift = (reflexAt - 2 + 4) % 4;
  return ring.map((_, index) => ring[(index - shift + 4) % 4]);
}

describe('triangulating a quad', () => {
  it('splits a concave quad through the corner that folds inwards', () => {
    // The other diagonal lies outside the outline: it bridges the dent, and the
    // two triangles then cover ground the quad itself does not.
    expect(diagonal(concaveQuad(0))).toBe('0-2');
    expect(diagonal(concaveQuad(1))).toBe('1-3');
    expect(diagonal(concaveQuad(2))).toBe('0-2');
    expect(diagonal(concaveQuad(3))).toBe('1-3');
  });

  it('paints exactly the quad, whichever corner is folded and whichever way it is wound', () => {
    for (let reflexAt = 0; reflexAt < 4; reflexAt++) {
      for (const ring of [concaveQuad(reflexAt), [...concaveQuad(reflexAt)].reverse()]) {
        // A fan across the dent paints the folded corner twice over, so the
        // painted total runs above the quad's own area.
        expect(paintedArea(ring)).toBeCloseTo(polygonArea(ring), 10);
      }
    }
  });

  it('still takes the shorter diagonal when the quad is convex', () => {
    // Which is what keeps a long thin quad from being split into two slivers.
    const across = [vec3(0, 0, 0), vec3(1, 0, 0), vec3(4, 1, 0), vec3(0, 1, 0)];
    expect(diagonal(across)).toBe('1-3');

    const along = [vec3(0, 0, 0), vec3(4, 0, 0), vec3(1, 1, 0), vec3(0, 1, 0)];
    expect(diagonal(along)).toBe('0-2');
  });

  it('still triangulates a quad that is not flat', () => {
    // Boolean seams leave plenty of these; the projection is what makes them
    // workable, and it must not fall over.
    const bent = [vec3(0, 0, 0), vec3(1, 0, 0.2), vec3(1, 1, 0), vec3(0, 1, -0.2)];
    expect(triangulatePolygon(bent)).toHaveLength(6);
  });
});
