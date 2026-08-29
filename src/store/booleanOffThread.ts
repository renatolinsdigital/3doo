import type { Transform } from '@kernel/index';
import type { BMesh } from '@kernel/mesh';
import { deserializeMesh, serializeMesh } from '@kernel/mesh/serialize';
import type { BooleanOp } from '@kernel/ops/boolean';

import type { BooleanReply, BooleanRequest } from './boolean.worker';

/**
 * The worker never started, or died without saying why.
 *
 * Distinct from a boolean that threw inside one: this means the crossing is not
 * available (a browser that could not fetch the module, a policy that forbids
 * it) and the caller can simply run the cut in place instead. A boolean that
 * threw would only throw again.
 */
export class WorkerUnavailable extends Error {}

/**
 * Whether the cut can be handed to a worker at all.
 *
 * jsdom has none, and neither does a browser that failed to fetch the module.
 * Both fall back to running it here, which is what the editor did before and
 * still works, slower, and the window stops drawing while it does.
 */
export function canRunOffThread(): boolean {
  return typeof Worker === 'function';
}

/**
 * One boolean, run on a worker, yielding the stages it reports.
 *
 * An async generator, so the caller drives it exactly as it drives the in-place
 * one: same progress bar, same paint between stages. What differs is where the
 * work happens. The main thread is idle between stages rather than doing the
 * cut, so the window keeps drawing however long the cut takes.
 *
 * The crossing is not free: a mesh is flattened on the way out and rebuilt on
 * the way back, since a BMesh is a cycle of loops pointing at each other and
 * nothing structured-cloneable. It is a fixed cost of about a tenth of a second
 * on a mesh of a hundred thousand faces, against a cut that would otherwise
 * hold the thread for seconds.
 */
export async function* booleanOffThread(
  op: BooleanOp,
  target: BMesh,
  tool: BMesh,
  targetTransform: Transform,
  toolTransform: Transform,
  slots: number[],
): AsyncGenerator<number, BMesh> {
  const worker = new Worker(new URL('./boolean.worker.ts', import.meta.url), { type: 'module' });

  // Stages arrive when the worker reaches them, which is not when the caller
  // asks for the next one. The queue holds what has come in; the waiter is how
  // an ask that arrives first gets answered later.
  const queue: BooleanReply[] = [];
  let waiting: (() => void) | null = null;
  const arrived = () => {
    const wake = waiting;
    waiting = null;
    wake?.();
  };

  worker.onmessage = (event: MessageEvent<BooleanReply>) => {
    queue.push(event.data);
    arrived();
  };
  let broken: string | null = null;
  worker.onerror = (event) => {
    broken = event.message || 'the worker did not start';
    arrived();
  };

  const request: BooleanRequest = {
    op,
    target: serializeMesh(target),
    tool: serializeMesh(tool),
    targetTransform,
    toolTransform,
    slots,
  };

  try {
    worker.postMessage(request);

    for (;;) {
      if (queue.length === 0) {
        if (broken !== null) throw new WorkerUnavailable(broken);
        await new Promise<void>((resolve) => {
          waiting = resolve;
        });
        continue;
      }

      const reply = queue.shift() as BooleanReply;
      if (reply.type === 'progress') {
        yield reply.value;
        continue;
      }
      if (reply.type === 'failed') throw new Error(reply.reason);
      return deserializeMesh(reply.mesh);
    }
  } finally {
    worker.terminate();
  }
}
