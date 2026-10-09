import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';

import { type Browser, type BrowserContext, type Page, chromium } from 'playwright-core';

import {
  AUTOMATION_VERSION,
  type AutomationApi,
  type ExportRequest,
  type ExportedFile,
  type OpenRequest,
  type ReferenceRequest,
  type RenderRequest,
  type RenderedView,
  type RunReport,
  type SceneSummary,
} from '../src/app/automation/types.ts';

import { type Config, engineSource } from './config.ts';

/** What the tools need from the editor, wherever it runs. */
export interface Engine {
  reset(): Promise<void>;
  run(script: string): Promise<RunReport>;
  open(request: OpenRequest): Promise<SceneSummary>;
  scene(): Promise<SceneSummary>;
  exportFile(request: ExportRequest): Promise<ExportedFile[]>;
  render(request: RenderRequest): Promise<RenderedView[]>;
  reference(request?: ReferenceRequest): Promise<string>;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/**
 * Serves the built app from `dir` on a free local port, every unknown path
 * falling back to `index.html` the way the app's own host has to.
 */
export async function serveDist(dir: string): Promise<{ url: string; server: Server }> {
  const root = normalize(dir);
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://local').pathname);
    let file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    const found = await stat(file).catch(() => null);
    if (!found?.isFile()) file = join(root, 'index.html');
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}

/**
 * Asks for WebGL from the CPU when there is no GPU, which is the rule on a
 * server and common in a headless browser anywhere.
 */
const BROWSER_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/**
 * A browser to drive: the one the configuration names, else the Chromium
 * Playwright installed, else the Chrome or Edge already on the machine.
 */
async function launchBrowser(config: Config): Promise<Browser> {
  if (config.chromiumPath) {
    return chromium.launch({ executablePath: config.chromiumPath, args: BROWSER_ARGS });
  }
  const failures: string[] = [];
  for (const channel of [undefined, 'chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, args: BROWSER_ARGS });
    } catch (error) {
      failures.push((error as Error).message.split('\n')[0]);
    }
  }
  throw new Error(
    `No browser to run 3DOO in. Run \`npx playwright-core install chromium\`, or set THREEDOO_CHROMIUM to a Chrome or Chromium. (${failures[0]})`,
  );
}

/**
 * The editor running in a headless browser, driven through `window.threedoo`.
 *
 * Started on the first call rather than with the server, so a client that
 * lists the tools and never uses them never launches a browser. One page is
 * one scene, kept between calls, which is what lets an assistant build a model
 * over several scripts and then export it.
 */
export class BrowserEngine implements Engine {
  private readonly config: Config;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private server: Server | null = null;
  private url: string | null = null;
  private starting: Promise<Page> | null = null;
  private pageErrors: string[] | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  private async start(): Promise<Page> {
    if (!this.url) {
      const source = engineSource(this.config);
      if (source === 'dist') {
        const served = await serveDist(this.config.distDir);
        this.server = served.server;
        this.url = served.url;
      } else {
        this.url = source;
      }
    }
    this.browser ??= await launchBrowser(this.config);

    // A context of its own each time, so a page thrown away after a runaway
    // script takes its renderer process with it.
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await this.context.newPage();
    // The script's own console lines come back in the run's report, written
    // out in full. This adds an error the run could not catch, such as one
    // thrown in a timer the script set, when it lands while the run lasts.
    page.on('pageerror', (error) => this.pageErrors?.push(`error: ${error.message}`));

    // The home page: it mounts no viewport and adds no starter cube, so the
    // scene starts empty and nothing renders behind the calls.
    await page.goto(new URL('/', this.url).href, { waitUntil: 'load' });
    const version = await page
      .waitForFunction(() => window.threedoo?.version, null, { timeout: 20_000 })
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    if (version === null) {
      throw new Error(
        `${this.url} did not offer window.threedoo. Is that 3DOO, and a build with the MCP layer?`,
      );
    }
    if (version !== AUTOMATION_VERSION) {
      throw new Error(
        `${this.url} speaks version ${version} of the automation API and this server speaks ${AUTOMATION_VERSION}. Rebuild with \`npm run build\`, or point THREEDOO_ENGINE_URL at a matching 3DOO.`,
      );
    }
    this.page = page;
    return page;
  }

  private ready(): Promise<Page> {
    if (this.page) return Promise.resolve(this.page);
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  /**
   * Runs `work` against the page, and gives up on it after the timeout.
   *
   * A script runs on the page's own thread, so one that never ends freezes the
   * page for good. The only way out is to throw the page away, scene and all,
   * and say so, so the next call starts on a fresh one.
   */
  private async within<T>(what: string, work: (page: Page) => Promise<T>): Promise<T> {
    const page = await this.ready();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimedOut()), this.config.timeoutMs);
    });
    try {
      return await Promise.race([work(page), timeout]);
    } catch (error) {
      if (!(error instanceof TimedOut)) throw unwrap(error);
      await this.discardPage();
      throw new Error(
        `${what} ran for more than ${this.config.timeoutMs / 1000} seconds and was stopped. The scene was lost with it: the next call starts on an empty one.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async discardPage(): Promise<void> {
    const context = this.context;
    this.page = null;
    this.context = null;
    await context?.close().catch(() => {});
  }

  /**
   * Calls one method of `window.threedoo` with one argument.
   *
   * By name, because Playwright sends the callback to the page as source: it
   * cannot close over anything on this side.
   */
  private call<K extends Exclude<keyof AutomationApi, 'version'>>(
    what: string,
    method: K,
    argument?: Parameters<AutomationApi[K]>[0],
  ): Promise<Awaited<ReturnType<AutomationApi[K]>>> {
    return this.within(what, (page) =>
      page.evaluate(
        ([name, value]) => {
          const api = window.threedoo as unknown as Record<string, (value: unknown) => unknown>;
          return api[name](value);
        },
        [method, argument] as const,
      ),
    ) as Promise<Awaited<ReturnType<AutomationApi[K]>>>;
  }

  async reset(): Promise<void> {
    await this.call('Reset', 'reset');
  }

  async run(script: string): Promise<RunReport> {
    const errors: string[] = [];
    this.pageErrors = errors;
    try {
      const report = await this.call('The script', 'run', script);
      return { ...report, logs: [...report.logs, ...errors] };
    } finally {
      this.pageErrors = null;
    }
  }

  open(request: OpenRequest): Promise<SceneSummary> {
    return this.call('Opening the file', 'open', request);
  }

  scene(): Promise<SceneSummary> {
    return this.call('Reading the scene', 'scene');
  }

  exportFile(request: ExportRequest): Promise<ExportedFile[]> {
    return this.call('The export', 'exportFile', request);
  }

  render(request: RenderRequest): Promise<RenderedView[]> {
    return this.call('Rendering', 'render', request);
  }

  reference(request?: ReferenceRequest): Promise<string> {
    return this.call('Reading the reference', 'reference', request);
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.page = null;
    this.context = null;
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    this.server = null;
  }
}

class TimedOut extends Error {}

/**
 * An error from inside the page, without the wrapping Playwright adds.
 *
 * The page's own message is the useful part: "There is no object called
 * BOX", not the evaluate call that carried it.
 */
function unwrap(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  const message = error.message
    .replace(/^page\.evaluate: /, '')
    .replace(/^Error: /, '')
    .split('\n    at ')[0]
    .trim();
  return new Error(message);
}
