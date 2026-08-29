import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTransform } from '@kernel/index';
import { deserializeMesh, serializeMesh } from '@kernel/mesh/serialize';
import { booleanMesh } from '@kernel/ops/boolean';
import { createBox, createUVSphere } from '@kernel/primitives';

import type { BooleanReply, BooleanRequest } from './boolean.worker';

/**
 * Drives the worker's own handler, with `self` standing in for the thread.
 *
 * The crossing is where a boolean run elsewhere can quietly differ from one run
 * here: the transforms have to be rebuilt on the far side, the material slots
 * carried across, the mesh flattened and put back together. This is that, with
 * the thread itself the only part left out.
 */
async function ask(request: BooleanRequest): Promise<BooleanReply[]> {
  const replies: BooleanReply[] = [];
  vi.stubGlobal('postMessage', (reply: BooleanReply) => replies.push(reply));

  const worker = await import('./boolean.worker');
  void worker;
  const handle = self.onmessage as ((event: MessageEvent<BooleanRequest>) => void) | null;
  expect(handle).toBeTypeOf('function');
  handle?.({ data: request } as MessageEvent<BooleanRequest>);

  return replies;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the boolean worker', () => {
  it('cuts the same shape the editor would have cut in place', async () => {
    const target = createBox(2);
    const tool = createUVSphere(0.8, 16, 8);
    const toolTransform = { ...createTransform(), position: { x: 1, y: 0, z: 0 } };

    const replies = await ask({
      op: 'union',
      target: serializeMesh(target),
      tool: serializeMesh(tool),
      targetTransform: createTransform(),
      toolTransform,
      slots: [0],
    });

    const done = replies.at(-1);
    expect(done?.type).toBe('done');
    expect(replies.slice(0, -1).every((reply) => reply.type === 'progress')).toBe(true);

    const crossed = deserializeMesh(
      (done as { type: 'done'; mesh: ReturnType<typeof serializeMesh> }).mesh,
    );
    const here = booleanMesh('union', createBox(2), createUVSphere(0.8, 16, 8), (point) => ({
      x: point.x + 1,
      y: point.y,
      z: point.z,
    }));

    expect(crossed.faces.size).toBe(here.faces.size);
    expect(crossed.verts.size).toBe(here.verts.size);
    expect(crossed.edges.size).toBe(here.edges.size);
  });

  it('reports a cut that threw rather than going silent', async () => {
    const replies = await ask({
      op: 'union',
      // A ring that names the same vertex three times: the mesh refuses it.
      target: { ...serializeMesh(createBox(2)), faces: [[0, 0, 0]] },
      tool: serializeMesh(createBox(1)),
      targetTransform: createTransform(),
      toolTransform: createTransform(),
      slots: [0],
    });

    // However far it got first, what comes back is a failure and never a mesh.
    expect(replies.at(-1)?.type).toBe('failed');
    expect(replies.some((reply) => reply.type === 'done')).toBe(false);
  });
});
