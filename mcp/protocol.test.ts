import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { type Handler, INVALID_PARAMS, RpcError, serve } from './protocol';

/** Sends `lines` to a server over stdio and collects every answer it writes. */
async function exchange(handlers: Record<string, Handler>, lines: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on('data', (chunk: Buffer) =>
    written.push(...chunk.toString().split('\n').filter(Boolean)),
  );

  const done = serve(input, output, handlers);
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return written.map((line) => JSON.parse(line));
}

const request = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });

describe('the stdio transport', () => {
  it('answers a request with its handler, under the same id', async () => {
    const answers = await exchange({ add: (p) => (p as number[])[0] + (p as number[])[1] }, [
      request(7, 'add', [2, 3]),
    ]);
    expect(answers).toEqual([{ jsonrpc: '2.0', id: 7, result: 5 }]);
  });

  it('runs a notification without answering it', async () => {
    let heard = false;
    const answers = await exchange({ 'notifications/initialized': () => void (heard = true) }, [
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ]);
    expect(heard).toBe(true);
    expect(answers).toEqual([]);
  });

  it('says when a method does not exist, and when a line is not JSON', async () => {
    const answers = await exchange({}, [request(1, 'nope'), '{oops']);
    expect(answers).toContainEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found: nope' },
    });
    expect(answers).toContainEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });

  it('passes on the code of an error a handler raises, and hides nothing else', async () => {
    const answers = await exchange(
      {
        picky: () => {
          throw new RpcError(INVALID_PARAMS, 'bad name');
        },
        broken: async () => {
          throw new Error('disk full');
        },
      },
      [request(1, 'picky'), request(2, 'broken')],
    );
    expect(answers).toContainEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'bad name' },
    });
    expect(answers).toContainEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32603, message: 'disk full' },
    });
  });

  it('does not take a method from the object prototype', async () => {
    const answers = await exchange({}, [request(1, 'toString')]);
    expect(answers[0].error.code).toBe(-32601);
  });

  it('waits for slow answers before it finishes', async () => {
    const answers = await exchange(
      { slow: () => new Promise((resolve) => setTimeout(() => resolve('late'), 20)) },
      [request(1, 'slow')],
    );
    expect(answers).toEqual([{ jsonrpc: '2.0', id: 1, result: 'late' }]);
  });
});
