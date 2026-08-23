import { type Vec3, add, cross, dot, mul, normalize, sub, vec3 } from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, Loop, Vert } from '../mesh/types';

export interface RegionShell {
  /** One loop per boundary edge, always belonging to a face inside the region. */
  boundaryLoops: Loop[];
  /** Verts that must be duplicated so the region can detach from its surroundings. */
  detachedVerts: Vert[];
  /** Every edge the region owned before the operation, for wire cleanup afterwards. */
  regionEdges: Edge[];
}

export interface RegionResult {
  /** The region faces, rebuilt on the duplicated verts. */
  faces: Face[];
  /** The side walls generated along the region boundary. */
  wallFaces: Face[];
  newVerts: Vert[];
  vertMap: Map<number, Vert>;
}

/**
 * Analyses a face region: which of its edges sit on the boundary and which of
 * its verts have to be duplicated for the region to be lifted off the surface.
 */
export function analyseRegion(mesh: BMesh, faces: readonly Face[]): RegionShell {
  const regionIds = new Set(faces.map((face) => face.id));
  const boundaryLoops: Loop[] = [];
  const regionEdges = new Map<number, Edge>();
  const detached = new Map<number, Vert>();

  for (const face of faces) {
    for (const loop of mesh.faceLoops(face)) {
      regionEdges.set(loop.edge.id, loop.edge);
      const insideCount = mesh
        .edgeFaces(loop.edge)
        .filter((adjacent) => regionIds.has(adjacent.id)).length;
      if (insideCount === 1) {
        boundaryLoops.push(loop);
        detached.set(loop.vert.id, loop.vert);
        detached.set(loop.next.vert.id, loop.next.vert);
      }
    }
  }

  for (const face of faces) {
    for (const vert of mesh.faceVerts(face)) {
      const touchesOutside = mesh.vertFaces(vert).some((adjacent) => !regionIds.has(adjacent.id));
      if (touchesOutside) detached.set(vert.id, vert);
    }
  }

  return {
    boundaryLoops,
    detachedVerts: [...detached.values()],
    regionEdges: [...regionEdges.values()],
  };
}

/**
 * Detaches a face region from the surrounding mesh and stitches walls along the
 * boundary. `offsetFor` positions each duplicated vertex.
 *
 * Extrude and region inset are the same topological edit — only the placement
 * rule differs — so both go through here.
 */
export function detachRegion(
  mesh: BMesh,
  faces: readonly Face[],
  offsetFor: (vert: Vert) => Vec3,
): RegionResult {
  const shell = analyseRegion(mesh, faces);
  const vertMap = new Map<number, Vert>();
  const newVerts: Vert[] = [];

  for (const vert of shell.detachedVerts) {
    const duplicate = mesh.addVert(add(vert.co, offsetFor(vert)));
    duplicate.selected = vert.selected;
    vertMap.set(vert.id, duplicate);
    newVerts.push(duplicate);
  }

  const rebuilt = faces.map((face) => ({
    ring: mesh.faceVerts(face).map((vert) => vertMap.get(vert.id) ?? vert),
    materialIndex: face.materialIndex,
    smooth: face.smooth,
  }));

  const walls = shell.boundaryLoops.map((loop) => ({
    ring: [
      loop.vert,
      loop.next.vert,
      vertMap.get(loop.next.vert.id) ?? loop.next.vert,
      vertMap.get(loop.vert.id) ?? loop.vert,
    ],
    materialIndex: loop.face.materialIndex,
    smooth: loop.face.smooth,
  }));

  for (const face of faces) mesh.removeFace(face);

  const regionFaces = rebuilt.map((spec) =>
    mesh.addFace(spec.ring, { materialIndex: spec.materialIndex, smooth: spec.smooth }),
  );

  const wallFaces: Face[] = [];
  for (const spec of walls) {
    const unique = new Set(spec.ring.map((vert) => vert.id));
    if (unique.size < 3) continue;
    wallFaces.push(
      mesh.addFace(spec.ring, { materialIndex: spec.materialIndex, smooth: spec.smooth }),
    );
  }

  // Interior edges of the old region are orphaned once the region moves onto
  // duplicated verts; dropping them keeps the result free of wire leftovers.
  for (const edge of shell.regionEdges) {
    if (mesh.edges.has(edge.id) && edge.loops.length === 0) mesh.removeEdge(edge);
  }
  mesh.removeLooseVerts();

  return { faces: regionFaces, wallFaces, newVerts, vertMap };
}

/** Unit vector pointing into `face` from the edge that `loop` sits on. */
export function loopInwardDirection(loop: Loop): Vec3 {
  const direction = normalize(sub(loop.next.vert.co, loop.vert.co));
  return normalize(cross(loop.face.normal, direction));
}

/**
 * Miter offset for a corner between two inward directions. Scaling by
 * 1 / cos(half-angle) keeps both offset edges exactly `width` from the original.
 */
export function miterOffset(inwardA: Vec3, inwardB: Vec3, width: number): Vec3 {
  const bisector = normalize(add(inwardA, inwardB));
  if (bisector.x === 0 && bisector.y === 0 && bisector.z === 0) return vec3();
  const cosHalf = dot(bisector, inwardA);
  const scale = width / Math.max(cosHalf, 0.2);
  return mul(bisector, scale);
}

export function averageNormal(faces: readonly Face[]): Vec3 {
  let sum = vec3();
  for (const face of faces) sum = add(sum, face.normal);
  const normalized = normalize(sum);
  return normalized.x === 0 && normalized.y === 0 && normalized.z === 0 ? vec3(0, 1, 0) : normalized;
}
