/// <reference lib="webworker" />
import type { Transform } from '@kernel/index';
import { composeMatrix, inverseTransformPoint, transformPoint } from '@kernel/math';
import { type MeshData, deserializeMesh, serializeMesh } from '@kernel/mesh/serialize';
import { type BooleanOp, booleanMeshStaged } from '@kernel/ops/boolean';

/** What the main thread hands over: two meshes, where they sit, and the op. */
export interface BooleanRequest {
  op: BooleanOp;
  target: MeshData;
  tool: MeshData;
  targetTransform: Transform;
  toolTransform: Transform;
  /** Material slot of the target for each of the tool's own slots. */
  slots: number[];
}

export type BooleanReply =
  | { type: 'progress'; value: number }
  | { type: 'done'; mesh: MeshData }
  | { type: 'failed'; reason: string };

/**
 * Runs one boolean and reports its stages, off the main thread.
 *
 * The cut itself is the same generator the editor drives in place; all this
 * adds is the crossing. Meshes travel as the flat arrays `serializeMesh`
 * writes, because a BMesh is a cycle of loops pointing at each other and
 * nothing structured-cloneable.
 */
function run(request: BooleanRequest): MeshData {
  const target = deserializeMesh(request.target);
  const tool = deserializeMesh(request.tool);
  const matrix = composeMatrix(request.toolTransform);

  const steps = booleanMeshStaged(
    request.op,
    target,
    tool,
    (point) => inverseTransformPoint(request.targetTransform, transformPoint(matrix, point)),
    (face) => request.slots[face.materialIndex] ?? 0,
  );

  let step = steps.next();
  while (!step.done) {
    const reply: BooleanReply = { type: 'progress', value: step.value };
    self.postMessage(reply);
    step = steps.next();
  }

  return serializeMesh(step.value);
}

self.onmessage = (event: MessageEvent<BooleanRequest>) => {
  try {
    const reply: BooleanReply = { type: 'done', mesh: run(event.data) };
    self.postMessage(reply);
  } catch (error) {
    const reply: BooleanReply = {
      type: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(reply);
  }
};
