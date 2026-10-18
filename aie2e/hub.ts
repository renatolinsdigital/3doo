import { type Server, type Socket, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import type { Config } from '../mcp/config.ts';
import type { Engine } from '../mcp/engine.ts';
import type { Handler } from '../mcp/protocol.ts';
import { serve } from '../mcp/protocol.ts';
import { createHandlers } from '../mcp/server.ts';
import type { ToolResult } from '../mcp/tools.ts';

/**
 * One scene for the whole run, which every agent session reaches through
 * `bridge.ts`, each on a port of its own, so its calls are told apart even
 * while two judges run at once. The modeller's port gets every tool; a judge's
 * port gets an engine that refuses anything that would change the scene, so a
 * judge can look from any angle and measure, and cannot touch.
 */

export type Role = 'modeler' | 'judge';

export interface ToolCall {
  at: number;
  role: Role;
  /** The agent whose port the call came in on. */
  agent: string;
  tool: string;
  ok: boolean;
  ms: number;
  error: string | null;
}

/** Tools after which the modeller's scene may look different. */
const CHANGING = new Set(['run_script', 'open_file']);

/** All calls on one queue: a judge's render must not land halfway through a script. */
export function serialized(engine: Engine): Engine {
  let queue: Promise<unknown> = Promise.resolve();
  const turn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };
  return {
    reset: () => turn(() => engine.reset()),
    run: (script) => turn(() => engine.run(script)),
    open: (request) => turn(() => engine.open(request)),
    scene: () => turn(() => engine.scene()),
    exportFile: (request) => turn(() => engine.exportFile(request)),
    render: (request) => turn(() => engine.render(request)),
    reference: (request) => turn(() => engine.reference(request)),
    loadReference: (request) => turn(() => engine.loadReference(request)),
    traceReference: (request) => turn(() => engine.traceReference(request)),
    compareReference: (request) => turn(() => engine.compareReference(request)),
    inspect: (request) => turn(() => engine.inspect(request)),
    close: () => engine.close(),
  };
}

const refuse = (what: string) => () =>
  Promise.reject(new Error(`A judge looks and measures and does not ${what}.`));

/** The engine a judge gets: everything that reads, nothing that writes. */
export function readOnly(engine: Engine): Engine {
  return {
    ...engine,
    reset: refuse('empty the scene'),
    run: refuse('run scripts'),
    open: refuse('open files'),
    exportFile: refuse('export'),
    loadReference: refuse('load references'),
    close: async () => {},
  };
}

export class SceneHub {
  readonly calls: ToolCall[] = [];
  /** Called after a modeller's call that may have changed the scene. Not awaited: the window follows on its own time. */
  onChange: (() => Promise<void>) | null = null;
  /** Called on every finished call, for the progress line. */
  onCall: ((call: ToolCall) => void) | null = null;

  private readonly servers: Server[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly engines: Record<Role, Engine>;
  private readonly config: Config;
  private readonly version: string;

  constructor(engine: Engine, config: Config, version: string) {
    this.engines = { modeler: engine, judge: readOnly(engine) };
    this.config = config;
    this.version = version;
  }

  private handlers(agent: string, role: Role): Record<string, Handler> {
    const handlers = createHandlers(this.engines[role], this.config, this.version);
    const call = handlers['tools/call'];
    handlers['tools/call'] = async (params) => {
      const started = Date.now();
      const tool = String((params as { name?: unknown }).name ?? '?');
      const result = (await call(params)) as ToolResult;
      const failed = result.isError === true;
      const first = result.content.find((item) => item.type === 'text');
      const record: ToolCall = {
        at: started,
        role,
        agent,
        tool,
        ok: !failed,
        ms: Date.now() - started,
        error: failed && first?.type === 'text' ? first.text.slice(0, 600) : null,
      };
      this.calls.push(record);
      this.onCall?.(record);
      if (role === 'modeler' && !failed && CHANGING.has(tool)) {
        void this.onChange?.().catch(() => {});
      }
      return result;
    };
    return handlers;
  }

  /** Opens a local port for each agent, with its role's tools, and says which is whose. */
  async listen<Name extends string>(agents: Record<Name, Role>): Promise<Record<Name, number>> {
    const ports = {} as Record<Name, number>;
    for (const [agent, role] of Object.entries(agents) as [Name, Role][]) {
      const server = createServer((socket) => {
        this.sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => this.sockets.delete(socket));
        void serve(socket, socket, this.handlers(agent, role));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      this.servers.push(server);
      ports[agent] = (server.address() as AddressInfo).port;
    }
    return ports;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(
      this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }
}
