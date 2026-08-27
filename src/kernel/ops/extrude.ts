import { type Vec3, add, mul, normalize } from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, Vert } from '../mesh/types';

import { averageNormal, detachRegion } from './region';

export interface ExtrudeFacesOptions {
  offset?: number;
  /** Explicit direction; defaults to the averaged region normal. */
  direction?: Vec3;
  /** Extrude each face on its own normal instead of as one connected region. */
  individual?: boolean;
  /** Offset every vertex along its own normal rather than one shared direction. */
  alongNormals?: boolean;
}

export interface ExtrudeResult {
  faces: Face[];
  newVerts: Vert[];
}

/**
 * Region extrude. The selected faces are lifted onto duplicated verts and the
 * gap left behind is walled in, which is what makes the result watertight.
 */
export function extrudeFaces(
  mesh: BMesh,
  faces: readonly Face[],
  options: ExtrudeFacesOptions = {},
): ExtrudeResult {
  if (faces.length === 0) return { faces: [], newVerts: [] };

  const offset = options.offset ?? 0;

  if (options.individual) {
    const resultFaces: Face[] = [];
    const resultVerts: Vert[] = [];
    for (const face of faces) {
      const direction = mul(face.normal, offset);
      const result = detachRegion(mesh, [face], () => direction);
      resultFaces.push(...result.faces);
      resultVerts.push(...result.newVerts);
    }
    mesh.computeNormals();
    return { faces: resultFaces, newVerts: resultVerts };
  }

  mesh.computeNormals();
  const direction = options.direction ? normalize(options.direction) : averageNormal(faces);

  const result = detachRegion(mesh, faces, (vert) =>
    options.alongNormals ? mul(vert.normal, offset) : mul(direction, offset),
  );

  mesh.computeNormals();
  return { faces: result.faces, newVerts: result.newVerts };
}

/**
 * Extrudes edges into quads. Used for boundary edges and wire edges, where a
 * face region extrude has nothing to detach.
 */
export function extrudeEdges(
  mesh: BMesh,
  edges: readonly Edge[],
  translation: Vec3,
): ExtrudeResult {
  if (edges.length === 0) return { faces: [], newVerts: [] };

  const vertMap = new Map<number, Vert>();
  const newVerts: Vert[] = [];
  const ensure = (vert: Vert): Vert => {
    const existing = vertMap.get(vert.id);
    if (existing) return existing;
    const duplicate = mesh.addVert(add(vert.co, translation));
    duplicate.selected = true;
    vertMap.set(vert.id, duplicate);
    newVerts.push(duplicate);
    return duplicate;
  };

  const faces: Face[] = [];
  for (const edge of edges) {
    const a = ensure(edge.v0);
    const b = ensure(edge.v1);
    // Wind the quad against the existing face so normals stay consistent.
    const reference = edge.loops[0];
    const flip = reference !== undefined && reference.vert === edge.v0;
    const ring = flip ? [edge.v1, edge.v0, a, b] : [edge.v0, edge.v1, b, a];
    faces.push(mesh.addFace(ring));
  }

  mesh.computeNormals();
  return { faces, newVerts };
}

/** Moves selected geometry along each vertex normal — Blender's shrink/fatten. */
export function shrinkFatten(mesh: BMesh, verts: readonly Vert[], distance: number): void {
  mesh.computeNormals();
  for (const vert of verts) {
    vert.co = add(vert.co, mul(vert.normal, distance));
  }
  mesh.computeNormals();
}
