import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Config, readConfig } from './config.ts';
import { BrowserEngine, type Engine } from './engine.ts';
import { INVALID_PARAMS, RpcError, type Handler, serve } from './protocol.ts';
import { callTool, toolList } from './tools.ts';

/**
 * The 3DOO MCP server: lets an AI assistant build models with the scripting
 * API and hand them back as files, pictures or a link to the editor.
 *
 * Run by an MCP client over stdio (`node mcp/server.ts`). See docs/mcp.md.
 */

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const REFERENCE_URI = '3doo://reference/scripting';

const INSTRUCTIONS = `3DOO is a browser 3D mesh editor. These tools drive it to build models from JavaScript.

Workflow: read scripting_reference once, build the model with run_script (the scene persists between calls; reset: true starts over), check it with render_views, then hand it over with export_model (.3doo, .obj or .fbx files), render_views (pictures), or share_link (a link that opens the editor on the model). When the user asks to see the model from several sides, render the views they name: front, back, right, left, top, bottom, or perspective.`;

/** The MCP methods, answered against `engine`. */
export function createHandlers(
  engine: Engine,
  config: Config,
  version: string,
): Record<string, Handler> {
  let protocolVersion = SUPPORTED_PROTOCOLS[0];
  // One scene, so one call at a time: a render that started before a script
  // finished would picture half of it.
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const turn = queue.then(work, work);
    queue = turn.catch(() => {});
    return turn;
  };

  return {
    initialize: (params) => {
      const asked = (params as { protocolVersion?: unknown }).protocolVersion;
      protocolVersion =
        typeof asked === 'string' && SUPPORTED_PROTOCOLS.includes(asked)
          ? asked
          : SUPPORTED_PROTOCOLS[0];
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: '3doo', title: '3DOO', version },
        instructions: INSTRUCTIONS,
      };
    },
    'notifications/initialized': () => undefined,
    ping: () => ({}),
    'tools/list': () => ({ tools: toolList() }),
    'tools/call': (params) => {
      const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
      if (typeof name !== 'string')
        throw new RpcError(INVALID_PARAMS, 'tools/call needs a tool name.');
      const given =
        args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};
      return inTurn(() => callTool(name, given, { engine, config, protocolVersion }));
    },
    'resources/list': () => ({
      resources: [
        {
          uri: REFERENCE_URI,
          name: 'scripting-reference',
          title: '3DOO scripting reference',
          description: 'The scripting API and worked examples, as Markdown.',
          mimeType: 'text/markdown',
        },
      ],
    }),
    'resources/read': async (params) => {
      const { uri } = params as { uri?: unknown };
      if (uri !== REFERENCE_URI)
        throw new RpcError(INVALID_PARAMS, `Unknown resource: ${String(uri)}`);
      const text = await inTurn(() => engine.reference());
      return { contents: [{ uri, mimeType: 'text/markdown', text }] };
    },
  };
}

async function main(): Promise<void> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  const config = readConfig(process.env, root);
  const engine = new BrowserEngine(config);
  const log = (line: string) => process.stderr.write(`[3doo] ${line}\n`);

  let closing = false;
  const shutDown = async () => {
    if (closing) return;
    closing = true;
    await engine.close();
    process.exit(0);
  };
  process.on('SIGINT', shutDown);
  process.on('SIGTERM', shutDown);

  log(`ready, writing files to ${config.outputDir}`);
  await serve(process.stdin, process.stdout, createHandlers(engine, config, version), log);
  await shutDown();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`[3doo] ${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
  });
}
