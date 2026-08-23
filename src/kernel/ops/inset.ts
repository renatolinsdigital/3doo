import { type Vec3, add, mul } from '../math';
import type { BMesh } from '../mesh';
import type { Face, Vert } from '../mesh/types';

import { analyseRegion, averageNormal, detachRegion, loopInwardDirection, miterOffset } from './region';

export interface InsetOptions {
  thickness?: number;
  depth?: number;
  /** Inset each face separately instead of insetting the region outline. */
  individual?: boolean;
}

export interface InsetResult {
  /** The shrunk inner faces — what stays selected, matching Blender. */
  faces: Face[];
  /** The border ring generated between the original outline and the inner faces. */
  borderFaces: Face[];
}

/**
 * Inset is topologically identical to an extrude: detach the region, wall the
 * gap. Only the placement differs — verts slide inward within their own face
 * plane instead of along the normal.
 */
export function insetFaces(
  mesh: BMesh,
  faces: readonly Face[],
  options: InsetOptions = {},
): InsetResult {
  if (faces.length === 0) return { faces: [], borderFaces: [] };

  const thickness = options.thickness ?? 0.1;
  const depth = options.depth ?? 0;

  if (options.individual) {
    const inner: Face[] = [];
    const border: Face[] = [];
    for (const face of faces) {
      const result = insetRegion(mesh, [face], thickness, depth);
      inner.push(...result.faces);
      border.push(...result.borderFaces);
    }
    return { faces: inner, borderFaces: border };
  }

  return insetRegion(mesh, faces, thickness, depth);
}

function insetRegion(
  mesh: BMesh,
  faces: readonly Face[],
  thickness: number,
  depth: number,
): InsetResult {
  mesh.computeNormals();
  const shell = analyseRegion(mesh, faces);
  const normal = averageNormal(faces);

  const inwardByVert = new Map<number, Vec3[]>();
  for (const loop of shell.boundaryLoops) {
    const inward = loopInwardDirection(loop);
    for (const vert of [loop.vert, loop.next.vert]) {
      const list = inwardByVert.get(vert.id);
      if (list) list.push(inward);
      else inwardByVert.set(vert.id, [inward]);
    }
  }

  const offsetFor = (vert: Vert): Vec3 => {
    const directions = inwardByVert.get(vert.id);
    const lift = mul(normal, depth);
    if (!directions || directions.length === 0) return lift;
    if (directions.length === 1) return add(mul(directions[0], thickness), lift);
    return add(miterOffset(directions[0], directions[1], thickness), lift);
  };

  const result = detachRegion(mesh, faces, offsetFor);
  mesh.computeNormals();
  return { faces: result.faces, borderFaces: result.wallFaces };
}
