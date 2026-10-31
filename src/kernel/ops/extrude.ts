import { type Vec3, add, clamp, dot, length, mul, normalize, sub, vec3 } from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, Vert } from '../mesh/types';

import { averageNormal, detachRegion } from './region';

export interface ExtrudeFacesOptions {
  offset?: number;
  /** Explicit direction; defaults to the averaged region normal. */
  direction?: Vec3;
  /** Extrude each face on its own normal instead of as one connected region. */
  individual?: boolean;
  /**
   * Push each face out along its own normal rather than all of them one shared
   * way, keeping the region joined.
   */
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
  const alongNormals = options.alongNormals ? regionNormalOffsets(mesh, faces, offset) : null;

  const result = detachRegion(mesh, faces, (vert) =>
    alongNormals ? (alongNormals.get(vert.id) ?? vec3()) : mul(direction, offset),
  );

  mesh.computeNormals();
  return { faces: result.faces, newVerts: result.newVerts };
}

/**
 * Where each vertex of a region goes for every one of its faces to end up
 * `offset` out along its own normal.
 *
 * Only the region's faces have a say. A face outside it is staying where it
 * is, and leaning on it flared the extruded corners out sideways. Each face
 * counts by its corner angle, so a face cut into triangles pulls no harder than
 * the quad beside it. Where faces meet at an angle the vertex travels further
 * than the offset, √2 times it at a right angle, which is what brings both
 * faces out the full distance rather than rounding the edge between them.
 */
function regionNormalOffsets(
  mesh: BMesh,
  faces: readonly Face[],
  offset: number,
): Map<number, Vec3> {
  const corners = new Map<number, { normal: Vec3; angle: number }[]>();
  for (const face of faces) {
    for (const loop of mesh.faceLoops(face)) {
      const toPrev = normalize(sub(loop.prev.vert.co, loop.vert.co));
      const toNext = normalize(sub(loop.next.vert.co, loop.vert.co));
      const angle = Math.acos(clamp(dot(toPrev, toNext), -1, 1));
      const list = corners.get(loop.vert.id) ?? [];
      list.push({ normal: face.normal, angle });
      corners.set(loop.vert.id, list);
    }
  }

  const offsets = new Map<number, Vec3>();
  for (const [id, list] of corners) {
    let sum = vec3();
    let weight = 0;
    for (const corner of list) {
      sum = add(sum, mul(corner.normal, corner.angle));
      weight += corner.angle;
    }
    // Faces folded back onto each other point both ways at once, with no
    // outward between them, so the vertex is left where it is.
    const normal = normalize(sum);
    if (length(normal) === 0) continue;

    // Floored like a miter: a near fold would otherwise fling the vertex out.
    let stretch = 0;
    for (const corner of list) {
      stretch += corner.angle / Math.max(dot(normal, corner.normal), 0.2);
    }
    offsets.set(id, mul(normal, (offset * stretch) / weight));
  }
  return offsets;
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

/** Moves selected geometry along each vertex normal, Blender's shrink/fatten. */
export function shrinkFatten(mesh: BMesh, verts: readonly Vert[], distance: number): void {
  mesh.computeNormals();
  for (const vert of verts) {
    vert.co = add(vert.co, mul(vert.normal, distance));
  }
  mesh.computeNormals();
}
