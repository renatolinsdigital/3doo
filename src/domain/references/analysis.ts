/**
 * Reading a picture of a subject: which pixels are the subject, the outline
 * round it, how wide it is at each height and the colours it is made of.
 *
 * Plain arithmetic on pixels, with no canvas, so all of it runs in a test. The
 * page decodes the picture and hands the pixels in (see `app/automation`).
 */

/** RGBA pixels, row by row from the top left, four bytes each: what a canvas reads back. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** One byte a pixel, row by row from the top left: 1 where the subject is. */
export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A pixel box, inclusive at both ends. */
export interface PixelBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface MaskOptions {
  /** `"auto"` reads it off the picture's border, or `"#rrggbb"`. */
  background?: string;
  /** How far a colour may stray from the background and still count as it, 0 to 1. */
  tolerance?: number;
  /** Count background-coloured gaps enclosed by the subject as background too. */
  holes?: boolean;
}

export interface SubjectMask {
  mask: Mask;
  /** The background as found, `#rrggbb`, or `transparent` when the picture has alpha. */
  background: string;
  /** Separate pieces the subject is in. */
  pieces: number;
  /** Pieces left out as not the subject: frames, rules, text and specks. */
  ignored: number;
}

export const DEFAULT_TOLERANCE = 0.12;

const hexByte = (value: number) =>
  Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0');

export const toHex = (r: number, g: number, b: number) =>
  `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;

function parseHex(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(hex) ? [...hex].map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
}

/**
 * The pieces of a mask, four-connected: each pixel's piece number, 0 for none,
 * and each piece's size in pixels, indexed by its number.
 */
export function pieces(mask: Mask): { labels: Int32Array; areas: number[] } {
  const { width, height, data } = mask;
  const labels = new Int32Array(width * height);
  const areas = [0];
  const stack: number[] = [];
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || labels[start]) continue;
    const label = areas.length;
    let area = 0;
    labels[start] = label;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop() as number;
      area++;
      const x = index % width;
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        index - width,
        index + width,
      ];
      for (const next of neighbours) {
        if (next < 0 || next >= data.length || !data[next] || labels[next]) continue;
        labels[next] = label;
        stack.push(next);
      }
    }
    areas.push(area);
  }
  return { labels, areas };
}

/**
 * How wide a band along the picture's edge the background is read from and
 * flooded in from: wide enough to reach past a frame drawn round a picture or
 * round one cell of a sheet.
 */
const edgeBand = (width: number, height: number) =>
  Math.max(2, Math.round(Math.min(width, height) * 0.015));

/**
 * Which pixels are the subject.
 *
 * A picture with transparency is read by its alpha. Otherwise the background
 * is the commonest colour along the edge, or the one given, and it is flooded
 * in from the edge, so a highlight inside the subject the colour of the
 * background stays part of it. That leaves a gap such as the inside of a
 * handle counted as subject too, unless `holes` is on, which a white shirt on
 * a white background would then lose.
 *
 * Then what is not the subject is left out: pieces a line or two thick, such
 * as a frame or a rule, and pieces under 1% of the largest, such as text,
 * a scale bar's numbers or specks. They are counted as `ignored`.
 */
export function subjectMask(raster: Raster, options: MaskOptions = {}): SubjectMask {
  const { width, height, data } = raster;
  const count = width * height;
  const tolerance = (options.tolerance ?? DEFAULT_TOLERANCE) * 255;
  const out = new Uint8Array(count);
  let background = 'transparent';

  let clear = 0;
  for (let i = 0; i < count; i++) if (data[i * 4 + 3] < 250) clear++;
  const byAlpha = options.background === undefined || options.background === 'auto';

  if (byAlpha && clear > count * 0.005) {
    for (let i = 0; i < count; i++) out[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  } else {
    const given = options.background && options.background !== 'auto';
    const colour = given ? parseHex(options.background as string) : edgeColour(raster);
    if (!colour) throw new Error(`The background has to be "auto" or "#rrggbb".`);
    background = toHex(...colour);

    const near = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const offset = i * 4;
      const apart = Math.max(
        Math.abs(data[offset] - colour[0]),
        Math.abs(data[offset + 1] - colour[1]),
        Math.abs(data[offset + 2] - colour[2]),
      );
      near[i] = apart <= tolerance ? 1 : 0;
    }

    const outside = new Uint8Array(count);
    const stack: number[] = [];
    const seed = (index: number) => {
      if (near[index] && !outside[index]) {
        outside[index] = 1;
        stack.push(index);
      }
    };
    const band = edgeBand(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < band || y < band || x >= width - band || y >= height - band) seed(y * width + x);
      }
    }
    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % width;
      if (x > 0) seed(index - 1);
      if (x < width - 1) seed(index + 1);
      if (index >= width) seed(index - width);
      if (index + width < count) seed(index + width);
    }

    for (let i = 0; i < count; i++) {
      out[i] = outside[i] || (options.holes && near[i]) ? 0 : 1;
    }
  }

  const mask: Mask = { width, height, data: out };
  const { labels, areas } = pieces(mask);
  const boxes = areas.map(() => ({ minX: width, minY: height, maxX: -1, maxY: -1 }));
  for (let i = 0; i < count; i++) {
    if (!labels[i]) continue;
    const box = boxes[labels[i]];
    const [x, y] = [i % width, Math.floor(i / width)];
    box.minX = Math.min(box.minX, x);
    box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y);
    box.maxY = Math.max(box.maxY, y);
  }
  // How thick a piece is on average: about 1 for a line one pixel wide, and
  // half its width or more for anything solid.
  const thickness = (label: number) => {
    const box = boxes[label];
    return areas[label] / (box.maxX - box.minX + 1 + box.maxY - box.minY + 1);
  };
  const labelsAll = areas.map((_, label) => label).slice(1);
  const solid = labelsAll.filter((label) => thickness(label) >= 3);
  const candidates = solid.length > 0 ? solid : labelsAll;
  const main = candidates.reduce((best, label) => (areas[label] > areas[best] ? label : best), 0);
  const largest = areas[main] ?? 0;
  const mainBox = boxes[main];
  const reach = 0.1 * Math.hypot(mainBox.maxX - mainBox.minX + 1, mainBox.maxY - mainBox.minY + 1);
  const apart = (label: number) => {
    const box = boxes[label];
    const dx = Math.max(0, box.minX - mainBox.maxX, mainBox.minX - box.maxX);
    const dy = Math.max(0, box.minY - mainBox.maxY, mainBox.minY - box.maxY);
    return Math.hypot(dx, dy);
  };
  // A small piece close to the subject is likely a part of it, a gem by a
  // staff; one off on its own is more likely a label.
  const keep = new Uint8Array(areas.length);
  for (const label of candidates) {
    const area = areas[label];
    if (area < Math.max(9, largest * 0.01)) continue;
    if (area < largest * 0.1 && apart(label) > reach) continue;
    keep[label] = 1;
  }
  for (let i = 0; i < count; i++) if (out[i] && !keep[labels[i]]) out[i] = 0;

  const kept = keep.reduce((sum, value) => sum + value, 0);
  return { mask, background, pieces: kept, ignored: labelsAll.length - kept };
}

/**
 * The commonest colour in the band along the edge. Colours are counted in
 * coarse buckets, so the noise of a photograph or a JPEG falls in one, and
 * the bucket's own pixels are averaged.
 */
function edgeColour(raster: Raster): [number, number, number] {
  const { width, height, data } = raster;
  const band = edgeBand(width, height);
  const buckets = new Map<number, number[]>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= band && y >= band && x < width - band && y < height - band) continue;
      const offset = (y * width + x) * 4;
      const [r, g, b] = [data[offset], data[offset + 1], data[offset + 2]];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const sum = buckets.get(key) ?? [0, 0, 0, 0];
      sum[0] += r;
      sum[1] += g;
      sum[2] += b;
      sum[3]++;
      buckets.set(key, sum);
    }
  }
  let best = [0, 0, 0, 1];
  for (const sum of buckets.values()) if (sum[3] > best[3]) best = sum;
  return [best[0] / best[3], best[1] / best[3], best[2] / best[3]].map(Math.round) as [
    number,
    number,
    number,
  ];
}

/** The box round every subject pixel, or null when there are none. */
export function maskBox(mask: Mask): PixelBox | null {
  const { width, height, data } = mask;
  let box: PixelBox | null = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!data[y * width + x]) continue;
      if (!box) box = { minX: x, minY: y, maxX: x, maxY: y };
      else {
        box.minX = Math.min(box.minX, x);
        box.maxX = Math.max(box.maxX, x);
        box.minY = Math.min(box.minY, y);
        box.maxY = Math.max(box.maxY, y);
      }
    }
  }
  return box;
}

/** Where the subject starts and ends along one row of pixels, or null if it is not in it. */
export function rowSpan(mask: Mask, y: number): [number, number] | null {
  const { width, data } = mask;
  let first = -1;
  let last = -1;
  for (let x = 0; x < width; x++) {
    if (!data[y * width + x]) continue;
    if (first < 0) first = x;
    last = x;
  }
  return first < 0 ? null : [first, last];
}

/** Where the subject starts and ends down one column of pixels, or null if it is not in it. */
export function columnSpan(mask: Mask, x: number): [number, number] | null {
  const { width, height, data } = mask;
  let first = -1;
  let last = -1;
  for (let y = 0; y < height; y++) {
    if (!data[y * width + x]) continue;
    if (first < 0) first = y;
    last = y;
  }
  return first < 0 ? null : [first, last];
}

/**
 * The outline round the largest piece of the subject, as pixel corners: `[x,
 * y]` with y down, one point wherever the outline turns. Holes are left out.
 *
 * It walks the pixel edges with the subject on its right, so the outline is
 * exactly the boundary of the pixels, and two pieces that meet only at a
 * corner stay apart, as they are when the pieces are counted.
 */
export function traceOutline(mask: Mask): [number, number][] {
  const { width, height } = mask;
  const { labels, areas } = pieces(mask);
  let largest = 0;
  for (let label = 1; label < areas.length; label++) {
    if (!largest || areas[label] > areas[largest]) largest = label;
  }
  if (!largest) return [];

  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && labels[y * width + x] === largest;
  const start = labels.indexOf(largest);
  const sx = start % width;
  const sy = Math.floor(start / width);

  // Corners are the lattice points between pixels; the pixel in the corner
  // of p that direction q points into is (p.x - 1, p.y - 1) shifted by q's
  // positive axes.
  const ahead = (px: number, py: number, qx: number, qy: number) =>
    inside(px + (qx > 0 ? 0 : -1), py + (qy > 0 ? 0 : -1));

  const points: [number, number][] = [[sx, sy]];
  let [px, py] = [sx, sy];
  let [dx, dy] = [1, 0];
  const limit = 4 * (width + 1) * (height + 1);
  for (let step = 0; step < limit; step++) {
    px += dx;
    py += dy;
    const [rx, ry] = [-dy, dx];
    const [lx, ly] = [dy, -dx];
    let [nx, ny] = [dx, dy];
    if (!ahead(px, py, dx + rx, dy + ry)) [nx, ny] = [rx, ry];
    else if (ahead(px, py, dx + lx, dy + ly)) [nx, ny] = [lx, ly];
    if (px === sx && py === sy && nx === 1 && ny === 0) break;
    if (nx !== dx || ny !== dy) points.push([px, py]);
    [dx, dy] = [nx, ny];
  }
  return points;
}

/** How far `p` is from the segment from `a` to `b`. */
function segmentDistance(p: readonly number[], a: readonly number[], b: readonly number[]) {
  const [vx, vy] = [b[0] - a[0], b[1] - a[1]];
  const lengthSq = vx * vx + vy * vy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / lengthSq));
  return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy);
}

/** The points of a loop that stay within `tolerance` of it, by Douglas-Peucker. */
function simplifyAt(points: readonly (readonly number[])[], tolerance: number): number[] {
  const n = points.length;
  let far = 0;
  let farthest = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (d > farthest) [far, farthest] = [i, d];
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const spans: [number, number][] = [
    [0, far],
    [far, n],
  ];
  while (spans.length > 0) {
    const [from, to] = spans.pop() as [number, number];
    const end = points[to % n];
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = from + 1; i < to; i++) {
      const d = segmentDistance(points[i], points[from], end);
      if (d > worstDistance) [worst, worstDistance] = [i, d];
    }
    if (worst >= 0) {
      keep[worst] = 1;
      spans.push([from, worst], [worst, to]);
    }
  }
  const kept: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) kept.push(i);
  return kept;
}

/**
 * A loop cut down to at most `limit` points, keeping as much of its shape as
 * that allows: the smallest tolerance, from `finest` up, that fits.
 */
export function simplifyLoop<T extends readonly number[]>(
  points: readonly T[],
  limit: number,
  finest = 0.5,
): T[] {
  if (points.length <= 3) return [...points];
  let kept = simplifyAt(points, finest);
  if (kept.length > limit) {
    let low = finest;
    let high = finest * 2;
    while (simplifyAt(points, high).length > limit) high *= 2;
    for (let i = 0; i < 30; i++) {
      const middle = (low + high) / 2;
      if (simplifyAt(points, middle).length > limit) low = middle;
      else high = middle;
    }
    kept = simplifyAt(points, high);
  }
  return kept.map((index) => points[index]);
}

/** Whether two segments cross, touching at a shared end aside. */
function crosses(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
) {
  const side = (p: readonly number[], q: readonly number[], r: readonly number[]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Where a loop crosses itself first, as one of the points by the crossing, or null. */
export function selfCrossing<T extends readonly number[]>(points: readonly T[]): T | null {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [a, b] = [points[i], points[(i + 1) % n]];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (crosses(a, b, points[j], points[(j + 1) % n])) return a;
    }
  }
  return null;
}

export interface ColourCluster {
  r: number;
  g: number;
  b: number;
  /** Share of the subject's pixels, 0 to 1. */
  share: number;
  /** The middle of where its pixels are, in pixels. */
  x: number;
  y: number;
}

/**
 * The main colours of the subject, largest share first, by k-means over its
 * pixels. Starts from the colour furthest from those already picked, so the
 * result is the same on every run. Colours under 2% of the subject are left out.
 */
export function dominantColours(raster: Raster, mask: Mask, most = 6): ColourCluster[] {
  const { width, data } = raster;
  const samples: number[] = [];
  const total = mask.data.reduce((sum, value) => sum + value, 0);
  if (total === 0) return [];
  const stride = Math.max(1, Math.floor(total / 20000));
  let seen = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (!mask.data[i]) continue;
    if (seen++ % stride === 0) samples.push(i);
  }

  const colour = (index: number) => [data[index * 4], data[index * 4 + 1], data[index * 4 + 2]];
  const apart = (a: number[], b: number[]) =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  const mean = [0, 0, 0];
  for (const index of samples) colour(index).forEach((value, c) => (mean[c] += value));
  let centres = [mean.map((value) => value / samples.length)];
  while (centres.length < most) {
    let best = -1;
    let bestApart = 24 ** 2;
    for (const index of samples) {
      const nearest = Math.min(...centres.map((centre) => apart(colour(index), centre)));
      if (nearest > bestApart) [best, bestApart] = [index, nearest];
    }
    if (best < 0) break;
    centres.push(colour(best));
  }

  const owner = new Int32Array(samples.length);
  for (let round = 0; round < 10; round++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    samples.forEach((index, s) => {
      const value = colour(index);
      let nearest = 0;
      for (let k = 1; k < centres.length; k++) {
        if (apart(value, centres[k]) < apart(value, centres[nearest])) nearest = k;
      }
      owner[s] = nearest;
      const sum = sums[nearest];
      sum[0] += value[0];
      sum[1] += value[1];
      sum[2] += value[2];
      sum[3]++;
    });
    centres = centres.map((centre, k) =>
      sums[k][3]
        ? [sums[k][0] / sums[k][3], sums[k][1] / sums[k][3], sums[k][2] / sums[k][3]]
        : centre,
    );
  }

  const clusters = centres.map((centre) => ({
    r: centre[0],
    g: centre[1],
    b: centre[2],
    n: 0,
    x: 0,
    y: 0,
  }));
  samples.forEach((index, s) => {
    const cluster = clusters[owner[s]];
    cluster.n++;
    cluster.x += (index % width) + 0.5;
    cluster.y += Math.floor(index / width) + 0.5;
  });
  return clusters
    .filter((cluster) => cluster.n / samples.length >= 0.02)
    .sort((a, b) => b.n - a.n)
    .map(({ r, g, b, n, x, y }) => ({ r, g, b, share: n / samples.length, x: x / n, y: y / n }));
}

/** How much of the two masks overlaps: shared pixels over pixels in either, 0 to 1. */
export function overlap(a: Mask, b: Mask): number {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] && b.data[i]) both++;
    if (a.data[i] || b.data[i]) either++;
  }
  return either === 0 ? 1 : both / either;
}
