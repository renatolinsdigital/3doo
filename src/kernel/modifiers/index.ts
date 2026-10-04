import {
  AXES,
  type Axis,
  type Vec3,
  add,
  clamp,
  cross,
  degToRad,
  dot,
  lerp,
  mul,
  polygonNormal,
  sub,
  vec3,
} from '../math';
import { BMesh, cloneMesh, triangulatePolygon } from '../mesh';
import type { Edge, Face, Loop, Vert } from '../mesh/types';
import { mergeByDistance, weldVerts } from '../ops/merge';
import { MESH_BUDGET } from '../ops/budget';
import { carrySharp } from '../ops/normals';
import { catmullClark, subdivideFaces } from '../ops/subdivide';
import { remeshMesh } from '../remesh';

import type {
  ArrayModifier,
  BendModifier,
  MirrorModifier,
  Modifier,
  RemeshModifier,
  SolidifyModifier,
  SubdivideModifier,
  SubsurfModifier,
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
    case 'bend':
      return applyBend(mesh, modifier, context);
    case 'weld':
      return applyWeld(mesh, modifier);
    case 'subdivide':
      return applySubdivide(mesh, modifier);
    case 'subsurf':
      return applySubsurf(mesh, modifier);
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
    const originalSharp = sharpEnds(mesh);
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
    copySharp(mesh, originalSharp, reflection);

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

/** Both ends of every sharp edge, read before a modifier adds its copies. */
function sharpEnds(mesh: BMesh): (readonly [Vert, Vert])[] {
  const ends: (readonly [Vert, Vert])[] = [];
  for (const edge of mesh.edges.values()) if (edge.sharp) ends.push([edge.v0, edge.v1]);
  return ends;
}

/**
 * Marks sharp the copy of every sharp edge, through the map from a vertex to
 * its copy.
 *
 * A copy is built a face at a time, and the edges a face brings with it start
 * out smooth, so a crease on the original would be missing from every copy a
 * mirror, an array or a solidify shell makes of it.
 */
function copySharp(
  mesh: BMesh,
  sharp: readonly (readonly [Vert, Vert])[],
  copies: ReadonlyMap<number, Vert>,
): void {
  for (const [v0, v1] of sharp) {
    const a = copies.get(v0.id);
    const b = copies.get(v1.id);
    const edge = a && b && a !== b ? mesh.findEdge(a, b) : null;
    if (edge) edge.sharp = true;
  }
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
  const sharpSplits: [Edge, Vert][] = [];
  const splitOn = (a: Vert, b: Vert): Vert => {
    const edge = mesh.findEdge(a, b);
    const cached = edge ? splits.get(edge.id) : undefined;
    if (cached) return cached;
    const t = signedDistance(a) / (signedDistance(a) - signedDistance(b));
    const vert = mesh.addVert({ ...lerp(a.co, b.co, t), [axis]: at });
    if (edge) splits.set(edge.id, vert);
    if (edge?.sharp) sharpSplits.push([edge, vert]);
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

  // Both halves are marked, and the one on the far side goes with its vertex.
  for (const [edge, split] of sharpSplits) carrySharp(mesh, edge, [edge.v0, split, edge.v1]);

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
  const originalSharp = sharpEnds(mesh);

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
    copySharp(mesh, originalSharp, clones);
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
  const originalSharp = sharpEnds(mesh);

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
  copySharp(mesh, originalSharp, shell);

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

export const MAX_BEND_ANGLE = 360;
export const MAX_BEND_SEGMENTS = 128;

/**
 * The two sides square to each bend axis: the first curls when the two are
 * equally long. Y comes second wherever it is a choice, so a cube or a square
 * plane on the floor curls up like a sheet of paper rather than across itself.
 */
const SQUARE_TO: Record<Axis, readonly [Axis, Axis]> = {
  x: ['z', 'y'],
  y: ['x', 'z'],
  z: ['x', 'y'],
};

function applyBend(mesh: BMesh, modifier: BendModifier, context: ModifierContext): BMesh {
  const centre: Vec3 = modifier.origin === 'cursor' && context.cursor ? context.cursor : vec3();
  const segments = clamp(Math.floor(modifier.segments), 1, MAX_BEND_SEGMENTS);
  let bent = false;
  for (const axis of AXES) {
    const degrees = clamp(modifier.angles[axis], -MAX_BEND_ANGLE, MAX_BEND_ANGLE);
    if (Math.abs(degrees) < 1e-6) continue;
    bent = bendAround(mesh, axis, degToRad(degrees), centre, segments) || bent;
  }
  if (bent) mesh.computeNormals();
  return mesh;
}

/**
 * Curls the mesh around one axis through `centre`, spreading `angle` over its
 * whole length along the side that curls. Returns whether anything moved.
 */
function bendAround(
  mesh: BMesh,
  axis: Axis,
  angle: number,
  centre: Vec3,
  segments: number,
): boolean {
  const box = mesh.boundingBox();
  const extent = (side: Axis) => box.max[side] - box.min[side];
  const [first, second] = SQUARE_TO[axis];
  const along = extent(second) > extent(first) * (1 + 1e-6) ? second : first;
  const toward = along === first ? second : first;
  const span = extent(along);
  if (span < 1e-9) return false;

  if (segments > 1) {
    const cuts: number[] = [];
    for (let i = 1; i < segments; i++) cuts.push(box.min[along] + (span * i) / segments);
    sliceAcross(mesh, along, cuts, (span / segments) * 1e-6);
  }

  // An arc of this radius turning through `angle` is exactly `span` long, so
  // the line through the centre keeps its length. What sits further toward the
  // inside of the curl is squeezed and what sits outside it stretched, the way
  // a bent bar is. The sign of the radius carries the sign of the angle.
  const radius = span / angle;
  for (const vert of mesh.verts.values()) {
    const turn = (vert.co[along] - centre[along]) / radius;
    const reach = radius - (vert.co[toward] - centre[toward]);
    vert.co = {
      ...vert.co,
      [along]: centre[along] + reach * Math.sin(turn),
      [toward]: centre[toward] + radius - reach * Math.cos(turn),
    };
  }
  return true;
}

interface Corner {
  vert: Vert;
  uv: Loop['uv'];
}

/**
 * Slices every face and wire edge that crosses a plane square to `axis` at one
 * of `cuts` (ascending), keeping both sides, so a face that was one flat piece
 * across a bend comes out as strips that can follow it.
 *
 * A convex face is clipped to each slab between neighbouring planes in turn. A
 * concave one is split into triangles first: clipped whole, the piece in a slab
 * the face runs in and out of more than once would join its parts across the
 * gap between them, which lies outside the face.
 *
 * Like the subdivision modifiers, a slicing that would outgrow the tab is
 * skipped rather than run. The bend still happens, on the vertices there are.
 */
function sliceAcross(mesh: BMesh, axis: Axis, cuts: readonly number[], epsilon: number): void {
  const level = (vert: Vert) => vert.co[axis];
  const cutsBetween = (a: number, b: number): number[] => {
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    return cuts.filter((cut) => cut > low + epsilon && cut < high - epsilon);
  };

  const crossing: Face[] = [];
  let growth = 0;
  for (const face of mesh.faces.values()) {
    let low = Infinity;
    let high = -Infinity;
    for (const vert of mesh.faceVerts(face)) {
      low = Math.min(low, level(vert));
      high = Math.max(high, level(vert));
    }
    const count = cutsBetween(low, high).length;
    if (count === 0) continue;
    crossing.push(face);
    growth += count;
  }
  if (mesh.faces.size + growth > MESH_BUDGET.faces) return;

  // Kept per pair of vertices, so the faces either side of an edge (and the
  // triangles either side of a diagonal) land on the same new vertices.
  const splits = new Map<string, Vert[]>();
  const between = (a: Vert, b: Vert): Vert[] => {
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    const key = `${low.id}:${high.id}`;
    let chain = splits.get(key);
    if (!chain) {
      const from = level(low);
      const to = level(high);
      const ordered = cutsBetween(from, to);
      if (from > to) ordered.reverse();
      chain = ordered.map((cut) =>
        mesh.addVert({ ...lerp(low.co, high.co, (cut - from) / (to - from)), [axis]: cut }),
      );
      splits.set(key, chain);
    }
    return low === a ? chain : [...chain].reverse();
  };

  const withSplits = (ring: readonly Corner[]): Corner[] => {
    const full: Corner[] = [];
    ring.forEach((corner, i) => {
      const next = ring[(i + 1) % ring.length];
      full.push(corner);
      const rise = level(next.vert) - level(corner.vert);
      for (const vert of between(corner.vert, next.vert)) {
        const t = (level(vert) - level(corner.vert)) / rise;
        full.push({
          vert,
          uv: {
            u: corner.uv.u + (next.uv.u - corner.uv.u) * t,
            v: corner.uv.v + (next.uv.v - corner.uv.v) * t,
          },
        });
      }
    });
    return full;
  };

  const wires = [...mesh.edges.values()].filter((edge) => edge.loops.length === 0);
  const sharp = [...mesh.edges.values()].filter((edge) => edge.sharp);
  const pieces: { ring: Corner[]; materialIndex: number; smooth: boolean }[] = [];

  for (const face of crossing) {
    const corners = mesh.faceLoops(face).map((loop) => ({ vert: loop.vert, uv: loop.uv }));
    for (const part of convexParts(corners)) {
      const ring = withSplits(part);
      for (let slab = 0; slab <= cuts.length; slab++) {
        const floor = slab === 0 ? -Infinity : cuts[slab - 1] - epsilon;
        const ceiling = slab === cuts.length ? Infinity : cuts[slab] + epsilon;
        const piece = ring.filter(({ vert }) => level(vert) >= floor && level(vert) <= ceiling);
        if (piece.length < 3) continue;
        const levels = piece.map(({ vert }) => level(vert));
        // A face lying on a plane, or an edge of one, belongs to both slabs it
        // touches. Only a piece with some depth across them is a real one.
        if (Math.max(...levels) - Math.min(...levels) <= epsilon) continue;
        pieces.push({ ring: piece, materialIndex: face.materialIndex, smooth: face.smooth });
      }
    }
  }

  for (const face of crossing) mesh.removeFace(face);
  for (const piece of pieces) {
    const face = mesh.addFace(
      piece.ring.map(({ vert }) => vert),
      { materialIndex: piece.materialIndex, smooth: piece.smooth },
    );
    const uvs = new Map(piece.ring.map(({ vert, uv }) => [vert.id, uv]));
    for (const loop of mesh.faceLoops(face)) loop.uv = { ...(uvs.get(loop.vert.id) ?? loop.uv) };
  }

  const keep = new Set<number>();
  for (const edge of wires) {
    const chain = [edge.v0, ...between(edge.v0, edge.v1), edge.v1];
    if (chain.length === 2) {
      keep.add(edge.id);
      continue;
    }
    for (let i = 0; i < chain.length - 1; i++) keep.add(mesh.addEdge(chain[i], chain[i + 1]).id);
  }
  for (const edge of sharp) {
    carrySharp(mesh, edge, [edge.v0, ...between(edge.v0, edge.v1), edge.v1]);
  }
  mesh.removeWireEdges(keep);
}

/** The face as it is when it is convex, otherwise as triangles. */
function convexParts(corners: readonly Corner[]): Corner[][] {
  if (corners.length === 3) return [[...corners]];
  const points = corners.map(({ vert }) => vert.co);
  const normal = polygonNormal(points);
  const convex = points.every((point, i) => {
    const next = points[(i + 1) % points.length];
    const after = points[(i + 2) % points.length];
    return dot(cross(sub(next, point), sub(after, next)), normal) >= -1e-12;
  });
  if (convex) return [[...corners]];

  const indices = triangulatePolygon(points, normal);
  const parts: Corner[][] = [];
  for (let i = 0; i < indices.length; i += 3) {
    parts.push([corners[indices[i]], corners[indices[i + 1]], corners[indices[i + 2]]]);
  }
  return parts;
}

/**
 * Merge by distance over the whole mesh: a modifier has no selection to work
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
  // Levels run as repeated single-cut passes rather than one pass with more
  // cuts: that doubles the resolution per level, and lets SMOOTH round the
  // result again each time instead of once.
  for (let level = 0; level < levels; level++) {
    // A level quadruples the face count and the stack is re-evaluated on every
    // edit, so a level that would put the result past what a tab can hold is
    // dropped rather than run: a modifier is not worth the window.
    if (mesh.faces.size * 4 > MESH_BUDGET.faces) break;
    subdivideFaces(mesh, [...mesh.faces.values()], { cuts: 1, smooth: modifier.smooth });
  }
  return mesh;
}

export const MAX_SUBSURF_LEVELS = 6;

function applySubsurf(mesh: BMesh, modifier: SubsurfModifier): BMesh {
  const levels = Math.max(0, Math.min(MAX_SUBSURF_LEVELS, Math.floor(modifier.levels)));
  let result = mesh;
  for (let level = 0; level < levels; level++) {
    // Each face comes back as one quad per corner. Like LOOP SUBDIVIDE, a level
    // that would outgrow the tab is dropped rather than run.
    let next = 0;
    for (const face of result.faces.values()) next += result.faceLoopCount(face);
    if (next > MESH_BUDGET.faces) break;
    result = catmullClark(result, modifier.catmullClark);
  }
  return result;
}

/**
 * Rebuilds the topology, or leaves the mesh exactly as it was.
 *
 * The remesher refuses some inputs outright (a mesh with no faces, a reduce
 * target that collapses everything), and the rest of the stack has no way to
 * answer a thrown error. This runs while the viewport is drawing, so a throw
 * here is a blank screen rather than a message; a settings combination that
 * cannot be built is one the modifier simply does not apply, and the mesh comes
 * through untouched for the user to see and adjust.
 */
function applyRemesh(mesh: BMesh, modifier: RemeshModifier): BMesh {
  if (mesh.faces.size === 0) return mesh;
  try {
    // Shading belongs to the object rather than to the rebuild, so it is read
    // off the mesh going in: an object shaded smooth comes back smooth without
    // the modifier having to carry an opinion about it.
    let smoothShading = true;
    for (const face of mesh.faces.values()) {
      if (face.smooth) continue;
      smoothShading = false;
      break;
    }
    return remeshMesh(mesh, { ...modifier, smoothShading }).mesh;
  } catch {
    return mesh;
  }
}
