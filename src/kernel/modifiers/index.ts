import { type Axis, add, mul, sub, vec3 } from '../math';
import { BMesh, cloneMesh } from '../mesh';
import type { Vert } from '../mesh/types';
import { mergeByDistance } from '../ops/merge';
import { subdivideFaces } from '../ops/subdivide';

import type {
  ArrayModifier,
  MirrorModifier,
  Modifier,
  SolidifyModifier,
  SubdivideModifier,
  WeldModifier,
} from './types';

export * from './types';

/**
 * Runs the modifier stack and returns the display mesh.
 *
 * Modifiers are non-destructive: the base mesh is cloned once and each enabled
 * modifier rewrites the clone in order, so the object the user edits is never
 * touched.
 */
export function evaluateModifiers(mesh: BMesh, modifiers: readonly Modifier[]): BMesh {
  const enabled = modifiers.filter((modifier) => modifier.enabled);
  if (enabled.length === 0) return mesh;

  let result = cloneMesh(mesh);
  for (const modifier of enabled) result = applyModifier(result, modifier);
  return result;
}

/** Bakes a single modifier into a mesh, used both by the stack and by Apply. */
export function applyModifier(mesh: BMesh, modifier: Modifier): BMesh {
  switch (modifier.type) {
    case 'mirror':
      return applyMirror(mesh, modifier);
    case 'array':
      return applyArray(mesh, modifier);
    case 'solidify':
      return applySolidify(mesh, modifier);
    case 'weld':
      return applyWeld(mesh, modifier);
    case 'subdivide':
      return applySubdivide(mesh, modifier);
  }
}

function applyMirror(mesh: BMesh, modifier: MirrorModifier): BMesh {
  const axes: Axis[] = [];
  if (modifier.axes.x) axes.push('x');
  if (modifier.axes.y) axes.push('y');
  if (modifier.axes.z) axes.push('z');
  if (axes.length === 0) return mesh;

  for (const axis of axes) {
    if (modifier.bisect) discardNegativeHalf(mesh, axis);
    if (modifier.clipping) {
      for (const vert of mesh.verts.values()) {
        if (Math.abs(vert.co[axis]) < modifier.mergeThreshold) vert.co = { ...vert.co, [axis]: 0 };
      }
    }

    const originals = [...mesh.verts.values()];
    const originalFaces = [...mesh.faces.values()];
    const reflection = new Map<number, Vert>();

    for (const vert of originals) {
      reflection.set(vert.id, mesh.addVert({ ...vert.co, [axis]: -vert.co[axis] }));
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

    if (modifier.merge) {
      mergeByDistance(mesh, [...mesh.verts.values()], modifier.mergeThreshold);
    }
  }

  mesh.computeNormals();
  return mesh;
}

function discardNegativeHalf(mesh: BMesh, axis: Axis): void {
  const doomed = [...mesh.faces.values()].filter((face) => mesh.faceCenter(face)[axis] < 0);
  for (const face of doomed) mesh.removeFace(face);
  mesh.removeWireEdges();
  mesh.removeLooseVerts();
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

