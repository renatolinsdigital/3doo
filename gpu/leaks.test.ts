import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MarkMode, Pose, PoseReport, SceneName } from './page';

/**
 * Vertex dots and wire drawn through the surfaces in front of them, checked on
 * the real GPU.
 *
 * The same leak was fixed nine times in seven weeks, and the unit tests round
 * it read the shader source rather than the picture, so none of them could say
 * whether a fix held. This runs the editor in Chrome on the machine's own GPU,
 * builds the scenes the leaks came back in, and looks at the frames from many
 * angles, perspective and orthographic. See `page.ts` for how a leak is told
 * apart from a mark that ought to show.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

type CheckWindow = Window & {
  gpuCheck: typeof import('./page');
  gpuReady?: boolean;
};

function sweep(
  radii: number[],
  angles: [phi: number, theta: number][],
  projections = [false, true],
) {
  const poses: Pose[] = [];
  for (const orthographic of projections) {
    for (const radius of radii) {
      for (const [phi, theta] of angles) {
        poses.push({ target: { x: 0, y: 0, z: 0 }, radius, phi, theta, orthographic });
      }
    }
  }
  return poses;
}

const SQUARE_ON = sweep(
  [3, 6],
  [
    [1.2, 0],
    [1.57, 0],
    [1.9, 0],
  ],
  [true],
);

const SCENES: [SceneName, Pose[]][] = [
  // Edge on and zoomed out is where a lift sized for the steepest face carried
  // the underside up through the top.
  [
    'thin plate',
    sweep(
      [3, 10, 30, 80],
      [
        [1.2, 0.4],
        [1.45, 1.2],
        [1.55, 2.6],
        [1, 4],
      ],
    ),
  ],
  // From above, the grid lies a few pixels of depth or less behind the sheet.
  [
    'layered sheet',
    sweep(
      [3, 10, 25],
      [
        [0.5, 0.3],
        [0.9, 1.4],
        [1.2, 3],
        [0.7, 4.5],
      ],
    ),
  ],
  // From above the lower leaf's edges run out from the fold under the upper
  // leaf, and from below the other way round.
  [
    'folded sheet',
    sweep(
      [3, 8, 20],
      [
        [0.3, 0.5],
        [0.8, 1.2],
        [1.2, 2.5],
        [2.4, 4],
      ],
    ),
  ],
  // Contours: the far side runs within a pixel of the near one there.
  [
    'sphere',
    sweep(
      [2.5, 6, 15],
      [
        [1.3, 0.6],
        [1.57, 1.5],
        [0.9, 3.5],
      ],
    ),
  ],
  [
    'cylinder',
    sweep(
      [2.5, 6, 15],
      [
        [1.3, 0.6],
        [1.57, 1.5],
        [0.9, 3.5],
      ],
    ),
  ],
  [
    'behind another',
    sweep(
      [3, 6, 12],
      [
        [1.57, 0],
        [1.3, 0.3],
        [1.8, -0.4],
      ],
    ),
  ],
  // Orthographic draws from a near plane behind the eye, which takes in the
  // wall behind it, so only perspective stands inside a room.
  [
    'room',
    sweep(
      [1, 2.5],
      [
        [1.3, 0.6],
        [1.57, 2],
        [1, 4],
      ],
      [false],
    ),
  ],
  // Orthographic and square on, tilted up and down only, which keeps the
  // cube's right edges a fraction of a pixel inside the plate's outline.
  ['edge under an outline', SQUARE_ON],
];

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let gpu = '';

beforeAll(async () => {
  server = await createServer({
    root: ROOT,
    configFile: `${ROOT}vite.config.ts`,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 5288 },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('Vite did not say where it is serving');

  // Unlike the MCP engine, no SwiftShader: the point is the GPU the editor
  // really draws on, with its own depth precision and rasterisation.
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch (error) {
    throw new Error(
      `The GPU check needs Chrome installed. ${(error as Error).message.split('\n')[0]}`,
    );
  }
  page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.error('page error:', error.message));

  await page.goto(new URL('/modeling', url).href);
  await page.waitForSelector('canvas', { timeout: 60_000 });
  await page.addScriptTag({
    type: 'module',
    content: `import * as check from '/gpu/page.ts'; check.install(); window.gpuCheck = check; window.gpuReady = true;`,
  });
  await page.waitForFunction(() => (window as unknown as CheckWindow).gpuReady === true, null, {
    timeout: 60_000,
  });
  gpu = await page.evaluate(() => (window as unknown as CheckWindow).gpuCheck.gpuName());
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

function label(pose: Pose) {
  const projection = pose.orthographic ? 'ortho' : 'persp';
  return `${projection} r${pose.radius} phi${pose.phi} theta${pose.theta}`;
}

function describeFindings(kind: string, report: PoseReport['dots'] | PoseReport['wire']) {
  const lines: string[] = [];
  const first = (findings: { x: number; y: number; gapPx: number }[]) =>
    findings
      .slice(0, 3)
      .map(({ x, y, gapPx }) => `(${x}, ${y}) ${gapPx}px`)
      .join(' ');
  if (report.leaks.length > 0) {
    lines.push(`${report.leaks.length} hidden ${kind} drawn: ${first(report.leaks)}`);
  }
  if (report.missing.length > 0) {
    lines.push(`${report.missing.length} visible ${kind} left off: ${first(report.missing)}`);
  }
  if ('thinned' in report && report.thinned.length > 0) {
    lines.push(
      `${report.thinned.length} pixels of visible wire taken off: ${first(report.thinned)}`,
    );
  }
  return lines;
}

describe('marks on the real GPU', () => {
  it.each(SCENES)(
    'draws no hidden dot or wire of a %s, and leaves none off',
    async (name, poses) => {
      await page.evaluate(
        (scene) => (window as unknown as CheckWindow).gpuCheck.build(scene),
        name,
      );
      const failures: string[] = [];
      let hidden = 0;

      for (const pose of poses) {
        const report = await page.evaluate(
          (at) => (window as unknown as CheckWindow).gpuCheck.check(at),
          pose,
        );
        hidden += report.dots.hidden + report.wire.hidden;
        const found = [
          ...describeFindings('dots', report.dots),
          ...describeFindings('wire samples', report.wire),
        ];
        if (found.length > 0) failures.push(`${label(pose)}: ${found.join('; ')}`);
      }

      // A sweep that never put anything behind a surface could not have caught a
      // leak, however clean it came back.
      expect(hidden, `no mark was ever hidden in the ${name} sweep`).toBeGreaterThan(0);
      expect(failures, `on ${gpu}`).toEqual([]);
    },
  );
});

// From above and below, where the triangles across the diagonals lean in front
// of the long edges or fall behind them. Not much lower than twenty degrees
// over the sheet: nearer edge on, the crests hide rows behind them by a few
// pixels of depth, and some of that wire comes through, the same in every mode.
const STRIP_POSES = sweep(
  [3, 6],
  [
    [0.5, 0.2],
    [1, 1.3],
    [1.2, 2.6],
    [1.95, 4],
    [2.3, 5.2],
  ],
);

// Down onto the cap at a slant from all round, where its triangles reach
// across it to the rim.
const CAP_POSES = sweep(
  [2.5, 6],
  [
    [0.4, 0.3],
    [0.8, 1.7],
    [1.1, 3.1],
    [0.6, 4.6],
  ],
);

describe('wire over its own surface on the real GPU', () => {
  it.each<MarkMode>(['object', 'edge', 'vertex'])(
    'keeps every visible edge of twisted strips whole, in %s mode',
    async (mode) => {
      await page.evaluate(
        ([scene, as]) => (window as unknown as CheckWindow).gpuCheck.build(scene, as),
        ['twisted strips', mode] as [SceneName, MarkMode],
      );
      const failures: string[] = [];
      let checked = 0;
      for (const pose of STRIP_POSES) {
        const report = await page.evaluate(
          (at) => (window as unknown as CheckWindow).gpuCheck.check(at),
          pose,
        );
        checked += report.wire.checked;
        const found = describeFindings('wire samples', report.wire);
        if (found.length > 0) failures.push(`${label(pose)}: ${found.join('; ')}`);
      }
      expect(checked, 'no wire was ever on screen').toBeGreaterThan(0);
      // Outside vertex select mode the surface carried which of each triangle's
      // sides were edges of its face, but not where the face went on to across
      // a diagonal. The triangle across the diagonal from an edge, a little out
      // of flat, was then taken to reach the edge and stand in front of it, and
      // the wire beside it lost the half of its width over that triangle: a
      // line broken into dashes, wherever a long quad was not quite flat.
      expect(failures, `on ${gpu}`).toEqual([]);
    },
  );

  it.each<MarkMode>(['object', 'vertex'])(
    'keeps every visible edge round a cap not quite flat, in %s mode',
    async (mode) => {
      await page.evaluate(
        ([scene, as]) => (window as unknown as CheckWindow).gpuCheck.build(scene, as),
        ['bent cap', mode] as [SceneName, MarkMode],
      );
      const failures: string[] = [];
      let checked = 0;
      for (const pose of CAP_POSES) {
        const report = await page.evaluate(
          (at) => (window as unknown as CheckWindow).gpuCheck.check(at),
          pose,
        );
        checked += report.wire.checked;
        const found = describeFindings('wire samples', report.wire);
        if (found.length > 0) failures.push(`${label(pose)}: ${found.join('; ')}`);
      }
      expect(checked, 'no wire was ever on screen').toBeGreaterThan(0);
      // The pass knows a face of many corners only one triangle past each
      // diagonal, and took it to go on from there. A triangle further across
      // the cap, standing a hair proud, was taken to reach the rim and hid the
      // rim's own edges there.
      expect(failures, `on ${gpu}`).toEqual([]);
    },
  );
});

/** Closed, every normal outward, and seen from outside: no back face is in sight. */
const OUTWARD: SceneName[] = ['thin plate', 'sphere', 'cylinder', 'behind another'];

function posesOf(name: SceneName): Pose[] {
  return SCENES.find(([scene]) => scene === name)?.[1] ?? [];
}

describe('face orientation on the real GPU', () => {
  it.each(OUTWARD)('paints no back face of a %s seen from outside', async (name) => {
    await page.evaluate((scene) => (window as unknown as CheckWindow).gpuCheck.build(scene), name);
    const failures: string[] = [];
    for (const pose of posesOf(name)) {
      const pixels = await page.evaluate(
        (at) => (window as unknown as CheckWindow).gpuCheck.orientationInk(at),
        pose,
      );
      if (pixels > 0) failures.push(`${label(pose)}: ${pixels}px`);
    }
    // The red used to be pulled towards the camera by each face's slope, which
    // near a contour is steep enough to bring the far side's back faces up
    // through the near ones: a red line along the edges there, in solid too.
    expect(failures, `on ${gpu}`).toEqual([]);
  });

  it('paints the walls of a room seen from inside', async () => {
    await page.evaluate(() => (window as unknown as CheckWindow).gpuCheck.build('room'));
    // Without it, a sweep that never switched the overlay on would pass.
    for (const pose of posesOf('room')) {
      const pixels = await page.evaluate(
        (at) => (window as unknown as CheckWindow).gpuCheck.orientationInk(at),
        pose,
      );
      expect(pixels, `${label(pose)} on ${gpu}`).toBeGreaterThan(10_000);
    }
  });
});

describe('pictures on the real GPU', () => {
  it('draws the wire of a cube in a solidWire picture', async () => {
    const wire = await page.evaluate(() =>
      (window as unknown as CheckWindow).gpuCheck.pictureWire(),
    );
    // Pictures used to come out with no wire at all, solidWire drawing exactly
    // what solid draws: outside the viewport's frame the occlusion map was
    // null, and WebGL2 drops a draw whose unsigned integer sampler meets
    // three's float stand-in.
    expect(wire, `on ${gpu}`).toBeGreaterThan(300);
  });
});
