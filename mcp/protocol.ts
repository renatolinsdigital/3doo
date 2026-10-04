import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/**
 * JSON-RPC 2.0 over stdio, the transport MCP clients launch a local server
 * with: one message per line on stdin, one per line on stdout, and stderr free
 * for logging.
 *
 * Written out rather than taken from the MCP SDK, which brings an HTTP server,
 * an OAuth client and a schema library with it. A local stdio server answers a
 * handful of methods, and this is all of the protocol those need.
 */

export type RequestId = string | number;

export interface RpcMessage {
  jsonrpc?: string;
  id?: RequestId | null;
  method?: string;
  params?: unknown;
}

export type Handler = (params: unknown) => Promise<unknown> | unknown;

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * Answers each request on `input` with the handler named by its method, until
 * `input` ends and every answer has gone out.
 *
 * Notifications (messages without an id) run their handler, when there is
 * one, and are never answered. Requests are answered in the order they finish,
 * which JSON-RPC allows: the id says which answer is which.
 */
export function serve(
  input: Readable,
  output: Writable,
  handlers: Record<string, Handler>,
  log: (line: string) => void = () => {},
): Promise<void> {
  const send = (message: object) => output.write(`${JSON.stringify(message)}\n`);
  const pending = new Set<Promise<void>>();

  const answer = async (message: RpcMessage) => {
    const { id, method } = message;
    const isRequest = id !== undefined && id !== null;
    if (typeof method !== 'string' || message.jsonrpc !== '2.0') {
      if (isRequest) {
        send({ jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'Invalid request' } });
      }
      return;
    }

    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    if (!isRequest) {
      if (handler) await Promise.resolve(handler(message.params)).catch(() => {});
      return;
    }
    if (!handler) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` },
      });
      return;
    }

    try {
      const result = await handler(message.params ?? {});
      send({ jsonrpc: '2.0', id, result: result ?? {} });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : INTERNAL_ERROR;
      const text = error instanceof Error ? error.message : String(error);
      if (code === INTERNAL_ERROR) log(`${method} failed: ${text}`);
      send({ jsonrpc: '2.0', id, error: { code, message: text } });
    }
  };

  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Infinity });

    lines.on('line', (line) => {
      if (line.trim() === '') return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
        return;
      }
      // A batch is legal JSON-RPC, though MCP clients send one message a line.
      for (const each of Array.isArray(message) ? message : [message]) {
        const task = answer(
          each !== null && typeof each === 'object' ? (each as RpcMessage) : {},
        ).finally(() => pending.delete(task));
        pending.add(task);
      }
    });

    lines.on('close', () => {
      void Promise.allSettled([...pending]).then(() => resolve());
    });
  });
}
