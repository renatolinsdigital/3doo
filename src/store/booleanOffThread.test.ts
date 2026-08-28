import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTransform } from '@kernel/index';
import { serializeMesh } from '@kernel/mesh/serialize';
import { createBox } from '@kernel/primitives';

import type { BooleanReply, BooleanRequest } from './boolean.worker';
import { WorkerUnavailable, booleanOffThread, canRunOffThread } from './booleanOffThread';

/** Stands in for the real worker: replies on a script the test writes. */
function stubWorker(script: (request: BooleanRequest) => BooleanReply[], fail?: string) {
  const posted: BooleanRequest[] = [];

  class Fake {
    onmessage: ((event: MessageEvent<BooleanReply>) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    terminated = false;

    postMessage(request: BooleanRequest) {
      posted.push(request);
      queueMicrotask(() => {
        if (fail !== undefined) {
          this.onerror?.({ message: fail });
          return;
        }
        for (const reply of script(request)) {
          this.onmessage?.({ data: reply } as MessageEvent<BooleanReply>);
        }
      });
    }

    terminate() {
      this.terminated = true;
    }
  }

  vi.stubGlobal('Worker', Fake);
  return posted;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('running a boolean off the main thread', () => {
  it('is not attempted where there is no worker to attempt it on', () => {
    // jsdom, which is where the rest of the suite runs, and the reason every
    // other test still exercises the in-place path.
    expect(canRunOffThread()).toBe(false);
  });

  it('hands back every stage the worker reports, then the mesh', async () => {
    const result = createBox(2);
    const posted = stubWorker(() => [
      { type: 'progress', value: 0.25 },
      { type: 'progress', value: 0.75 },
      { type: 'done', mesh: serializeMesh(result) },
    ]);

    const steps = booleanOffThread(
      'union',
      createBox(2),
      createBox(1),
      createTransform(),
      createTransform(),
      [0],
    );

    const seen: number[] = [];
    let step = await steps.next();
    while (!step.done) {
      seen.push(step.value);
      step = await steps.next();
    }

    expect(seen).toEqual([0.25, 0.75]);
    expect(step.value.faces.size).toBe(result.faces.size);
    expect(step.value.verts.size).toBe(result.verts.size);
    // Both meshes crossed as flat arrays; a BMesh itself would not survive it.
    expect(posted).toHaveLength(1);
    expect(posted[0].op).toBe('union');
    expect(posted[0].target.positions.length).toBe(result.verts.size * 3);
  });

  it('says the crossing is unavailable when the worker never starts', async () => {
    stubWorker(() => [], 'failed to fetch the module');

    const steps = booleanOffThread(
      'union',
      createBox(2),
      createBox(1),
      createTransform(),
      createTransform(),
      [0],
    );

    // The caller reads this as "run it here instead" rather than as a cut that
    // went wrong, because nothing has been written and it can simply be redone.
    await expect(steps.next()).rejects.toBeInstanceOf(WorkerUnavailable);
  });

  it('passes a boolean that threw inside the worker straight through', async () => {
    stubWorker(() => [{ type: 'failed', reason: 'the tool has no volume' }]);

    const steps = booleanOffThread(
      'union',
      createBox(2),
      createBox(1),
      createTransform(),
      createTransform(),
      [0],
    );

    // Not a `WorkerUnavailable`: running it again here would only throw again,
    // so the caller lets it out rather than retrying.
    const thrown = await steps.next().then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(WorkerUnavailable);
    expect((thrown as Error).message).toBe('the tool has no volume');
  });
});
