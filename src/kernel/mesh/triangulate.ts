import { type Vec3, basisFromNormal, dot, polygonNormal } from '../math';

interface Point2 {
  x: number;
  y: number;
  index: number;
}

function signedArea(points: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area * 0.5;
}

function isConvex(prev: Point2, current: Point2, next: Point2): boolean {
  return (
    (current.x - prev.x) * (next.y - prev.y) - (current.y - prev.y) * (next.x - prev.x) > 0
  );
}

function pointInTriangle(p: Point2, a: Point2, b: Point2, c: Point2): boolean {
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/**
 * Ear-clipping triangulation of a simple polygon.
 *
 * Returns index triples into `points`, wound to match `normal`. The polygon is
 * projected onto the plane defined by that normal first, so non-planar n-gons
 * still produce a usable fan as long as they do not self-intersect after
 * projection.
 */
export function triangulatePolygon(points: readonly Vec3[], normal?: Vec3): number[] {
  const count = points.length;
  if (count < 3) return [];
  if (count === 3) return [0, 1, 2];

  const n = normal ?? polygonNormal(points);
  const { u, v } = basisFromNormal(n);

  let projected: Point2[] = points.map((point, index) => ({
    x: dot(point, u),
    y: dot(point, v),
    index,
  }));

  if (count === 4) {
    // Split the quad on its shorter diagonal to avoid sliver triangles.
    const [a, b, c, d] = projected;
    const diagonal1 = (a.x - c.x) ** 2 + (a.y - c.y) ** 2;
    const diagonal2 = (b.x - d.x) ** 2 + (b.y - d.y) ** 2;
    return diagonal1 <= diagonal2 ? [0, 1, 2, 0, 2, 3] : [1, 2, 3, 1, 3, 0];
  }

  const reversed = signedArea(projected) < 0;
  if (reversed) projected = [...projected].reverse();

  const triangles: number[] = [];
  const remaining = [...projected];
  let guard = remaining.length * remaining.length + 16;

  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;

    for (let i = 0; i < remaining.length; i++) {
      const prev = remaining[(i - 1 + remaining.length) % remaining.length];
      const current = remaining[i];
      const next = remaining[(i + 1) % remaining.length];

      if (!isConvex(prev, current, next)) continue;

      let containsOther = false;
      for (const candidate of remaining) {
        if (candidate === prev || candidate === current || candidate === next) continue;
        if (pointInTriangle(candidate, prev, current, next)) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) continue;

      triangles.push(prev.index, current.index, next.index);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }

    // Degenerate or self-intersecting input: fall back to a fan so the face is
    // still drawable rather than silently disappearing from the viewport.
    if (!clipped) break;
  }

  if (remaining.length === 3) {
    triangles.push(remaining[0].index, remaining[1].index, remaining[2].index);
  } else if (remaining.length > 3) {
    for (let i = 1; i < remaining.length - 1; i++) {
      triangles.push(remaining[0].index, remaining[i].index, remaining[i + 1].index);
    }
  }

  // Clipping ran over a reversed copy, so undo the flip to keep the returned
  // triples wound the same way as the incoming vertex order.
  if (reversed) {
    for (let i = 0; i < triangles.length; i += 3) {
      const swap = triangles[i + 1];
      triangles[i + 1] = triangles[i + 2];
      triangles[i + 2] = swap;
    }
  }

  return triangles;
}
