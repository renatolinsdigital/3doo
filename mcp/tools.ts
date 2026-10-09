import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import type { ExportRequest, RenderRequest, SceneSummary } from '../src/app/automation/types.ts';

import { type Config, linkTarget, outputPath } from './config.ts';
import type { Engine } from './engine.ts';
import { INVALID_PARAMS, RpcError } from './protocol.ts';

export type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType: string; size: number }
  | {
      type: 'resource';
      resource:
        | { uri: string; mimeType: string; text: string }
        | { uri: string; mimeType: string; blob: string };
    };

export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export interface ToolContext {
  engine: Engine;
  config: Config;
  /** The protocol version the client and server settled on. */
  protocolVersion: string;
  /** Opens a file in the user's own browser. Tests put a stand-in here. */
  openInBrowser?: (path: string) => Promise<void>;
}

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, object>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  run(args: Args, context: ToolContext): Promise<ToolResult>;
}

/** The views, named as the editor names them; each is one of Shift and a number. */
export const VIEWS = ['perspective', 'front', 'back', 'right', 'left', 'top', 'bottom'] as const;
const SHADINGS = ['solid', 'solidWire', 'wireframe', 'xray', 'matcap'] as const;
const PROJECTIONS = ['auto', 'perspective', 'orthographic'] as const;
const FORMATS = ['3doo', 'obj', 'fbx'] as const;
const PRESETS = ['unity', 'unreal', 'blender', 'maya'] as const;
const TOPICS = ['quickstart', 'api', 'examples', 'all'] as const;

// ------------------------------------------------------------- arguments

function optional<T>(
  args: Args,
  key: string,
  type: 'string' | 'number' | 'boolean',
): T | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== type)
    throw new Error(`${key} has to be a ${type}, not ${JSON.stringify(value)}.`);
  return value as T;
}

function required<T>(args: Args, key: string, type: 'string' | 'number' | 'boolean'): T {
  const value = optional<T>(args, key, type);
  if (value === undefined) throw new Error(`${key} is required.`);
  return value;
}

const text = (value: string): Content => ({ type: 'text', text: value });
/**
 * A scene summary as the model reads it: the totals on one line and each
 * object on one of its own, which is a fraction of the tokens indented JSON
 * takes and just as easy to read.
 */
export function sceneText(scene: SceneSummary): string {
  const { objects, ...rest } = scene;
  const lines = objects.map((object) => JSON.stringify(object));
  return [`Scene: ${JSON.stringify(rest)}`, `Objects (${objects.length}):`, ...lines].join('\n');
}

const kilobytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;

const TEXT_TYPES = new Set(['application/json', 'text/plain']);

/** Resource links arrived in this revision of the protocol; older clients get the path as text. */
const knowsResourceLinks = (version: string) => version >= '2025-06-18';

// ----------------------------------------------------------------- tools

const scriptingReference: Tool = {
  name: 'scripting_reference',
  title: 'Scripting reference',
  description:
    'Returns the 3DOO scripting reference as Markdown. With no arguments it is a short quickstart (about 1,500 tokens): the conventions, a script that runs, every name the API has, and the rules a table does not say. That is enough to write scripts, so read it once, first. Ask for `topic: "api"` only to look up what a name does and the options and ranges it takes, or `example` for one finished model to copy from. `topic: "all"` is long.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        enum: [...TOPICS],
        default: 'quickstart',
        description:
          'quickstart: conventions, a first script, every name. api: what each name does, with options and ranges. examples: every finished model. all: everything.',
      },
      example: {
        type: 'string',
        description:
          'One finished model by id (the quickstart lists them), such as "axe". Wins over topic.',
      },
    },
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { engine }) {
    const topic = optional<string>(args, 'topic', 'string');
    const example = optional<string>(args, 'example', 'string');
    return { content: [text(await engine.reference({ topic, example }))] };
  },
};

const runScript: Tool = {
  name: 'run_script',
  title: 'Run a 3DOO script',
  description: [
    "Runs JavaScript against the 3DOO scene with the `scene` and `view` globals, the same API as the editor's SCRIPT dialog (see scripting_reference): add primitives or meshes of your own, edit them with any modelling operation, stack modifiers, cut booleans and colour objects or single faces.",
    'The scene persists between calls, so a model can be built over several scripts; pass reset: true to start from an empty scene.',
    'Units are metres, rotations degrees, +Y is up, and the front view looks from +Z.',
    'Returns what the run did and a summary of the scene: every object with its vertex and face counts, position, rotation, scale, world size and colour, and the bounds of the whole scene.',
    'A script that fails reports the reason and the line, and leaves the scene exactly as it was before the run.',
    'To read values out, `return` one or console.log them: text comes back as it is, anything else as JSON, so `return box.bounds` reads where an object sits.',
    'Afterwards, call render_views to look at the result, then export_model or share_link to hand it over.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description: 'The body of an async function. `await` works at the top level.',
      },
      reset: {
        type: 'boolean',
        default: false,
        description: 'Empty the scene before running, to build a new model from nothing.',
      },
    },
    required: ['script'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args, { engine }) {
    const script = required<string>(args, 'script', 'string');
    if (optional<boolean>(args, 'reset', 'boolean')) await engine.reset();
    const report = await engine.run(script);
    const head = report.ok
      ? report.message
      : `The script failed${report.line ? ` on line ${report.line}` : ''}: ${report.message}\nThe scene was left as it was before the run.`;
    const logs = report.logs.length > 0 ? `\n\nConsole:\n${report.logs.join('\n')}` : '';
    return {
      content: [text(`${head}${logs}\n\n${sceneText(report.scene)}`)],
      isError: !report.ok,
    };
  },
};

const renderViews: Tool = {
  name: 'render_views',
  title: 'Take pictures of the model',
  description: [
    "Renders the scene to PNG pictures, the way the editor's viewport draws it, and returns them as images.",
    '"perspective" is the view a fresh editor opens on. The others are the straight-on cameras of the editor\'s Shift+number keys: front (Shift+1), right (Shift+3), top (Shift+7), back (Ctrl+Shift+1), left (Ctrl+Shift+3) and bottom (Ctrl+Shift+7).',
    'Each picture frames the whole visible scene. Use one perspective view to check a result, and several views when the user asks to see the model from different sides.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      views: {
        type: 'array',
        items: { type: 'string', enum: [...VIEWS] },
        default: ['perspective'],
        description: 'Which views to render, one picture each.',
      },
      width: { type: 'integer', minimum: 16, maximum: 2048, default: 800 },
      height: { type: 'integer', minimum: 16, maximum: 2048, default: 600 },
      shading: {
        type: 'string',
        enum: [...SHADINGS],
        default: 'solidWire',
        description:
          'solidWire shows the surface with its edges, which shows the topology. solid is the cleaner picture.',
      },
      projection: {
        type: 'string',
        enum: [...PROJECTIONS],
        default: 'auto',
        description:
          'auto: perspective for the perspective view, orthographic for the straight-on views.',
      },
      grid: { type: 'boolean', default: true, description: 'Draw the ground grid.' },
      save: {
        type: 'boolean',
        default: false,
        description: 'Also write each picture as a PNG to the output folder.',
      },
      name: {
        type: 'string',
        description: 'File name stem for saved pictures. Defaults to the project name.',
      },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args, context) {
    const request: RenderRequest = {
      views: args.views as string[] | undefined,
      width: optional<number>(args, 'width', 'number'),
      height: optional<number>(args, 'height', 'number'),
      shading: optional<string>(args, 'shading', 'string'),
      projection: optional<string>(args, 'projection', 'string'),
      grid: optional<boolean>(args, 'grid', 'boolean'),
    };
    const shots = await context.engine.render(request);
    const content: Content[] = [];
    let saved: string[] = [];
    if (optional<boolean>(args, 'save', 'boolean')) {
      const stem = optional<string>(args, 'name', 'string') ?? (await context.engine.scene()).name;
      saved = await writeFiles(
        context.config.outputDir,
        shots.map((shot) => ({ name: `${safeStem(stem)}_${shot.view}.png`, base64: shot.base64 })),
      );
    }
    shots.forEach((shot, index) => {
      content.push(
        text(saved[index] ? `${shot.view} view, saved to ${saved[index]}` : `${shot.view} view`),
      );
      content.push({ type: 'image', data: shot.base64, mimeType: 'image/png' });
    });
    return { content };
  },
};

const exportModel: Tool = {
  name: 'export_model',
  title: 'Export the model',
  description: [
    'Writes the scene to files: "3doo" is the editor\'s own project file, which opens in 3DOO with everything editable; "obj" (with its .mtl) and "fbx" (binary FBX 7.4) are for game engines and other 3D programs.',
    'Modifiers are applied in OBJ and FBX. Files go to the output folder unless `directory` names another, and replace files of the same name there.',
    'Returns the path of each file, and the file itself when embed is true.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: [...FORMATS] },
      name: {
        type: 'string',
        description: 'File name without extension. Defaults to the project name.',
      },
      preset: {
        type: 'string',
        enum: [...PRESETS],
        description:
          'Axis and unit preset for OBJ and FBX, so the model arrives the right way up and the right size.',
      },
      triangulate: {
        type: 'boolean',
        description: 'Split every face into triangles (OBJ and FBX).',
      },
      directory: {
        type: 'string',
        description: 'Folder to write to, absolute or relative to the output folder.',
      },
      embed: {
        type: 'boolean',
        default: false,
        description:
          'Also return the file contents in the result, for a client that cannot read the disk.',
      },
    },
    required: ['format'],
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  async run(args, context) {
    const request: ExportRequest = {
      format: required<string>(args, 'format', 'string') as ExportRequest['format'],
      name: optional<string>(args, 'name', 'string'),
      preset: optional<string>(args, 'preset', 'string') as ExportRequest['preset'],
      triangulate: optional<boolean>(args, 'triangulate', 'boolean'),
    };
    const directory = optional<string>(args, 'directory', 'string');
    const folder = directory ? outputPath(context.config, directory) : context.config.outputDir;
    const files = await context.engine.exportFile(request);
    const paths = await writeFiles(folder, files);

    const content: Content[] = [
      text(
        files
          .map(
            (file, index) =>
              `Wrote ${paths[index]} (${kilobytes(Buffer.from(file.base64, 'base64').length)})`,
          )
          .join('\n'),
      ),
    ];
    files.forEach((file, index) => {
      const uri = pathToFileURL(paths[index]).href;
      if (knowsResourceLinks(context.protocolVersion)) {
        content.push({
          type: 'resource_link',
          uri,
          name: file.name,
          mimeType: file.mimeType,
          size: Buffer.from(file.base64, 'base64').length,
        });
      }
      if (optional<boolean>(args, 'embed', 'boolean')) {
        content.push({
          type: 'resource',
          resource: TEXT_TYPES.has(file.mimeType)
            ? {
                uri,
                mimeType: file.mimeType,
                text: Buffer.from(file.base64, 'base64').toString('utf8'),
              }
            : { uri, mimeType: file.mimeType, blob: file.base64 },
        });
      }
    });
    return { content };
  },
};

const shareLink: Tool = {
  name: 'share_link',
  title: 'Open the model in 3DOO',
  description: [
    'Saves a page that opens the current scene in the hosted 3DOO editor, ready to edit, save and export. The page is an .html file in the output folder with an OPEN IN 3DOO button and a DOWNLOAD .3DOO button.',
    'The whole model travels inside the page, so nothing is uploaded, any size works, and the page works for anyone the user sends it to. Give the user the path of that file.',
    'Pass open: true when the user wants to see the model in 3DOO: the page opens in their browser straight away, and its button opens the editor.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      app_url: {
        type: 'string',
        description:
          "Where 3DOO is hosted, such as https://3doo.example.com. Defaults to the server's THREEDOO_APP_URL.",
      },
      name: {
        type: 'string',
        description: 'File name of the .html, without extension. Defaults to the project name.',
      },
      open: {
        type: 'boolean',
        default: false,
        description: "Open the model in the user's browser now.",
      },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args, context) {
    const target = linkTarget(context.config, optional<string>(args, 'app_url', 'string') ?? null);
    const open = optional<boolean>(args, 'open', 'boolean');
    const scene = await context.engine.scene();
    const name = optional<string>(args, 'name', 'string') ?? scene.name;
    const [project] = await context.engine.exportFile({ format: '3doo' });
    const bytes = Buffer.from(project.base64, 'base64');

    const page = launcherPage({
      name,
      appUrl: target,
      payload: deflateRawSync(bytes).toString('base64url'),
      fileName: `${safeStem(name)}.3doo`,
      bytes: bytes.length,
      totals: scene.totals,
    });
    await mkdir(context.config.outputDir, { recursive: true });
    const path = join(context.config.outputDir, `${safeStem(name)}.html`);
    await writeFile(path, page);

    const lines = [
      `Saved ${path} (${kilobytes(Buffer.byteLength(page))}). It opens the model in 3DOO at ${target}, in any browser: double-click it, or send it to someone, and press OPEN IN 3DOO.`,
    ];
    if (open) {
      lines.push(
        await (context.openInBrowser ?? openWithSystem)(path).then(
          () => "Opened it in the user's browser, where they press OPEN IN 3DOO.",
          (error: Error) =>
            `Could not open a browser on this computer (${error.message}), so the user has to open the file.`,
        ),
      );
    }
    if (isLocal(target)) {
      lines.push(
        `It opens only on the user's own computer, and only while 3DOO is being served at ${target} (npm run dev or npm run preview). Say so when you hand it over.`,
      );
    }
    lines.push('', 'Give the user the path of the file.');

    const content: Content[] = [text(lines.join('\n'))];
    if (knowsResourceLinks(context.protocolVersion)) {
      content.push({
        type: 'resource_link',
        uri: pathToFileURL(path).href,
        name: basename(path),
        mimeType: 'text/html',
        size: Buffer.byteLength(page),
      });
    }
    return { content };
  },
};

const openFile: Tool = {
  name: 'open_file',
  title: 'Open a file',
  description:
    'Loads a file from disk into the scene. A .3doo project replaces the scene; an .obj or .fbx is imported into it, beside what is already there. Use it to edit a model the user already has. Returns a summary of the scene.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file, absolute or relative to the output folder.' },
    },
    required: ['path'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args, context) {
    const path = outputPath(context.config, required<string>(args, 'path', 'string'));
    const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      throw new Error(error.code === 'ENOENT' ? `There is no file at ${path}.` : error.message);
    });
    const scene = await context.engine.open({
      name: basename(path),
      base64: bytes.toString('base64'),
    });
    return { content: [text(`Opened ${path}.\n\n${sceneText(scene)}`)] };
  },
};

const getScene: Tool = {
  name: 'get_scene',
  title: 'Describe the scene',
  description:
    'Returns what is in the scene: every object with its counts, transform, world size and colour, and the bounds of the whole scene.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(_args, { engine }) {
    return { content: [text(sceneText(await engine.scene()))] };
  },
};

export const TOOLS: readonly Tool[] = [
  scriptingReference,
  runScript,
  renderViews,
  exportModel,
  shareLink,
  openFile,
  getScene,
];

// ----------------------------------------------------------------- files

function safeStem(name: string): string {
  return (basename(name).replace(/[<>:"|?*\s]+/g, '_') || 'model').slice(0, 120);
}

async function writeFiles(
  folder: string,
  files: readonly { name: string; base64: string }[],
): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  return Promise.all(
    files.map(async (file) => {
      const path = join(folder, basename(file.name));
      await writeFile(path, Buffer.from(file.base64, 'base64'));
      return path;
    }),
  );
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);

/**
 * How the page hands the scene to the editor. A copy of `SCENE_HANDOVER` in
 * `src/domain/services/sceneLink.ts`, which the server cannot import: a test
 * holds the two together.
 */
export const HANDOVER = {
  hash: '#receive',
  ready: '3doo:ready',
  scene: '3doo:scene',
  opened: '3doo:opened',
  failed: '3doo:failed',
} as const;

/** How long the page waits for the editor's tab to answer before saying so. */
const ANSWER_WAIT_MS = 20_000;

/** The 3DOO mark, as `public/favicon.svg` draws it. */
const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="88" fill="#e5342a"/><path stroke="#f4f1ea" stroke-width="44" d="M256 311L256 169"/><path fill="#f4f1ea" d="M256 91L302 169L210 169Z"/><path stroke="#f4f1ea" stroke-width="44" d="M256 311L378.98 382"/><path fill="#f4f1ea" d="M446.53 421L355.98 421.84L401.98 342.16Z"/><path stroke="#f4f1ea" stroke-width="44" d="M256 311L133.02 382"/><path fill="#f4f1ea" d="M65.47 421L110.02 342.16L156.02 421.84Z"/><circle cx="256" cy="311" r="34" fill="#f4f1ea"/></svg>';

export interface Launch {
  /** The model's name, which titles the page. */
  name: string;
  /** Where 3DOO is hosted. */
  appUrl: string;
  /** The `.3doo` text, deflated and in base64url: what a scene link carries. */
  payload: string;
  /** The name DOWNLOAD .3DOO gives the file. */
  fileName: string;
  /** The size of the `.3doo`, in bytes. */
  bytes: number;
  totals: SceneSummary['totals'];
}

/**
 * The page `share_link` saves: the model, and a button that opens it in 3DOO.
 *
 * The page holds the scene itself and hands it to the editor's tab with
 * `postMessage` (see `HANDOVER`), so nothing limits its size. A link carrying
 * the scene in its hash has a ceiling, and a model that retypes one into a
 * chat reply gets characters wrong. A file path is short enough to pass on
 * intact.
 *
 * The tab is opened from a click, since a browser blocks one opened on load,
 * and with `window.open`, since a link with `target="_blank"` cuts the tab off
 * from the page that has to answer it.
 */
export function launcherPage(launch: Launch): string {
  const app = launch.appUrl.replace(/[#?].*$/, '').replace(/\/+$/, '');
  const title = escapeHtml(launch.name);
  const data = {
    tab: `${app}/modeling${HANDOVER.hash}`,
    origin: new URL(app).origin,
    payload: launch.payload,
    file: launch.fileName,
    wait: ANSWER_WAIT_MS,
    messages: HANDOVER,
  };
  const facts = [
    ['OBJECTS', launch.totals.objects.toLocaleString('en-US')],
    ['VERTICES', launch.totals.vertices.toLocaleString('en-US')],
    ['FACES', launch.totals.faces.toLocaleString('en-US')],
    ['SIZE', kilobytes(launch.bytes)],
  ]
    .map(([label, value]) => `<div class="fact"><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('\n      ');
  const where = isLocal(app)
    ? ` It opens only on this computer, and only while 3DOO is being served there.`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} in 3DOO</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=JetBrains+Mono:wght@400;700&display=swap">
<style>
  :root {
    --void: #0b0b0b;
    --bone: #f4f1ea;
    --bone-dim: #ddd8cd;
    --ink-muted: #57534c;
    --red: #e5342a;
    --rust: #b8452f;
    --ash: #1a1918;
    --amber: #f2a03d;
    --cyan: #3de0d0;
    --border: 3px;
    --border-thin: 2px;
    --shadow: 4px;
    --gutter: 32px;
    --display: 'Archivo Black', 'Arial Black', sans-serif;
    --mono: 'JetBrains Mono', Consolas, 'Courier New', monospace;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    display: grid;
    place-items: center;
    min-height: 100vh;
    padding: 16px;
    font-family: var(--mono);
    color: var(--void);
    background: var(--ash);
  }
  .card {
    width: min(100%, 640px);
    background: var(--bone);
    border: var(--border) solid var(--void);
    box-shadow: 8px 8px 0 var(--void);
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 8px;
    border-bottom: var(--border) solid var(--void);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 8px;
    font-family: var(--display);
    font-size: 14px;
    letter-spacing: 0.08em;
    color: var(--bone);
    background: var(--void);
  }
  .brand svg { width: 20px; height: 20px; }
  .kind { font-size: 11px; letter-spacing: 0.1em; color: var(--ink-muted); }
  .hero {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 24px;
    padding: var(--gutter) var(--gutter) 40px;
    background-color: var(--bone);
    background-image:
      linear-gradient(var(--bone-dim) 1px, transparent 1px),
      linear-gradient(90deg, var(--bone-dim) 1px, transparent 1px);
    background-size: 24px 24px;
    border-bottom: var(--border) solid var(--void);
  }
  .badges { display: flex; flex-wrap: wrap; }
  .badge {
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    overflow-wrap: anywhere;
    background: var(--bone);
    border: var(--border-thin) solid var(--void);
  }
  .badge--solid { color: var(--bone); background: var(--void); }
  h1 {
    font-family: var(--display);
    font-size: clamp(36px, 9vw, 64px);
    font-weight: 400;
    line-height: 0.95;
    letter-spacing: 0.01em;
  }
  h1 span { color: var(--red); }
  .facts { padding: 0 var(--gutter); }
  .fact {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 0;
    font-size: 11px;
    letter-spacing: 0.12em;
    border-top: var(--border-thin) solid var(--void);
  }
  .fact:first-child { border-top: none; }
  .fact dt { color: var(--ink-muted); }
  .fact dd { font-weight: 700; font-variant-numeric: tabular-nums; }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 24px var(--gutter);
    border-top: var(--border) solid var(--void);
  }
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 44px;
    padding: 4px 16px;
    font: 700 12px/1 var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--void);
    background: var(--bone);
    border: var(--border) solid var(--void);
    box-shadow: var(--shadow) var(--shadow) 0 var(--void);
    cursor: pointer;
    transition: background-color 80ms linear;
  }
  .button:hover { background: var(--bone-dim); }
  .button:active { transform: translate(var(--shadow), var(--shadow)); box-shadow: none; }
  .button:focus-visible { outline: var(--border) solid var(--cyan); outline-offset: 2px; }
  .button--primary { color: var(--bone); background: var(--red); }
  .button--primary:hover { background: var(--rust); }
  .status {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0 var(--gutter) 24px;
    padding: 8px;
    font-size: 12px;
    line-height: 1.5;
    border: var(--border-thin) solid var(--void);
  }
  .status:empty { display: none; }
  .status::before {
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    width: 20px;
    height: 20px;
    font-family: var(--display);
    font-size: 10px;
    border: var(--border-thin) solid var(--void);
  }
  .status[data-tone='busy']::before { content: '…'; background: var(--amber); }
  .status[data-tone='done']::before { content: '✓'; background: var(--cyan); }
  .status[data-tone='error']::before { content: '!'; color: var(--bone); background: var(--red); }
  .note {
    padding: 12px var(--gutter);
    font-size: 11px;
    line-height: 1.6;
    color: var(--ink-muted);
    border-top: var(--border) solid var(--void);
  }
  .note b { color: var(--void); }
  @media (max-width: 480px) {
    :root { --gutter: 16px; }
    .actions .button { flex: 1 1 100%; }
  }
</style>
</head>
<body>
  <main class="card">
    <header class="bar">
      <span class="brand">${LOGO}3DOO</span>
      <span class="kind">SHARED MODEL</span>
    </header>
    <section class="hero">
      <p class="badges">
        <span class="badge badge--solid">${title}</span><span class="badge">EDITABLE IN 3DOO</span>
      </p>
      <h1>YOUR MODEL<br>IS READY<span>.</span></h1>
    </section>
    <dl class="facts">
      ${facts}
    </dl>
    <div class="actions">
      <button class="button button--primary" id="open" type="button">OPEN IN 3DOO <span aria-hidden="true">→</span></button>
      <button class="button" id="download" type="button">DOWNLOAD .3DOO</button>
    </div>
    <p class="status" id="status" role="status"></p>
    <noscript>
      <p class="status" data-tone="error">This page needs JavaScript to open the model. Open the file in a web browser.</p>
    </noscript>
    <p class="note">
      Opens in the 3DOO editor at <b>${escapeHtml(app.replace(/^https?:\/\//, ''))}</b>.
      The model goes straight from this page to that tab and is never uploaded.${where}
    </p>
  </main>
  <script>
    (() => {
      const launch = ${JSON.stringify(data).replace(/</g, '\\u003c')};
      const messages = launch.messages;
      const status = document.getElementById('status');
      const say = (tone, text) => {
        status.dataset.tone = tone;
        status.textContent = text;
      };
      let waiting = 0;

      addEventListener('message', (event) => {
        if (event.origin !== launch.origin || !event.data) return;
        const { type, reason } = event.data;
        if (type === messages.ready) {
          event.source.postMessage({ type: messages.scene, payload: launch.payload }, launch.origin);
          say('busy', 'Sending the model to 3DOO…');
        } else if (type === messages.opened) {
          clearTimeout(waiting);
          say('done', 'Opened in 3DOO. You can close this page.');
        } else if (type === messages.failed) {
          clearTimeout(waiting);
          say('error', '3DOO could not open the model. ' + reason);
        }
      });

      document.getElementById('open').addEventListener('click', () => {
        clearTimeout(waiting);
        if (!window.open(launch.tab, '_blank')) {
          say('error', 'The browser blocked the new tab. Allow pop-ups for this page and press OPEN IN 3DOO again, or download the .3doo.');
          return;
        }
        say('busy', 'Opening 3DOO in a new tab…');
        waiting = setTimeout(() => {
          say('error', '3DOO has not answered. If its tab is still loading, give it a moment. If it opened on a cube, that 3DOO is older than this page: download the .3doo and open it there with FILE > OPEN.');
        }, launch.wait);
      });

      document.getElementById('download').addEventListener('click', async () => {
        try {
          const base64 = launch.payload.replace(/-/g, '+').replace(/_/g, '/');
          const packed = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
          const unpack = new DecompressionStream('deflate-raw');
          const writer = unpack.writable.getWriter();
          writer.write(packed).catch(() => {});
          writer.close().catch(() => {});
          const file = new Blob([await new Response(unpack.readable).arrayBuffer()], { type: 'application/json' });
          const anchor = document.createElement('a');
          anchor.href = URL.createObjectURL(file);
          anchor.download = launch.file;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(anchor.href), 60000);
          say('done', 'Downloading ' + launch.file + '. Open it in 3DOO with FILE > OPEN.');
        } catch (error) {
          say('error', 'This browser could not unpack the model (' + error.message + '). Try a current Chrome, Edge, Firefox or Safari.');
        }
      });
    })();
  </script>
</body>
</html>
`;
}

const OPENERS: Partial<Record<NodeJS.Platform, string[]>> = {
  win32: ['rundll32.exe', 'url.dll,FileProtocolHandler'],
  darwin: ['open'],
};

/**
 * Opens `path` the way double-clicking it would. By its file URL, which has
 * no spaces for Windows to split the argument on.
 */
function openWithSystem(path: string): Promise<void> {
  const [command, ...args] = OPENERS[process.platform] ?? ['xdg-open'];
  return new Promise((resolve, reject) => {
    // stdio ignored: the server's own stdout is the protocol channel.
    const child = spawn(command, [...args, pathToFileURL(path).href], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

// -------------------------------------------------------------- dispatch

/** The tools as `tools/list` describes them. */
export function toolList() {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations,
  }));
}

/**
 * Runs a tool. A failure inside it, a bad argument included, comes back as a
 * result marked as an error, which the model reads and can correct, rather
 * than as a protocol error, which a client may only log. Only a tool that does
 * not exist is a mistake in the call itself.
 */
export async function callTool(
  name: string,
  args: Args,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
  try {
    return await tool.run(args, context);
  } catch (error) {
    return { content: [text((error as Error).message)], isError: true };
  }
}
