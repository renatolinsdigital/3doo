import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Pose, PoseReport, SceneName } from './page';

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

function describeFindings(kind: string, report: PoseReport['dots']) {
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
