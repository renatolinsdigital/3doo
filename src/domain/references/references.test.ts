import { afterEach, describe, expect, it } from 'vitest';

import {
  type Mask,
  type Raster,
  dominantColours,
  pieces,
  selfCrossing,
  simplifyLoop,
  subjectMask,
  traceOutline,
} from './analysis';
import {
  addReference,
  clearReferences,
  compareWithModel,
  getReference,
  referenceFrame,
  summarize,
  toPixel,
  toWorld,
  traceReference,
} from './references';

type Paint = (x: number, y: number) => readonly number[] | null;

/** A picture `width` by `height`, white wherever `paint` gives nothing. */
function picture(width: number, height: number, paint: Paint): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = paint(x, y) ?? [255, 255, 255];
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const RED = [200, 40, 30];
const BLUE = [30, 60, 200];

/** A mask from rows of text, `#` for the subject. */
function maskOf(rows: string[]): Mask {
  const width = rows[0].length;
  const data = new Uint8Array(width * rows.length);
  rows.forEach((row, y) => [...row].forEach((c, x) => (data[y * width + x] = c === '#' ? 1 : 0)));
  return { width, height: rows.length, data };
}

const inBox = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) =>
  x >= x0 && x < x1 && y >= y0 && y < y1;

afterEach(() => clearReferences());

describe('finding the subject', () => {
  it('reads the background off the border and keeps what differs from it', () => {
    const {
      mask,
      background,
      pieces: count,
    } = subjectMask(picture(40, 30, (x, y) => (inBox(x, y, 10, 5, 30, 25) ? RED : null)));

    expect(background).toBe('#ffffff');
    expect(count).toBe(1);
    expect(mask.data.reduce((sum, value) => sum + value, 0)).toBe(20 * 20);
  });

  it('reads a picture with transparency by its alpha', () => {
    const { mask, background } = subjectMask(
      picture(20, 20, (x, y) => (inBox(x, y, 5, 5, 15, 15) ? RED : [255, 255, 255, 0])),
    );

    expect(background).toBe('transparent');
    expect(mask.data.reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it('keeps a highlight the colour of the background, and cuts out holes only when asked', () => {
    // A ring: a 20 by 20 square with a 10 by 10 hole the colour of the background.
    const ring = picture(30, 30, (x, y) =>
      inBox(x, y, 5, 5, 25, 25) && !inBox(x, y, 10, 10, 20, 20) ? BLUE : null,
    );
    const solid = subjectMask(ring).mask.data.reduce((sum, value) => sum + value, 0);
    const holed = subjectMask(ring, { holes: true }).mask.data.reduce(
      (sum, value) => sum + value,
      0,
    );

    expect(solid).toBe(400);
    expect(holed).toBe(300);
  });

  it('takes the background it is given, within the tolerance', () => {
    const grey = picture(20, 20, (x, y) =>
      inBox(x, y, 5, 5, 15, 15) ? [120, 120, 120] : [100, 100, 100],
    );
    expect(subjectMask(grey, { background: '#646464', tolerance: 0.05 }).pieces).toBe(1);
    expect(() => subjectMask(grey, { background: 'grey' })).toThrow(/#rrggbb/);
  });

  it('drops specks of a few pixels', () => {
    const { pieces: count, mask } = subjectMask(
      picture(60, 60, (x, y) =>
        inBox(x, y, 10, 10, 40, 40) || (x === 55 && y === 55) ? RED : null,
      ),
    );
    expect(count).toBe(1);
    expect(mask.data[55 * 60 + 55]).toBe(0);
  });

  it('sees past a frame round the picture and leaves out the frame and its label', () => {
    // One cell of a sheet: a grey line all round its edge, a label in its corner.
    const cell = picture(200, 200, (x, y) => {
      if (x === 0 || y === 0 || x === 199 || y === 199) return [178, 178, 178];
      if (inBox(x, y, 8, 8, 30, 14)) return [0, 0, 0];
      return inBox(x, y, 60, 40, 140, 180) ? RED : null;
    });
    const { mask, background, pieces: count, ignored } = subjectMask(cell);

    expect(background).toBe('#ffffff');
    expect(count).toBe(1);
    expect(ignored).toBe(2);
    expect(mask.data.reduce((sum, value) => sum + value, 0)).toBe(80 * 140);
  });

  it('counts pieces four ways connected, so a corner touch keeps two apart', () => {
    const { areas } = pieces(maskOf(['#.', '.#']));
    expect(areas.slice(1)).toEqual([1, 1]);
  });
});

describe('the outline', () => {
  it('runs along the pixel edges, one point at every turn', () => {
    expect(traceOutline(maskOf(['#.', '##']))).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
      [2, 2],
      [0, 2],
    ]);
  });

  it('goes round the largest piece only, leaving its holes out', () => {
    const outline = traceOutline(maskOf(['#....', '.....', '..###', '..#.#', '..###']));
    expect(outline).toEqual([
      [2, 2],
      [5, 2],
      [5, 5],
      [2, 5],
    ]);
  });

  it('is cut down to the points asked for, and keeps its shape', () => {
    const size = 200;
    const disc = maskOf(
      Array.from({ length: size }, (_, y) =>
        Array.from({ length: size }, (_, x) =>
          Math.hypot(x + 0.5 - 100, y + 0.5 - 100) < 80 ? '#' : '.',
        ).join(''),
      ),
    );
    const traced = traceOutline(disc);
    const cut = simplifyLoop(traced, 24);

    expect(traced.length).toBeGreaterThan(100);
    expect(cut.length).toBeLessThanOrEqual(24);
    expect(cut.length).toBeGreaterThan(12);
    for (const [x, y] of cut) expect(Math.hypot(x - 100, y - 100)).toBeCloseTo(80, -1);
    expect(selfCrossing(cut)).toBeNull();
  });

  it('finds where a loop crosses itself', () => {
    expect(
      selfCrossing([
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ]),
    ).not.toBeNull();
  });
});

describe('colours', () => {
  it('finds each colour of the subject with its share and where it is', () => {
    const raster = picture(40, 20, (x) => (x < 20 ? RED : BLUE));
    const all: Mask = { width: 40, height: 20, data: new Uint8Array(800).fill(1) };
    const colours = dominantColours(raster, all);

    expect(colours).toHaveLength(2);
    for (const colour of colours) expect(colour.share).toBeCloseTo(0.5, 1);
    const red = colours.find((colour) => colour.r > 150);
    expect(red?.x).toBeCloseTo(10, 0);
  });
});

/** An L 50 pixels wide and 100 tall, its foot to the right, on a 100 by 140 white picture. */
const L = picture(100, 140, (x, y) =>
  inBox(x, y, 20, 20, 45, 120) || inBox(x, y, 20, 95, 70, 120) ? RED : null,
);

describe('a reference', () => {
  it('stands the subject on the ground at the origin, at the size it is given', () => {
    const front = addReference({
      id: 'front',
      view: 'front',
      source: 'l.png',
      raster: L,
      height: 2,
    });
    const summary = summarize(front);

    expect(summary.metresPerPixel).toBeCloseTo(0.02);
    expect(summary.size).toEqual([1, 2]);
    expect(summary.axes).toEqual(['x', 'y']);
    expect(summary.bounds).toEqual({ min: [-0.5, 0], max: [0.5, 2] });
    expect(getReference('front')).toBe(front);
  });

  it('writes points in the world terms of its view', () => {
    // The foot is on the picture's right, which is +x from the front, -z from
    // the right, and +x from above, where up the picture is -z.
    const foot = [65, 110] as const;
    const front = addReference({ id: 'a', view: 'front', source: 'l.png', raster: L, width: 1 });
    const right = addReference({ id: 'b', view: 'right', source: 'l.png', raster: L, width: 1 });
    const top = addReference({ id: 'c', view: 'top', source: 'l.png', raster: L, width: 1 });

    expect(toWorld(front, ...foot)[0]).toBeGreaterThan(0);
    expect(toWorld(right, ...foot)[0]).toBeLessThan(0);
    expect(summarize(right).axes).toEqual(['z', 'y']);
    expect(summarize(top).axes).toEqual(['x', 'z']);
    expect(summarize(top).bounds).toEqual({ min: [-0.5, -1], max: [0.5, 1] });
    expect(toWorld(top, 45, 20)[1]).toBeLessThan(0);
    for (const reference of [front, right, top]) {
      const [h, v] = toWorld(reference, ...foot);
      const [x, y] = toPixel(reference, h, v);
      expect(x).toBeCloseTo(foot[0]);
      expect(y).toBeCloseTo(foot[1]);
    }
  });

  it('traces the outline, the profile and the colours in metres', () => {
    const front = addReference({
      id: 'front',
      view: 'front',
      source: 'l.png',
      raster: L,
      height: 2,
    });
    const trace = traceReference(front, { rows: 4 });

    expect(trace.outline).toHaveLength(6);
    expect(trace.outline).toContainEqual([-0.5, 2]);
    expect(trace.outline).toContainEqual([0.5, 0]);
    expect(trace.simple).toBe(true);
    expect(trace.profile.map((row) => row.at)).toEqual([0.25, 0.75, 1.25, 1.75]);
    expect(trace.profile[0]).toEqual({ at: 0.25, from: -0.5, to: 0.5 });
    expect(trace.profile[3]).toEqual({ at: 1.75, from: -0.5, to: 0 });
    expect(trace.colours).toEqual([{ color: '#c8281e', share: 1, at: expect.any(Array) }]);
  });

  it('refuses a picture with no subject, or no background, and an id never loaded', () => {
    const blank = picture(20, 20, () => null);
    expect(() =>
      addReference({ id: 'x', view: 'front', source: 'blank.png', raster: blank, height: 1 }),
    ).toThrow(/no subject/);
    const full = picture(20, 20, (x, y) => (x === 0 && y === 0 ? [255, 255, 255] : RED));
    expect(() =>
      addReference({
        id: 'x',
        view: 'front',
        source: 'red.png',
        raster: full,
        height: 1,
        background: '#ffffff',
      }),
    ).toThrow(/no background/);
    expect(() => getReference('side')).toThrow(/none is loaded/);
    addReference({ id: 'front', view: 'front', source: 'l.png', raster: L, height: 2 });
    expect(() => getReference('side')).toThrow(/The references are "front"/);
  });

  it('is framed by the world rectangle the whole picture covers', () => {
    const front = addReference({
      id: 'front',
      view: 'front',
      source: 'l.png',
      raster: L,
      height: 2,
    });
    const frame = referenceFrame(front);

    expect(frame.halfWidth).toBeCloseTo(1);
    expect(frame.halfHeight).toBeCloseTo(1.4);
    // The picture runs 20 pixels past the subject top and bottom, and its middle
    // is 5 pixels right of the middle of the subject.
    expect(frame.center.y).toBeCloseTo(1);
    expect(frame.center.x).toBeCloseTo(0.1);
  });
});

describe('comparing a model with a reference', () => {
  const front = () =>
    addReference({ id: 'front', view: 'front', source: 'l.png', raster: L, height: 2 });

  it('scores a perfect match as 1, with nothing to say', () => {
    const reference = front();
    const result = compareWithModel(reference, reference.mask);

    expect(result.score).toBe(1);
    expect(result.mismatches).toEqual([]);
    expect(result.model).toEqual(result.reference);
  });

  it('says which side of which axis is off, and by how much', () => {
    const reference = front();
    // The model's foot runs ten pixels, 0.2 m, further to the right.
    const model = subjectMask(
      picture(100, 140, (x, y) =>
        inBox(x, y, 20, 20, 45, 120) || inBox(x, y, 20, 95, 80, 120) ? RED : null,
      ),
    ).mask;
    const result = compareWithModel(reference, model);

    expect(result.score).toBeLessThan(1);
    expect(result.score).toBeGreaterThan(0.8);
    expect(result.mismatches).toContainEqual(
      expect.stringMatching(
        /^at y 0\.\d+, the \+x side sticks out 0\.200 \(model x 0\.700, reference 0\.500\)$/,
      ),
    );
  });

  it('says where the model has no shape the reference has', () => {
    const reference = front();
    const model = subjectMask(
      picture(100, 140, (x, y) => (inBox(x, y, 20, 95, 70, 120) ? RED : null)),
    ).mask;
    const result = compareWithModel(reference, model);

    expect(result.mismatches.some((line) => /the model none$/.test(line))).toBe(true);
    expect(result.mismatches.some((line) => /\+y side falls short by 1\.500/.test(line))).toBe(
      true,
    );
  });
});
