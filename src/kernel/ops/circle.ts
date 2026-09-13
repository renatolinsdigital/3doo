import {
  type Vec3,
  addScaled,
  basisFromNormal,
  centroid,
  clamp,
  distance,
  dot,
  lengthSq,
  lerp,
  mul,
  polygonNormal,
  sub,
} from '../math';
import type { BMesh } from '../mesh';
import type { Vert } from '../mesh/types';

import { findChains } from './chains';

export interface CircleOptions {
  /** 0..1 blend from where a vertex sits toward the circle it belongs on. */
  factor?: number;
}

/** A point on the plane the loop was flattened onto. */
interface Planar {
  x: number;
  y: number;
}

/**
 * The centre of the circle that fits `points` best, or null when they are too
 * straight to name one.
 *
 * The algebraic least-squares fit: every point is held against
 * `x² + y² + Dx + Ey + F = 0`, which is linear in D, E and F, so the best
 * circle falls out of a 2 by 2 solve rather than an iteration. The centroid of
 * the points is already the origin here, which is what cancels F and leaves the
 * two equations below.
 *
 * A least-squares fit rather than the centroid and a mean radius, because the
 * centroid is only the centre when the loop is closed and evenly sampled. An
 * arc, or a loop with one crowded side, sits off its own centroid, and a circle
 * drawn from there would swing the whole selection sideways.
 */
function fitCentre(points: readonly Planar[]): Planar | null {
  let xx = 0;
  let xy = 0;
  let yy = 0;
  let xxx = 0;
  let yyy = 0;
  let xyy = 0;
  let yxx = 0;

  for (const { x, y } of points) {
    xx += x * x;
    xy += x * y;
    yy += y * y;
    xxx += x * x * x;
    yyy += y * y * y;
    xyy += x * y * y;
    yxx += y * x * x;
  }

  const determinant = xx * yy - xy * xy;
  const moment = xx + yy;
  // Collinear, so every circle through them is as good as the next and the
  // best of them is the straight line they already make.
  if (moment === 0 || Math.abs(determinant) < 1e-12 * moment * moment) return null;

  const rx = (xxx + xyy) / 2;
  const ry = (yyy + yxx) / 2;
  return {
    x: (rx * yy - ry * xy) / determinant,
    y: (ry * xx - rx * xy) / determinant,
  };
}

/** Where each of `points` lands once the loop is rounded out, or null. */
function circleTargets(points: readonly Vec3[]): Vec3[] | null {
  const middle = centroid(points);
  const spread = Math.max(...points.map((point) => distance(point, middle)));
  if (spread === 0) return null;

  // Newell's normal is an area, so it falls away with the square of the loop:
  // one a fraction of a millimetre across would come out as no normal at all.
  // Fitting a unit-sized copy gives the same answer at every scale.
  const unit = points.map((point) => mul(sub(point, middle), 1 / spread));
  const normal = polygonNormal(unit);
  if (lengthSq(normal) === 0) return null;

  const { u, v } = basisFromNormal(normal);
  const flat = unit.map((point) => ({ x: dot(point, u), y: dot(point, v) }));

  const centre = fitCentre(flat);
  if (!centre) return null;

  const radii = flat.map((point) => Math.hypot(point.x - centre.x, point.y - centre.y));
  const radius = radii.reduce((total, each) => total + each, 0) / radii.length;

  return flat.map((point, i) => {
    // A vertex sitting on the centre points nowhere, so there is no direction
    // to carry it out along and the circle has nothing to say about it.
    if (radii[i] === 0) return points[i];

    const reach = radius / radii[i];
    const x = (centre.x + (point.x - centre.x) * reach) * spread;
    const y = (centre.y + (point.y - centre.y) * reach) * spread;
    return addScaled(addScaled(middle, u, x), v, y);
  });
}

/**
 * Rounds the selected loops out onto the circle that fits them best.
 *
 * The loop is flattened onto its own average plane and every vertex is carried
 * in or out to the one radius, keeping the direction it already sits in from
 * the centre. That is what rounds a loop off without reshuffling it: a vertex
 * ends up where it was, only rounder. Pair it with space when the loop wants
 * even gaps as well, which together turn any ring into a regular one.
 *
 * Each loop in the selection is fitted on its own, so both ends of a cylinder
 * can be rounded in one go. A loop too straight to name a circle, or shorter
 * than the three vertices a circle needs, is left alone.
 *
 * Returns how many vertices were moved.
 */
export function circleVerts(
  mesh: BMesh,
  verts: readonly Vert[],
  options: CircleOptions = {},
): number {
  const factor = clamp(options.factor ?? 1, 0, 1);
  if (factor === 0) return 0;

  const { chains } = findChains(mesh, verts);
  let moved = 0;

  for (const chain of chains) {
    if (chain.verts.length < 3) continue;

    const targets = circleTargets(chain.verts.map((vert) => vert.co));
    if (!targets) continue;

    chain.verts.forEach((vert, i) => {
      vert.co = lerp(vert.co, targets[i], factor);
    });
    moved += chain.verts.length;
  }

  if (moved > 0) mesh.computeNormals();
  return moved;
}
