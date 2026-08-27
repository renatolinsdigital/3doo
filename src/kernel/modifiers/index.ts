import { type Axis, type Vec3, add, lerp, mul, sub, vec3 } from '../math';
import { BMesh, cloneMesh } from '../mesh';
import type { Face, Vert } from '../mesh/types';
import { mergeByDistance, weldVerts } from '../ops/merge';
import { subdivideFaces } from '../ops/subdivide';
import { remeshMesh } from '../remesh';

import type {
  ArrayModifier,
  MirrorModifier,
  Modifier,
  RemeshModifier,
  SolidifyModifier,
  SubdivideModifier,
  WeldModifier,
} from './types';

export * from './types';

/**
 * Scene state a modifier may measure from, expressed in the object's own local
 * space so the kernel never has to know about world transforms.
 */
export interface ModifierContext {
  /** The 3D cursor, in object-local coordinates. */
  cursor?: Vec3;
}

/**
 * Runs the modifier stack and returns the display mesh.
 *
 * Modifiers are non-destructive: the base mesh is cloned once and each enabled
 * modifier rewrites the clone in order, so the object the user edits is never
 * touched.
 */
export function evaluateModifiers(
  mesh: BMesh,
  modifiers: readonly Modifier[],
  context: ModifierContext = {},
): BMesh {
  const enabled = modifiers.filter((modifier) => modifier.enabled);
  if (enabled.length === 0) return mesh;

  let result = cloneMesh(mesh);
  for (const modifier of enabled) result = applyModifier(result, modifier, context);
  return result;
}

/** Bakes a single modifier into a mesh, used both by the stack and by Apply. */
export function applyModifier(
  mesh: BMesh,
  modifier: Modifier,
  context: ModifierContext = {},
): BMesh {
  switch (modifier.type) {
    case 'mirror':
      return applyMirror(mesh, modifier, context);
    case 'array':
      return applyArray(mesh, modifier);
    case 'solidify':
      return applySolidify(mesh, modifier);
    case 'weld':
      return applyWeld(mesh, modifier);
    case 'subdivide':
      return applySubdivide(mesh, modifier);
    case 'remesh':
      return applyRemesh(mesh, modifier);
  }
}

function applyMirror(mesh: BMesh, modifier: MirrorModifier, context: ModifierContext): BMesh {
  const axes: Axis[] = [];
  if (modifier.axes.x) axes.push('x');
  if (modifier.axes.y) axes.push('y');
  if (modifier.axes.z) axes.push('z');
  if (axes.length === 0) return mesh;

  const threshold = Math.max(0, modifier.mergeThreshold);
  // The plane passes through the object's own origin unless the modifier is set
  // to follow the 3D cursor, which arrives already converted to local space.
  const plane: Vec3 = modifier.origin === 'cursor' && context.cursor ? context.cursor : vec3();

  for (const axis of axes) {
    const at = plane[axis];
    if (modifier.bisect) bisectHalf(mesh, axis, at, threshold);
    if (modifier.clipping) {
      for (const vert of mesh.verts.values()) {
        if (Math.abs(vert.co[axis] - at) < threshold) vert.co = { ...vert.co, [axis]: at };
      }
    }

    const originals = [...mesh.verts.values()];
    const originalFaces = [...mesh.faces.values()];
    const originalWires = [...mesh.edges.values()]
      .filter((edge) => edge.loops.length === 0)
      .map((edge) => [edge.v0, edge.v1] as const);
    const reflection = new Map<number, Vert>();

    for (const vert of originals) {
      reflection.set(vert.id, mesh.addVert({ ...vert.co, [axis]: 2 * at - vert.co[axis] }));
    }

    for (const face of originalFaces) {
      // Reflection inverts handedness, so the copy has to be wound backwards.
      const ring = mesh
        .faceVerts(face)
        .map((vert) => reflection.get(vert.id) ?? vert)
        .reverse();
      if (new Set(ring.map((vert) => vert.id)).size < 3) continue;
      mesh.addFace(ring, { materialIndex: face.materialIndex, smooth: face.smooth });
    }

    // Wire edges carry no loop for the face pass above to copy, so the mirrored
    // half of edge-only geometry has to be rebuilt by hand.
    for (const [v0, v1] of originalWires) {
      const from = reflection.get(v0.id);
      const to = reflection.get(v1.id);
      if (from && to && from !== to) mesh.addEdge(from, to);
    }

    if (modifier.merge) {
      // The merge limit is a distance from the mirror plane, not a general
      // weld: only a vertex sitting on the seam absorbs its own reflection, so
      // geometry that happens to be dense elsewhere is left intact.
      const seam = new Map<number, Vert>();
      for (const vert of originals) {
        if (Math.abs(vert.co[axis] - at) > threshold) continue;
        const image = reflection.get(vert.id);
        if (image && image !== vert) seam.set(image.id, vert);
      }
      weldVerts(mesh, seam);
    }
  }

  mesh.computeNormals();
  return mesh;
}

/**
 * Cuts the mesh at the mirror plane and keeps the positive half.
 *
 * Faces that straddle the plane are split rather than kept or dropped whole,
 * otherwise the reflection lands back on top of the uncut half and the result
 * is doubled geometry with opposing winding.
 *
 * `at` is where the plane crosses `axis`, which is the object origin unless the
 * modifier is following the 3D cursor.
 */
function bisectHalf(mesh: BMesh, axis: Axis, at: number, threshold: number): void {
  const epsilon = Math.max(threshold, 1e-9);
  const signedDistance = (vert: Vert): number => vert.co[axis] - at;
  const sideOf = (vert: Vert): number => {
    const distance = signedDistance(vert);
    return distance > epsilon ? 1 : distance < -epsilon ? -1 : 0;
  };

  // Wires and isolated points that predate the cut are the caller's geometry;
  // the sweep at the end is only for what this cut orphans.
  const keptWires = new Set<number>();
  for (const edge of mesh.edges.values()) if (edge.loops.length === 0) keptWires.add(edge.id);
  const keptLoose = new Set<number>();
  for (const vert of mesh.verts.values()) if (vert.edges.length === 0) keptLoose.add(vert.id);

  // Cached per edge so both faces sharing it land on the same split vertex and
  // the cut seam stays welded.
  const splits = new Map<number, Vert>();
  const splitOn = (a: Vert, b: Vert): Vert => {
    const edge = mesh.findEdge(a, b);
    const cached = edge ? splits.get(edge.id) : undefined;
    if (cached) return cached;
    const t = signedDistance(a) / (signedDistance(a) - signedDistance(b));
    const vert = mesh.addVert({ ...lerp(a.co, b.co, t), [axis]: at });
    if (edge) splits.set(edge.id, vert);
    return vert;
  };

  const doomed: Face[] = [];
  const rebuilt: { ring: Vert[]; materialIndex: number; smooth: boolean }[] = [];

  for (const face of mesh.faces.values()) {
    const ring = mesh.faceVerts(face);
    const sides = ring.map(sideOf);
    if (sides.every((side) => side >= 0)) continue;
    doomed.push(face);
    if (sides.every((side) => side <= 0)) continue;

    const clipped: Vert[] = [];
    const push = (vert: Vert) => {
      if (clipped[clipped.length - 1] !== vert) clipped.push(vert);
    };
    for (let i = 0; i < ring.length; i++) {
      const next = (i + 1) % ring.length;
      if (sides[i] >= 0) push(ring[i]);
      if (sides[i] * sides[next] < 0) push(splitOn(ring[i], ring[next]));
    }
    while (clipped.length > 1 && clipped[0] === clipped[clipped.length - 1]) clipped.pop();
    if (clipped.length < 3) continue;
    rebuilt.push({ ring: clipped, materialIndex: face.materialIndex, smooth: face.smooth });
  }

  for (const face of doomed) mesh.removeFace(face);
  for (const spec of rebuilt) {
    mesh.addFace(spec.ring, { materialIndex: spec.materialIndex, smooth: spec.smooth });
  }

  for (const edge of [...mesh.edges.values()]) {
    if (edge.loops.length > 0) continue;
    const side0 = sideOf(edge.v0);
    if (side0 * sideOf(edge.v1) >= 0) continue;
    const split = splitOn(edge.v0, edge.v1);
    keptWires.add(mesh.addEdge(side0 > 0 ? edge.v0 : edge.v1, split).id);
  }

  for (const vert of [...mesh.verts.values()]) {
    if (sideOf(vert) < 0) mesh.removeVert(vert);
  }
  mesh.removeWireEdges(keptWires);
  mesh.removeLooseVerts(keptLoose);
}

function applyArray(mesh: BMesh, modifier: ArrayModifier): BMesh {
  const count = Math.max(1, Math.floor(modifier.count));
  if (count === 1) return mesh;

  const box = mesh.boundingBox();
  const size = sub(box.max, box.min);

  const step = vec3();
  if (modifier.useRelative) {
    step.x += size.x * modifier.relativeOffset.x;
    step.y += size.y * modifier.relativeOffset.y;
    step.z += size.z * modifier.relativeOffset.z;
  }
  if (modifier.useConstant) {
    step.x += modifier.constantOffset.x;
    step.y += modifier.constantOffset.y;
    step.z += modifier.constantOffset.z;
  }

  const originals = [...mesh.verts.values()];
  const originalFaces = [...mesh.faces.values()].map((face) => ({
    ring: mesh.faceVerts(face),
    materialIndex: face.materialIndex,
    smooth: face.smooth,
  }));
  const originalWires = [...mesh.edges.values()]
    .filter((edge) => edge.loops.length === 0)
    .map((edge) => [edge.v0, edge.v1] as const);

  for (let copy = 1; copy < count; copy++) {
    const offset = mul(step, copy);
    const clones = new Map<number, Vert>();
    for (const vert of originals) clones.set(vert.id, mesh.addVert(add(vert.co, offset)));

    for (const spec of originalFaces) {
      const ring = spec.ring.map((vert) => clones.get(vert.id) ?? vert);
      mesh.addFace(ring, { materialIndex: spec.materialIndex, smooth: spec.smooth });
    }
    for (const [a, b] of originalWires) {
      const from = clones.get(a.id);
      const to = clones.get(b.id);
      if (from && to) mesh.addEdge(from, to);
    }
  }

  if (modifier.merge) {
    mergeByDistance(mesh, [...mesh.verts.values()], modifier.mergeThreshold);
  }

  mesh.computeNormals();
  return mesh;
}

function applySolidify(mesh: BMesh, modifier: SolidifyModifier): BMesh {
  if (Math.abs(modifier.thickness) < 1e-9) return mesh;
  mesh.computeNormals();

  const inner = modifier.evenOffset ? modifier.thickness / 2 : modifier.thickness;
  const outer = modifier.evenOffset ? -modifier.thickness / 2 : 0;

  const originals = [...mesh.verts.values()];
  const originalFaces = [...mesh.faces.values()].map((face) => ({
    ring: mesh.faceVerts(face),
    materialIndex: face.materialIndex,
    smooth: face.smooth,
  }));
  // Captured before the shell is added, since new faces change what is a rim.
  const rimLoops = [...mesh.edges.values()]
    .filter((edge) => edge.loops.length === 1)
    .map((edge) => edge.loops[0]);

  const shell = new Map<number, Vert>();
  for (const vert of originals) {
    shell.set(vert.id, mesh.addVert(add(vert.co, mul(vert.normal, -inner))));
    if (outer !== 0) vert.co = add(vert.co, mul(vert.normal, -outer));
  }

  for (const spec of originalFaces) {
    // The inner shell faces the other way, so its winding is reversed.
    const ring = spec.ring.map((vert) => shell.get(vert.id) ?? vert).reverse();
    mesh.addFace(ring, { materialIndex: spec.materialIndex, smooth: spec.smooth });
  }

  if (modifier.rimFill) {
    for (const loop of rimLoops) {
      const a = loop.vert;
      const b = loop.next.vert;
      const innerA = shell.get(a.id);
      const innerB = shell.get(b.id);
      if (!innerA || !innerB) continue;
      mesh.addFace([b, a, innerA, innerB], {
        materialIndex: loop.face.materialIndex,
        smooth: loop.face.smooth,
      });
    }
  }

  mesh.computeNormals();
  return mesh;
}

/**
 * Merge by distance over the whole mesh — a modifier has no selection to work
 * from, so every vertex is a candidate.
 *
 * This is the cleanup pass for seams the rest of the stack leaves behind: an
 * array whose copies touch, a mirror with merge off, an OBJ that split its
 * vertices per face.
 */
function applyWeld(mesh: BMesh, modifier: WeldModifier): BMesh {
  mergeByDistance(mesh, [...mesh.verts.values()], modifier.threshold);
  return mesh;
}

function applySubdivide(mesh: BMesh, modifier: SubdivideModifier): BMesh {
  const levels = Math.max(0, Math.min(3, Math.floor(modifier.levels)));
  if (levels === 0) return mesh;
  subdivideFaces(mesh, [...mesh.faces.values()], { cuts: levels, smooth: modifier.smooth });
  return mesh;
}

/**
 * Rebuilds the topology, or leaves the mesh exactly as it was.
 *
 * The remesher refuses some inputs outright — a mesh with no faces, a reduce
 * target that collapses everything — and the rest of the stack has no way to
 * answer a thrown error. This runs while the viewport is drawing, so a throw
 * here is a blank screen rather than a message; a settings combination that
 * cannot be built is one the modifier simply does not apply, and the mesh comes
 * through untouched for the user to see and adjust.
 */
function applyRemesh(mesh: BMesh, modifier: RemeshModifier): BMesh {
  if (mesh.faces.size === 0) return mesh;
  try {
    return remeshMesh(mesh, modifier).mesh;
  } catch {
    return mesh;
  }
}
