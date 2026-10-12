import { type StraightView, VIEW_AXES, VIEW_PLANES } from '@kernel/index';

import {
  type Mask,
  type MaskOptions,
  type PixelBox,
  type Raster,
  columnSpan,
  dominantColours,
  maskBox,
  overlap,
  rowSpan,
  selfCrossing,
  simplifyLoop,
  subjectMask,
  toHex,
  traceOutline,
} from './analysis';

/**
 * A picture of what is being modelled, seen straight on from one of the six
 * views, and measured in world metres.
 *
 * The subject's size is given, so the picture has a scale. It is placed with
 * the middle of the subject on the view's vertical axis and, seen from the
 * side, its foot on the ground, so references from the front and the side of
 * one subject line up with each other and with a model built standing at the
 * origin.
 */
export interface Reference {
  id: string;
  view: StraightView;
  /** The file it came from, for messages. */
  source: string;
  raster: Raster;
  mask: Mask;
  /** The subject's pixels, inclusive. */
  box: PixelBox;
  metresPerPixel: number;
  /** The pixel corner that is 0 across and 0 up. */
  originX: number;
  originY: number;
  /** The background as found: `#rrggbb`, or `transparent`. */
  background: string;
  pieces: number;
  /** Pieces left out as not the subject: frames, rules, text and specks. */
  ignored: number;
}

export interface ReferenceInput extends MaskOptions {
  id: string;
  view: StraightView;
  source: string;
  raster: Raster;
  /** The subject's height in the picture, in metres. Give this or `width`. */
  height?: number;
  /** The subject's width in the picture, in metres. */
  width?: number;
}

const references = new Map<string, Reference>();

/** Rounded to a tenth of a millimetre, which is finer than any picture resolves. */
const round = (value: number) => Math.round(value * 1e4) / 1e4 || 0;

/** Measures a picture and keeps it under its id, in place of one already there. */
export function addReference(input: ReferenceInput): Reference {
  const { mask, background, pieces, ignored } = subjectMask(input.raster, input);
  const box = maskBox(mask);
  if (!box) {
    throw new Error(
      `Found no subject in ${input.source}: it is all background. Pass the colour behind the subject as background, or a lower tolerance.`,
    );
  }
  const count = mask.data.reduce((sum, value) => sum + value, 0);
  if (count > mask.data.length * 0.97) {
    throw new Error(
      `Found no background in ${input.source}: the subject fills the picture. Crop it out of a plain background, or pass the background colour.`,
    );
  }

  const across = box.maxX + 1 - box.minX;
  const tall = box.maxY + 1 - box.minY;
  const metresPerPixel =
    input.height !== undefined ? input.height / tall : (input.width as number) / across;
  const side = input.view !== 'top' && input.view !== 'bottom';

  const reference: Reference = {
    id: input.id,
    view: input.view,
    source: input.source,
    raster: input.raster,
    mask,
    box,
    metresPerPixel,
    originX: (box.minX + box.maxX + 1) / 2,
    originY: side ? box.maxY + 1 : (box.minY + box.maxY + 1) / 2,
    background,
    pieces,
    ignored,
  };
  references.set(input.id, reference);
  return reference;
}

/** The reference with that id, or why there is none. */
export function getReference(id: string): Reference {
  const found = references.get(id);
  if (found) return found;
  const ids = [...references.keys()];
  throw new Error(
    ids.length === 0
      ? `There is no reference "${id}": none is loaded. An AI assistant loads them with the load_reference tool of the MCP server.`
      : `There is no reference "${id}". The references are ${ids.map((known) => `"${known}"`).join(', ')}.`,
  );
}

export function referenceIds(): string[] {
  return [...references.keys()];
}

export function clearReferences(): void {
  references.clear();
}

/**
 * Where a point of the picture is in the world, as the two values a view
 * spans (`[x, y]` from the front). Takes pixel corners, so a pixel's middle is
 * half a pixel in.
 */
export function toWorld(reference: Reference, px: number, py: number): [number, number] {
  const across = (px - reference.originX) * reference.metresPerPixel;
  const up = (reference.originY - py) * reference.metresPerPixel;
  const { right, up: upward } = VIEW_AXES[reference.view];
  const [h, v] = VIEW_PLANES[reference.view];
  return [round(across * right[h] + up * upward[h]), round(across * right[v] + up * upward[v])];
}

/** Where a world point of the view's plane is in the picture, in pixels: `toWorld` undone. */
export function toPixel(reference: Reference, h: number, v: number): [number, number] {
  // Each straight-on view runs one world axis across its picture and the other
  // up it, so each value comes from one direction alone.
  const { right, up } = VIEW_AXES[reference.view];
  const [across, upward] = VIEW_PLANES[reference.view];
  return [
    reference.originX + h / right[across] / reference.metresPerPixel,
    reference.originY - v / up[upward] / reference.metresPerPixel,
  ];
}

/** The world box round a box of pixels, as the lowest and highest of each value. */
function worldBox(reference: Reference, box: PixelBox) {
  const [a, b] = [
    toWorld(reference, box.minX, box.maxY + 1),
    toWorld(reference, box.maxX + 1, box.minY),
  ];
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1])] as [number, number],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1])] as [number, number],
  };
}

export interface ReferenceSummary {
  id: string;
  view: StraightView;
  /** The world axes the picture spans, across then up. */
  axes: readonly [string, string];
  /** The picture as measured, in pixels. */
  pixels: [number, number];
  metresPerPixel: number;
  /** The subject's width and height in the picture, in metres. */
  size: [number, number];
  /** Where the subject is. */
  bounds: { min: [number, number]; max: [number, number] };
  /** Where the whole picture reaches. */
  covers: { min: [number, number]; max: [number, number] };
  background: string;
  pieces: number;
  ignored: number;
}

export function summarize(reference: Reference): ReferenceSummary {
  const { raster, box, metresPerPixel } = reference;
  return {
    id: reference.id,
    view: reference.view,
    axes: VIEW_PLANES[reference.view],
    pixels: [raster.width, raster.height],
    metresPerPixel: Math.round(metresPerPixel * 1e7) / 1e7,
    size: [
      round((box.maxX + 1 - box.minX) * metresPerPixel),
      round((box.maxY + 1 - box.minY) * metresPerPixel),
    ],
    bounds: worldBox(reference, box),
    covers: worldBox(reference, {
      minX: 0,
      minY: 0,
      maxX: raster.width - 1,
      maxY: raster.height - 1,
    }),
    background: reference.background,
    pieces: reference.pieces,
    ignored: reference.ignored,
  };
}

export interface TraceOptions {
  /** The most points the outline may have. Default 64. */
  points?: number;
  /** How many heights the profile is measured at. Default 24. */
  rows?: number;
}

export interface ReferenceTrace extends ReferenceSummary {
  /** The outline round the largest piece, as world points on the view's axes. */
  outline: [number, number][];
  /** False when cutting the outline down made it cross itself: ask for more points. */
  simple: boolean;
  /** How wide the subject is at evenly spaced heights, bottom to top. */
  profile: { at: number; from: number; to: number }[];
  /** Its main colours, largest share first, each with the middle of where it is. */
  colours: { color: string; share: number; at: [number, number] }[];
}

export const DEFAULT_TRACE_POINTS = 64;
export const DEFAULT_TRACE_ROWS = 24;

/** The reference's outline, profile and colours, in world metres. */
export function traceReference(reference: Reference, options: TraceOptions = {}): ReferenceTrace {
  const { mask, box } = reference;
  const corners = simplifyLoop(traceOutline(mask), options.points ?? DEFAULT_TRACE_POINTS);
  const outline = corners.map(([x, y]) => toWorld(reference, x, y));

  const rows = options.rows ?? DEFAULT_TRACE_ROWS;
  const tall = box.maxY + 1 - box.minY;
  const profile: ReferenceTrace['profile'] = [];
  for (let row = 0; row < rows; row++) {
    // Evenly spaced heights, each measured along the row of pixels it falls in.
    const height = box.minY + ((row + 0.5) * tall) / rows;
    const y = Math.min(box.maxY, Math.floor(height));
    const span = rowSpan(mask, y);
    if (!span) continue;
    const a = toWorld(reference, span[0], height);
    const b = toWorld(reference, span[1] + 1, height);
    profile.push({ at: a[1], from: Math.min(a[0], b[0]), to: Math.max(a[0], b[0]) });
  }
  profile.sort((p, q) => p.at - q.at);

  return {
    ...summarize(reference),
    outline,
    simple: selfCrossing(outline) === null,
    profile,
    colours: dominantColours(reference.raster, mask).map((cluster) => ({
      color: toHex(cluster.r, cluster.g, cluster.b),
      share: Math.round(cluster.share * 1000) / 1000,
      at: toWorld(reference, cluster.x, cluster.y),
    })),
  };
}

export interface Comparison {
  /** Shared pixels over pixels in either picture: 1 is a perfect match. */
  score: number;
  reference: { min: [number, number]; max: [number, number] };
  /** Where the model is in the same view, or null when none of it is in frame. */
  model: { min: [number, number]; max: [number, number] } | null;
  /** The worst places the two disagree, worst first, in words. */
  mismatches: string[];
}

const metres = (value: number) => (Math.round(value * 1000) / 1000 || 0).toFixed(3);

/**
 * How far a model's silhouette is from a reference's subject, both seen from
 * the reference's view and framed alike, pixel for pixel.
 *
 * Each row across and each column up is checked at evenly spaced places, and
 * each side where they part is a mismatch, said in world terms: which side of
 * which axis, how far, and where each reaches. Neighbouring rows usually
 * report one feature, so only the worst of any run is kept.
 */
export function compareWithModel(reference: Reference, model: Mask, most = 8): Comparison {
  const { mask, metresPerPixel } = reference;
  const [h, v] = VIEW_PLANES[reference.view];
  const modelBox = maskBox(model);
  const union = modelBox
    ? {
        minX: Math.min(reference.box.minX, modelBox.minX),
        minY: Math.min(reference.box.minY, modelBox.minY),
        maxX: Math.max(reference.box.maxX, modelBox.maxX),
        maxY: Math.max(reference.box.maxY, modelBox.maxY),
      }
    : reference.box;

  const size = Math.max(
    reference.box.maxX - reference.box.minX,
    reference.box.maxY - reference.box.minY,
  );
  const threshold = Math.max(1.5, size * 0.01) * metresPerPixel;
  const bands = 48;
  type Found = { error: number; band: number; kind: string; text: string };
  const found: Found[] = [];

  const check = (
    kind: 'row' | 'column',
    band: number,
    place: number,
    at: number,
    ours: [number, number] | null,
    theirs: [number, number] | null,
  ) => {
    // Spans as world values along the axis they run on, low end first.
    const along = kind === 'row' ? h : v;
    const across = kind === 'row' ? v : h;
    const world = (span: [number, number]) => {
      const [a, b] =
        kind === 'row'
          ? [toWorld(reference, span[0], place)[0], toWorld(reference, span[1] + 1, place)[0]]
          : [toWorld(reference, place, span[1] + 1)[1], toWorld(reference, place, span[0])[1]];
      return [Math.min(a, b), Math.max(a, b)] as [number, number];
    };
    const where = `at ${across} ${metres(at)}`;
    if (!ours && !theirs) return;
    if (!ours || !theirs) {
      const [from, to] = world((ours ?? theirs) as [number, number]);
      const text = ours
        ? `${where}, the model has shape from ${along} ${metres(from)} to ${metres(to)} and the reference none`
        : `${where}, the reference has shape from ${along} ${metres(from)} to ${metres(to)} and the model none`;
      found.push({ error: to - from, band, kind: `${kind}:${ours ? 'extra' : 'missing'}`, text });
      return;
    }
    const [mine, target] = [world(ours), world(theirs)];
    for (const [end, sign] of [
      [0, -1],
      [1, 1],
    ] as const) {
      const error = (mine[end] - target[end]) * sign;
      if (Math.abs(error) < threshold) continue;
      const verb = error > 0 ? 'sticks out' : 'falls short by';
      found.push({
        error: Math.abs(error),
        band,
        kind: `${kind}:${end}:${error > 0}`,
        text: `${where}, the ${sign < 0 ? '-' : '+'}${along} side ${verb} ${metres(Math.abs(error))} (model ${along} ${metres(mine[end])}, reference ${metres(target[end])})`,
      });
    }
  };

  const tall = union.maxY + 1 - union.minY;
  for (let band = 0; band < bands; band++) {
    const y = Math.min(union.maxY, Math.floor(union.minY + ((band + 0.5) * tall) / bands));
    check(
      'row',
      band,
      y + 0.5,
      toWorld(reference, union.minX, y + 0.5)[1],
      rowSpan(model, y),
      rowSpan(mask, y),
    );
  }
  const wide = union.maxX + 1 - union.minX;
  for (let band = 0; band < bands; band++) {
    const x = Math.min(union.maxX, Math.floor(union.minX + ((band + 0.5) * wide) / bands));
    check(
      'column',
      band,
      x + 0.5,
      toWorld(reference, x + 0.5, union.minY)[0],
      columnSpan(model, x),
      columnSpan(mask, x),
    );
  }

  found.sort((a, b) => b.error - a.error);
  const kept: Found[] = [];
  for (const candidate of found) {
    if (kept.length >= most) break;
    const near = kept.some(
      (other) => other.kind === candidate.kind && Math.abs(other.band - candidate.band) <= 3,
    );
    if (!near) kept.push(candidate);
  }

  return {
    score: Math.round(overlap(model, mask) * 1000) / 1000,
    reference: worldBox(reference, reference.box),
    model: modelBox ? worldBox(reference, modelBox) : null,
    mismatches: kept.map((item) => item.text),
  };
}

/**
 * The world rectangle the whole picture covers, as the view's camera has to
 * frame it for a render to line up with it pixel for pixel: the world point at
 * its middle and its half width and height in metres.
 */
export function referenceFrame(reference: Reference) {
  const { raster, metresPerPixel, originX, originY, view } = reference;
  const across = (raster.width / 2 - originX) * metresPerPixel;
  const up = (originY - raster.height / 2) * metresPerPixel;
  const { right, up: upward } = VIEW_AXES[view];
  return {
    center: {
      x: across * right.x + up * upward.x,
      y: across * right.y + up * upward.y,
      z: across * right.z + up * upward.z,
    },
    halfWidth: (raster.width * metresPerPixel) / 2,
    halfHeight: (raster.height * metresPerPixel) / 2,
  };
}
