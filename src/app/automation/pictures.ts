/**
 * The canvas half of references and sheets: decoding pictures into pixels and
 * drawing the pictures an assistant is shown.
 *
 * Everything that measures lives in `domain/references`, as plain arithmetic
 * a test can run. This file only reads and paints pixels, which takes a
 * browser, so it is checked end to end through the MCP server.
 */
import type { Mask, Raster } from '@domain/references/analysis';
import { traceOutline } from '@domain/references/analysis';
import { type Reference, summarize, toPixel } from '@domain/references/references';

/** The longer side a reference is measured at, which is plenty to model from and keeps it quick. */
export const REFERENCE_SIDE = 1024;

const LABEL_FONT = '600 12px ui-monospace, Consolas, monospace';

function canvas(width: number, height: number) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  const context = element.getContext('2d');
  if (!context) throw new Error('This browser cannot draw on a canvas.');
  return { element, context };
}

const pngBase64 = (element: HTMLCanvasElement) => {
  const url = element.toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
};

/**
 * A picture's pixels: the part `crop` names, `[x, y, width, height]` in the
 * picture's own pixels, scaled down so the longer side is at most `longest`.
 */
export async function decodePicture(
  bytes: Uint8Array<ArrayBuffer>,
  crop?: readonly number[],
  longest = REFERENCE_SIDE,
): Promise<Raster> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]));
  } catch {
    throw new Error(
      'That file is not a picture this browser can read: use PNG, JPEG, WebP or GIF.',
    );
  }
  try {
    const [x, y, w, h] = crop ?? [0, 0, bitmap.width, bitmap.height];
    if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > bitmap.width || y + h > bitmap.height) {
      throw new Error(
        `crop [${crop?.join(', ')}] reaches outside the picture, which is ${bitmap.width} by ${bitmap.height} pixels.`,
      );
    }
    const scale = Math.min(1, longest / Math.max(w, h));
    const width = Math.max(1, Math.round(w * scale));
    const height = Math.max(1, Math.round(h * scale));
    if (width < 16 || height < 16) {
      throw new Error(
        `The picture is ${width} by ${height} pixels: give one at least 16 on each side.`,
      );
    }
    const { context } = canvas(width, height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, x, y, w, h, 0, 0, width, height);
    return { width, height, data: context.getImageData(0, 0, width, height).data };
  } finally {
    bitmap.close();
  }
}

/** The pixels of a picture the snapshot renderer drew. */
export async function rasterOf(dataUrl: string): Promise<Raster> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const { context } = canvas(bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      data: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
    };
  } finally {
    bitmap.close();
  }
}

/** The dark pixels of a silhouette render: where the model is. */
export function silhouetteMask(raster: Raster): Mask {
  const data = new Uint8Array(raster.width * raster.height);
  for (let i = 0; i < data.length; i++) {
    const offset = i * 4;
    const light = raster.data[offset] + raster.data[offset + 1] + raster.data[offset + 2];
    data[i] = light < 384 ? 1 : 0;
  }
  return { width: raster.width, height: raster.height, data };
}

/** A round step for grid lines, about a tenth of `span`. */
function gridStep(span: number): number {
  const rough = span / 8;
  const power = 10 ** Math.floor(Math.log10(rough));
  const steps = [1, 2, 5, 10].map((factor) => factor * power);
  return steps.find((step) => step >= rough) ?? 10 * power;
}

function label(context: CanvasRenderingContext2D, text: string, x: number, y: number) {
  context.font = LABEL_FONT;
  const width = context.measureText(text).width;
  context.fillStyle = 'rgba(255, 255, 255, 0.85)';
  context.fillRect(x - 2, y - 11, width + 4, 15);
  context.fillStyle = '#0b0b0b';
  context.fillText(text, x, y);
}

/**
 * Lines every round number of metres across the picture, labelled in world
 * terms along its bottom and left edges, and the two axes through the origin
 * drawn darker.
 */
function drawGrid(context: CanvasRenderingContext2D, reference: Reference) {
  const { covers, size, axes } = summarize(reference);
  const { width, height } = reference.raster;
  const step = gridStep(Math.max(...size));
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const text = (value: number) => (Math.abs(value) < step / 1000 ? 0 : value).toFixed(decimals);

  context.lineWidth = 1;
  for (let value = Math.ceil(covers.min[0] / step) * step; value <= covers.max[0]; value += step) {
    const x = Math.round(toPixel(reference, value, 0)[0]) + 0.5;
    context.strokeStyle = Math.abs(value) < step / 1000 ? 'rgba(0,0,0,0.65)' : 'rgba(0,0,0,0.22)';
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let value = Math.ceil(covers.min[1] / step) * step; value <= covers.max[1]; value += step) {
    const y = Math.round(toPixel(reference, 0, value)[1]) + 0.5;
    context.strokeStyle = Math.abs(value) < step / 1000 ? 'rgba(0,0,0,0.65)' : 'rgba(0,0,0,0.22)';
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  // Labels last, so no line runs through one.
  for (let value = Math.ceil(covers.min[0] / step) * step; value <= covers.max[0]; value += step) {
    const x = toPixel(reference, value, 0)[0];
    if (x > 4 && x < width - 40) label(context, `${axes[0]} ${text(value)}`, x + 3, height - 5);
  }
  for (let value = Math.ceil(covers.min[1] / step) * step; value <= covers.max[1]; value += step) {
    const y = toPixel(reference, 0, value)[1];
    if (y > 16 && y < height - 20) label(context, `${axes[1]} ${text(value)}`, 4, y - 3);
  }
}

/** The reference as measured: the picture paled, the outline found round it, and the grid. */
export function drawReference(reference: Reference): string {
  const { raster } = reference;
  const { element, context } = canvas(raster.width, raster.height);
  context.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width), 0, 0);
  context.fillStyle = 'rgba(255, 255, 255, 0.35)';
  context.fillRect(0, 0, raster.width, raster.height);

  const outline = traceOutline(reference.mask);
  if (outline.length > 2) {
    context.strokeStyle = '#e5342a';
    context.lineWidth = 2;
    context.beginPath();
    outline.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
    context.closePath();
    context.stroke();
  }
  drawGrid(context, reference);
  return pngBase64(element);
}

const BOTH = [150, 150, 150];
const MODEL_ONLY = [229, 52, 42];
const REFERENCE_ONLY = [40, 110, 230];

/**
 * The reference and the model's silhouette over each other: grey where both
 * are, red where only the model is, blue where only the reference is, and the
 * reference paled where neither is, with the grid on top.
 */
export function drawComparison(reference: Reference, model: Mask): string {
  const { raster, mask } = reference;
  const pixels = new Uint8ClampedArray(raster.data);
  for (let i = 0; i < mask.data.length; i++) {
    const offset = i * 4;
    const [ours, theirs] = [model.data[i], mask.data[i]];
    const tint = ours && theirs ? BOTH : ours ? MODEL_ONLY : theirs ? REFERENCE_ONLY : null;
    for (let c = 0; c < 3; c++) {
      pixels[offset + c] = tint
        ? tint[c] * 0.75 + pixels[offset + c] * 0.25
        : 255 * 0.8 + pixels[offset + c] * 0.2;
    }
    pixels[offset + 3] = 255;
  }
  const { element, context } = canvas(raster.width, raster.height);
  context.putImageData(new ImageData(pixels, raster.width), 0, 0);
  drawGrid(context, reference);

  const keys: [string, number[]][] = [
    ['model only', MODEL_ONLY],
    ['reference only', REFERENCE_ONLY],
    ['both', BOTH],
  ];
  context.font = LABEL_FONT;
  keys.forEach(([name, colour], index) => {
    const y = 8 + index * 18;
    context.fillStyle = 'rgba(255, 255, 255, 0.85)';
    context.fillRect(6, y - 2, context.measureText(name).width + 26, 17);
    context.fillStyle = `rgb(${colour.join(', ')})`;
    context.fillRect(8, y + 1, 12, 11);
    context.fillStyle = '#0b0b0b';
    context.fillText(name, 26, y + 11);
  });
  return pngBase64(element);
}

/** How a sheet of `count` views is laid out: as near square as the count allows. */
export function sheetLayout(count: number): { columns: number; rows: number } {
  const columns = Math.ceil(Math.sqrt(count));
  return { columns, rows: Math.ceil(count / columns) };
}

/** Pictures of one size set side by side in one, each labelled in its corner. */
export async function composeSheet(
  pictures: readonly { label: string; dataUrl: string }[],
  width: number,
  height: number,
  background: string,
): Promise<string> {
  const { columns, rows } = sheetLayout(pictures.length);
  const cellWidth = Math.floor(width / columns);
  const cellHeight = Math.floor(height / rows);
  const { element, context } = canvas(width, height);
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  for (const [index, picture] of pictures.entries()) {
    const x = (index % columns) * cellWidth;
    const y = Math.floor(index / columns) * cellHeight;
    const bitmap = await createImageBitmap(await (await fetch(picture.dataUrl)).blob());
    context.drawImage(bitmap, x, y);
    bitmap.close();
    label(context, picture.label, x + 6, y + 16);
    context.strokeStyle = 'rgba(128, 128, 128, 0.6)';
    context.lineWidth = 1;
    context.strokeRect(x + 0.5, y + 0.5, cellWidth - 1, cellHeight - 1);
  }
  return pngBase64(element);
}
