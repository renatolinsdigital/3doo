import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Everything the server is told through its environment. */
export interface Config {
  /** The page the headless browser drives, or null to serve `distDir` itself. */
  engineUrl: string | null;
  /** The built app, served locally when no engine address is given. */
  distDir: string;
  /** Where the hosted editor lives, for the links `share_link` hands out. */
  appUrl: string | null;
  /** Where exported files and saved pictures go unless a call says otherwise. */
  outputDir: string;
  /** A Chromium or Chrome to launch instead of the one Playwright installed. */
  chromiumPath: string | null;
  /** How long one call may run before the page is thrown away. */
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

const text = (value: string | undefined) =>
  value !== undefined && value.trim() !== '' ? value.trim() : null;

/**
 * The configuration in `env`, with the defaults filled in.
 *
 * `root` is the repository the server runs from: the built app is looked for
 * in its `dist` folder.
 */
export function readConfig(env: NodeJS.ProcessEnv, root: string): Config {
  const timeout = Number(env.THREEDOO_TIMEOUT_MS);
  const output = text(env.THREEDOO_OUTPUT_DIR);
  return {
    engineUrl: text(env.THREEDOO_ENGINE_URL),
    distDir: join(root, 'dist'),
    appUrl: text(env.THREEDOO_APP_URL),
    outputDir: output ? resolve(output) : join(homedir(), '3doo-output'),
    chromiumPath: text(env.THREEDOO_CHROMIUM),
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Where the headless browser goes: the address it was given, else the built
 * app served from `dist` (which matches this server's own version), else the
 * hosted editor. `'dist'` means serve the folder.
 */
export function engineSource(config: Config): string | 'dist' {
  if (config.engineUrl) return config.engineUrl;
  if (existsSync(join(config.distDir, 'index.html'))) return 'dist';
  if (config.appUrl) return config.appUrl;
  throw new Error(
    'There is no 3DOO to drive. Run `npm run build` in the 3DOO folder, or set THREEDOO_ENGINE_URL (or THREEDOO_APP_URL) to where it is served.',
  );
}

/**
 * The editor a link opens in: the one a call names, else the hosted editor
 * this server was told about. A link to the server's own local copy would die
 * with the server, so that is never used.
 */
export function linkTarget(config: Config, asked: string | null): string {
  const target = asked ?? config.appUrl ?? config.engineUrl;
  if (target) return target;
  throw new Error(
    'No address to link to. Set THREEDOO_APP_URL to where 3DOO is hosted (for example https://3doo.example.com), or pass app_url.',
  );
}

/** A path from a call, read against the output folder when it is relative. */
export function outputPath(config: Config, path: string): string {
  return isAbsolute(path) ? path : resolve(config.outputDir, path);
}
