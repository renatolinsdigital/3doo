import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { addReference, clearReferences } from '@domain/references/references';

import { worldBounds } from './api';
import { runScript } from './runScript';

const store = () => useEditorStore.getState();

async function run(source: string) {
  const outcome = await runScript(source);
  if (!outcome.ok) throw new Error(`Line ${outcome.line}: ${outcome.message}`);
  return outcome;
}

async function failure(source: string) {
  const outcome = await runScript(source);
  if (outcome.ok) throw new Error(`Expected the script to fail, but it said: ${outcome.message}`);
  return outcome.message;
}

const bounds = (name: string) => {
  const object = store().objects.find((candidate) => candidate.name === name);
  if (!object) throw new Error(`No ${name}`);
  const box = worldBounds([object]);
  if (!box) throw new Error(`${name} is empty`);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    min: [round(box.min.x), round(box.min.y), round(box.min.z)],
    max: [round(box.max.x), round(box.max.y), round(box.max.z)],
  };
};

/** A white picture with a red diamond 60 pixels across and 100 tall. */
function diamond() {
  const [width, height] = [100, 140];
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = Math.abs(x + 0.5 - 50) / 30 + Math.abs(y + 0.5 - 70) / 50 <= 1;
      if (inside) data.set([200, 40, 30, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

beforeEach(() => store().resetScene());
afterEach(() => clearReferences());

describe('scene.lathe', () => {
  it('turns a profile into an object at the cursor, named and coloured like any other', async () => {
    await run(`
      scene.lathe([[0, 0], [0.3, 0], [0.3, 0.6], [0.1, 0.8], [0.1, 1]], {
        segments: 8, smooth: true, name: 'BOTTLE', color: '#2a6e3f',
      });
    `);

    const [bottle] = store().objects;
    expect(bottle.name).toBe('BOTTLE');
    expect(bottle.mesh.verts.size).toBe(33);
    expect([...bottle.mesh.faces.values()].every((face) => face.smooth)).toBe(true);
    expect(bounds('BOTTLE').min[1]).toBe(0);
    expect(bounds('BOTTLE').max[1]).toBe(1);
  });

  it('refuses a profile it cannot turn, and says why', async () => {
    expect(await failure(`scene.lathe([[0.2, 0], [0, 0.5], [0.2, 1]]);`)).toMatch(
      /profile\[1\] is on the axis, where only the first and last point may be/,
    );
    expect(await failure(`scene.lathe([[-1, 0], [1, 1]]);`)).toMatch(/radius below 0/);
    expect(await failure(`scene.lathe([[0, 0], [0, 1]]);`)).toMatch(/turns nothing/);
    expect(await failure(`scene.lathe([[1, 0]]);`)).toMatch(/2 or more \[radius, y\] points/);
    expect(await failure(`scene.lathe([[1, 0], [1]]);`)).toMatch(
      /profile\[1\] has to be \[radius, y\]/,
    );
    expect(await failure(`scene.lathe([[1, 0], [1, 1]], { segment: 8 });`)).toMatch(
      /no option "segment". Did you mean "segments"\?/,
    );
  });
});

describe('scene.extrudeOutline', () => {
  it('reads the points in the terms of the view they are seen from', async () => {
    await run(`
      const L = [[0, 0], [1, 0], [1, 0.5], [0.5, 0.5], [0.5, 2], [0, 2]];
      scene.extrudeOutline(L, { name: 'FRONT', depth: 0.2 });
      scene.extrudeOutline(L, { name: 'SIDE', view: 'right', depth: 0.2 });
      scene.extrudeOutline(L, { name: 'PLAN', view: 'top', depth: 0.2, bevel: 0.02 });
    `);

    expect(bounds('FRONT')).toEqual({ min: [0, 0, -0.1], max: [1, 2, 0.1] });
    expect(bounds('SIDE')).toEqual({ min: [-0.1, 0, 0], max: [0.1, 2, 1] });
    expect(bounds('PLAN')).toEqual({ min: [0, -0.1, 0], max: [1, 0.1, 2] });
  });

  it('refuses an outline that crosses itself, and names the place', async () => {
    expect(await failure(`scene.extrudeOutline([[0, 0], [1, 1], [1, 0], [0, 1]]);`)).toMatch(
      /crosses itself near \[0, 0\]/,
    );
    expect(await failure(`scene.extrudeOutline([[0, 0], [1, 0], [2, 0]]);`)).toMatch(
      /encloses no area/,
    );
    expect(
      await failure(`scene.extrudeOutline([[0, 0], [1, 0], [1, 1]], { view: 'side' });`),
    ).toMatch(/view has to be one of "front", "back", "right", "left", "top", "bottom"/);
  });
});

describe('scene.reference', () => {
  it('hands a script the outline and profile of a loaded picture, in metres', async () => {
    addReference({ id: 'front', view: 'front', source: 'gem.png', raster: diamond(), height: 1 });

    const outcome = await run(`
      const ref = scene.reference('front', { points: 16, rows: 10 });
      scene.extrudeOutline(ref.outline, { view: ref.view, depth: 0.1, name: 'GEM' });
      return { size: ref.size, rows: ref.profile.length, widest: Math.max(...ref.profile.map((row) => row.to - row.from)) };
    `);

    const read = JSON.parse(outcome.message);
    expect(read.size[0]).toBeCloseTo(0.6, 1);
    expect(read.size[1]).toBe(1);
    expect(read.rows).toBe(10);
    expect(read.widest).toBeGreaterThan(0.5);
    const gem = bounds('GEM');
    expect(gem.min[0]).toBeCloseTo(-0.3, 1);
    expect(gem.max[0]).toBeCloseTo(0.3, 1);
    expect(gem.min[1]).toBeCloseTo(0, 2);
    expect(gem.max[1]).toBeCloseTo(1, 2);
  });

  it('turns a profile into lathe radii', async () => {
    addReference({ id: 'side', view: 'right', source: 'gem.png', raster: diamond(), height: 1 });

    await run(`
      const ref = scene.reference('side');
      scene.lathe([[0, 0], ...ref.profile.map((row) => [(row.to - row.from) / 2, row.at]), [0, 1]], { name: 'SPINDLE' });
    `);

    expect(bounds('SPINDLE').max[0]).toBeGreaterThan(0.25);
    expect(bounds('SPINDLE').max[1]).toBe(1);
  });

  it('says which references there are when it is asked for another', async () => {
    expect(await failure(`scene.reference('front');`)).toMatch(/none is loaded/);
    addReference({ id: 'front', view: 'front', source: 'gem.png', raster: diamond(), height: 1 });
    expect(await failure(`scene.reference('side');`)).toMatch(/The references are "front"/);
    expect(await failure(`scene.reference('front', { point: 8 });`)).toMatch(
      /Did you mean "points"\?/,
    );
  });
});
