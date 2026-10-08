import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUTOMATION_VERSION, type SceneSummary } from '../src/app/automation/types';
import { MCP_SETTINGS, MCP_TOOLS } from '../src/domain/mcp/guide';
import { SNAPSHOT_VIEWS } from '../src/viewport/snapshot';

import { type Config, engineSource, linkTarget, readConfig } from './config';
import type { Engine } from './engine';
import { SUPPORTED_PROTOCOLS, createHandlers } from './server';
import { type ToolResult, VIEWS, callTool, launcherPage, sceneText, toolList } from './tools';

const EMPTY: SceneSummary = {
  name: 'untitled',
  objects: [],
  totals: { objects: 0, vertices: 0, faces: 0 },
  bounds: null,
};

/** An engine that records what it was asked, standing in for the browser. */
function fakeEngine() {
  const calls: { method: string; argument?: unknown }[] = [];
  const note = (method: string, argument?: unknown) => calls.push({ method, argument });
  const engine: Engine = {
    reset: async () => void note('reset'),
    run: async (script) => {
      note('run', script);
      return script.includes('oops')
        ? { ok: false, message: 'x is not defined', line: 2, scene: EMPTY, logs: [] }
        : {
            ok: true,
            message: 'Script ran: 1 object added',
            line: null,
            scene: EMPTY,
            logs: ['hi'],
          };
    },
    open: async (request) => (note('open', request), { ...EMPTY, name: request.name }),
    scene: async () => (note('scene'), EMPTY),
    exportFile: async (request) => {
      note('exportFile', request);
      return [
        {
          name: 'chair.obj',
          mimeType: 'text/plain',
          base64: Buffer.from('v 0 0 0\n').toString('base64'),
        },
        {
          name: 'chair.mtl',
          mimeType: 'text/plain',
          base64: Buffer.from('newmtl a\n').toString('base64'),
        },
      ];
    },
    render: async (request) => {
      note('render', request);
      return (request.views ?? ['perspective']).map((view) => ({ view, base64: 'iVBORw0KGgo=' }));
    },
    shareLink: async (appUrl) => (
      note('shareLink', appUrl),
      { url: `${appUrl}/modeling#scene=abc`, length: 1 }
    ),
    reference: async (request) => (note('reference', request), '# 3DOO scripting reference'),
    close: async () => {},
  };
  return { engine, calls };
}

let folder: string;
let config: Config;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), '3doo-mcp-'));
  config = { ...readConfig({}, folder), outputDir: folder };
});

afterEach(() => rm(folder, { recursive: true, force: true }));

const textOf = (result: ToolResult) =>
  result.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n');

describe('the tools', () => {
  it('name the same views the snapshot renderer draws', () => {
    expect([...VIEWS]).toEqual([...SNAPSHOT_VIEWS]);
  });

  it('describe every tool with a schema', () => {
    const tools = toolList();
    expect(tools.map((tool) => tool.name)).toEqual([
      'scripting_reference',
      'run_script',
      'render_views',
      'export_model',
      'share_link',
      'open_file',
      'get_scene',
    ]);
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
  });

  it('runs a script, resetting first when asked, and reports what it logged', async () => {
    const { engine, calls } = fakeEngine();
    const result = await callTool(
      'run_script',
      { script: 'scene.add("cube")', reset: true },
      {
        engine,
        config,
        protocolVersion: '2025-06-18',
      },
    );
    expect(calls.map((call) => call.method)).toEqual(['reset', 'run']);
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('Script ran: 1 object added');
    expect(textOf(result)).toContain('Console:\nhi');
  });

  it('marks a failed script as an error, with its line', async () => {
    const { engine } = fakeEngine();
    const result = await callTool(
      'run_script',
      { script: 'oops' },
      {
        engine,
        config,
        protocolVersion: '2025-06-18',
      },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/failed on line 2: x is not defined/);
  });

  it('turns a bad argument into an error the model can read', async () => {
    const { engine, calls } = fakeEngine();
    const result = await callTool(
      'run_script',
      { script: 42 },
      {
        engine,
        config,
        protocolVersion: '2025-06-18',
      },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('script has to be a string, not 42.');
    expect(calls).toEqual([]);
  });

  it('writes exported files to the output folder and links to them', async () => {
    const { engine } = fakeEngine();
    const result = await callTool(
      'export_model',
      { format: 'obj', name: 'chair' },
      {
        engine,
        config,
        protocolVersion: '2025-06-18',
      },
    );
    expect(await readFile(join(folder, 'chair.obj'), 'utf8')).toBe('v 0 0 0\n');
    expect(await readFile(join(folder, 'chair.mtl'), 'utf8')).toBe('newmtl a\n');
    expect(result.content.filter((item) => item.type === 'resource_link')).toHaveLength(2);
  });

  it('gives an older client the paths alone, and the contents when asked to embed', async () => {
    const { engine } = fakeEngine();
    const result = await callTool(
      'export_model',
      { format: 'obj', embed: true, directory: 'sub' },
      {
        engine,
        config,
        protocolVersion: '2025-03-26',
      },
    );
    expect(result.content.some((item) => item.type === 'resource_link')).toBe(false);
    const embedded = result.content.find((item) => item.type === 'resource');
    expect(embedded).toMatchObject({ resource: { mimeType: 'text/plain', text: 'v 0 0 0\n' } });
    expect(textOf(result)).toContain(join(folder, 'sub', 'chair.obj'));
  });

  it('returns pictures as images, and saves them when asked', async () => {
    const { engine } = fakeEngine();
    const result = await callTool(
      'render_views',
      { views: ['front', 'top'], save: true, name: 'my chair' },
      {
        engine,
        config,
        protocolVersion: '2025-06-18',
      },
    );
    expect(result.content.filter((item) => item.type === 'image')).toHaveLength(2);
    expect(textOf(result)).toContain(join(folder, 'my_chair_front.png'));
    expect(
      (await readFile(join(folder, 'my_chair_top.png')).catch(() => null))?.length,
    ).toBeGreaterThan(0);
  });

  it('links to the hosted editor, and says how to set one when there is none', async () => {
    const { engine, calls } = fakeEngine();
    const context = {
      engine,
      config: { ...config, appUrl: 'https://3doo.example.com' },
      protocolVersion: '',
    };
    const linked = textOf(await callTool('share_link', {}, context));
    expect(linked).toContain('https://3doo.example.com/modeling#scene=abc');

    await callTool('share_link', { app_url: 'https://other.example.com' }, context);
    expect(calls.at(-1)).toEqual({ method: 'shareLink', argument: 'https://other.example.com' });

    const unset = await callTool('share_link', {}, { engine, config, protocolVersion: '' });
    expect(unset.isError).toBe(true);
    expect(textOf(unset)).toMatch(/THREEDOO_APP_URL/);
  });

  it('saves the link as a page that opens it, for the model to pass on in place of the link', async () => {
    const { engine } = fakeEngine();
    const opened: string[] = [];
    const context = {
      engine,
      config: { ...config, appUrl: 'https://3doo.example.com' },
      protocolVersion: '2025-06-18',
      openInBrowser: async (path: string) => void opened.push(path),
    };

    const result = await callTool('share_link', { name: 'dining set' }, context);
    const path = join(folder, 'dining_set.html');
    expect(textOf(result)).toContain(`Saved ${path}`);
    expect(textOf(result)).toContain('too long to copy into a reply');
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: 'resource_link', name: 'dining_set.html' }),
    );
    expect(await readFile(path, 'utf8')).toContain(
      'location.replace("https://3doo.example.com/modeling#scene=abc")',
    );
    expect(opened).toEqual([]);

    const shown = await callTool('share_link', { open: true }, context);
    expect(opened).toEqual([join(folder, 'untitled.html')]);
    expect(textOf(shown)).toContain("Opened it in the user's browser.");
  });

  it('still hands over the page when no browser will open', async () => {
    const { engine } = fakeEngine();
    const result = await callTool(
      'share_link',
      { open: true },
      {
        engine,
        config: { ...config, appUrl: 'https://3doo.example.com' },
        protocolVersion: '',
        openInBrowser: () => Promise.reject(new Error('spawn xdg-open ENOENT')),
      },
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Could not open a browser on this computer');
    expect(textOf(result)).toContain(join(folder, 'untitled.html'));
  });

  it('writes a page that cannot be broken out of by the address it links to', () => {
    const page = launcherPage('a&b', 'https://x.example.com/"</script><b>#scene=abc');
    expect(page).toContain('<title>a&amp;b in 3DOO</title>');
    expect(page).not.toContain('</script><b>');
    expect(page).toContain('href="https://x.example.com/&quot;&lt;/script>&lt;b>#scene=abc"');
  });

  it('opens a file from the output folder by its relative path', async () => {
    const { engine, calls } = fakeEngine();
    await writeFile(join(folder, 'lamp.3doo'), '{}');
    const result = await callTool(
      'open_file',
      { path: 'lamp.3doo' },
      { engine, config, protocolVersion: '' },
    );
    expect(calls[0]).toEqual({ method: 'open', argument: { name: 'lamp.3doo', base64: 'e30=' } });
    expect(textOf(result)).toContain('lamp.3doo');

    const missing = await callTool(
      'open_file',
      { path: 'gone.obj' },
      { engine, config, protocolVersion: '' },
    );
    expect(textOf(missing)).toMatch(/There is no file at/);
  });

  it('writes a scene one object a line', () => {
    const scene = {
      ...EMPTY,
      objects: [{ name: 'A' }, { name: 'B' }] as SceneSummary['objects'],
    };
    expect(sceneText(scene).split('\n')).toEqual([
      'Scene: {"name":"untitled","totals":{"objects":0,"vertices":0,"faces":0},"bounds":null}',
      'Objects (2):',
      '{"name":"A"}',
      '{"name":"B"}',
    ]);
  });
});

describe('the server', () => {
  it('settles on the protocol the client asks for when it knows it, else its newest', async () => {
    const { engine } = fakeEngine();
    const handlers = createHandlers(engine, config, '1.0.0');
    const older = (await handlers.initialize({ protocolVersion: '2024-11-05' })) as {
      protocolVersion: string;
    };
    expect(older.protocolVersion).toBe('2024-11-05');
    const unknown = (await handlers.initialize({ protocolVersion: '1999-01-01' })) as {
      protocolVersion: string;
    };
    expect(unknown.protocolVersion).toBe(SUPPORTED_PROTOCOLS[0]);
  });

  it('runs one call at a time, in the order they came', async () => {
    const order: string[] = [];
    const { engine } = fakeEngine();
    engine.run = async (script) => {
      await new Promise((resolve) => setTimeout(resolve, script === 'slow' ? 30 : 0));
      order.push(script);
      return { ok: true, message: '', line: null, scene: EMPTY, logs: [] };
    };
    const handlers = createHandlers(engine, config, '1.0.0');
    await Promise.all([
      handlers['tools/call']({ name: 'run_script', arguments: { script: 'slow' } }),
      handlers['tools/call']({ name: 'run_script', arguments: { script: 'fast' } }),
    ]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('serves the scripting reference as a resource', async () => {
    const { engine } = fakeEngine();
    const handlers = createHandlers(engine, config, '1.0.0');
    const read = (await handlers['resources/read']({ uri: '3doo://reference/scripting' })) as {
      contents: { text: string }[];
    };
    expect(read.contents[0].text).toBe('# 3DOO scripting reference');
  });

  it('hands the reference topic and example on to the page', async () => {
    const { engine, calls } = fakeEngine();
    const context = { engine, config, protocolVersion: '' };
    await callTool('scripting_reference', {}, context);
    expect(calls.at(-1)).toEqual({
      method: 'reference',
      argument: { topic: undefined, example: undefined },
    });
    await callTool('scripting_reference', { topic: 'api' }, context);
    expect(calls.at(-1)).toEqual({
      method: 'reference',
      argument: { topic: 'api', example: undefined },
    });
  });

  it('says a link to localhost only opens while the app is being served', async () => {
    const { engine } = fakeEngine();
    const context = {
      engine,
      config: { ...config, appUrl: 'http://localhost:5173' },
      protocolVersion: '',
    };
    const linked = textOf(await callTool('share_link', {}, context));
    expect(linked).toContain('http://localhost:5173/modeling#scene=abc');
    expect(linked).toMatch(/only on the user's own computer/);
  });

  it('speaks the automation version the app does', () => {
    expect(AUTOMATION_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('the configuration', () => {
  it('reads its settings from the environment, with defaults', () => {
    const read = readConfig(
      {
        THREEDOO_APP_URL: ' https://3doo.example.com ',
        THREEDOO_OUTPUT_DIR: folder,
        THREEDOO_TIMEOUT_MS: '5000',
      },
      '/repo',
    );
    expect(read.appUrl).toBe('https://3doo.example.com');
    expect(read.outputDir).toBe(folder);
    expect(read.timeoutMs).toBe(5000);
    expect(read.distDir).toBe(join('/repo', 'dist'));
    expect(readConfig({ THREEDOO_TIMEOUT_MS: 'soon' }, '/repo').timeoutMs).toBe(60_000);
  });

  it('drives the build in dist before the hosted editor, and says what to do with neither', async () => {
    expect(() => engineSource(config)).toThrow(/npm run build/);
    expect(engineSource({ ...config, appUrl: 'https://3doo.example.com' })).toBe(
      'https://3doo.example.com',
    );

    await mkdir(config.distDir);
    await writeFile(join(config.distDir, 'index.html'), '');
    expect(engineSource({ ...config, appUrl: 'https://3doo.example.com' })).toBe('dist');
    expect(engineSource({ ...config, engineUrl: 'http://localhost:5173' })).toBe(
      'http://localhost:5173',
    );
  });

  it('never links to its own local copy, which dies with it', () => {
    expect(() => linkTarget(config, null)).toThrow(/THREEDOO_APP_URL/);
    expect(linkTarget({ ...config, engineUrl: 'https://dev.example.com' }, null)).toBe(
      'https://dev.example.com',
    );
    expect(
      linkTarget({ ...config, appUrl: 'https://3doo.example.com' }, 'https://x.example.com'),
    ).toBe('https://x.example.com');
  });
});

// The editor's MCP dialog and docs describe this server from a catalogue of
// their own, since the app cannot import Node code. These hold the two
// together, so the editor cannot promise a tool, an argument or a setting the
// server does not have.
describe("the editor's guide to the server", () => {
  it('names every tool the server lists, in the same order', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(toolList().map((tool) => tool.name));
  });

  it('names every argument of every tool', () => {
    for (const tool of toolList()) {
      const guide = MCP_TOOLS.find((candidate) => candidate.name === tool.name);
      expect([...(guide?.args ?? [])].sort(), tool.name).toEqual(
        Object.keys(tool.inputSchema.properties).sort(),
      );
    }
  });

  it('names every environment variable the configuration reads', async () => {
    const source = await readFile(join(import.meta.dirname, 'config.ts'), 'utf8');
    const read = [...source.matchAll(/env\.(THREEDOO_\w+)/g)].map((match) => match[1]);
    expect(MCP_SETTINGS.map((setting) => setting.name).sort()).toEqual([...new Set(read)].sort());
  });
});
