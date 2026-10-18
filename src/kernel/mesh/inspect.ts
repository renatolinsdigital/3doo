import { type Vec3, centroid, cross, dot, length, polygonArea, polygonNormal, sub } from '../math';

import type { BMesh } from './bmesh';
import type { Vert } from './types';

/**
 * What a mesh is made of, and what in it a game engine or a modeller would
 * object to. Counts only: the caller decides what is too many.
 */
export interface MeshInspection {
  verts: number;
  edges: number;
  faces: number;
  /** Triangles once every face is split, which is what an engine draws. */
  tris: number;
  triangles: number;
  quads: number;
  /** Faces of five corners or more. */
  ngons: number;
  /** The most corners on one face, 0 for no faces. */
  maxSides: number;
  /** Edges shared by three faces or more, where no side is outside. */
  nonManifoldEdges: number;
  /** Edges with one face: the rim of a hole or of an open sheet. */
  boundaryEdges: number;
  /** Edges with no face. */
  wireEdges: number;
  /** Vertices with no edge. */
  looseVerts: number;
  /** Faces with next to no area for the length of their longest side. */
  degenerateFaces: number;
  /** Vertices on the same point as another vertex. */
  duplicateVerts: number;
  /** Edges whose two faces run along it the same way, so one of the two faces the wrong side. */
  flippedEdges: number;
  /** Connected pieces with at least one face. */
  shells: number;
  /** Closed pieces whose faces point inward. */
  insideOutShells: number;
  /** Vertices inside a surface whose edge count is not four. */
  poles: { three: number; five: number; sixPlus: number };
  /** Vertices inside a surface with only two edges: a corner that does no work. */
  twoEdgeVerts: number;
  /** Quads whose corners stray off one plane, which engines split in different ways. */
  twistedQuads: number;
  sharpEdges: number;
  smoothFaces: number;
  /** Material slots the faces use. */
  materials: number;
}

/** Vertices closer than this, in the mesh's own units, count as one point. */
export const DUPLICATE_DISTANCE = 1e-5;

/** A quad corner this far off the quad's plane, over its longest diagonal, twists it. */
export const TWIST_RATIO = 0.05;

/** A face with less area than this, over its longest side squared, is a sliver. */
const SLIVER_RATIO = 1e-6;

/** Counts what `MeshInspection` describes. Reads the mesh and changes nothing. */
export function inspectMesh(mesh: BMesh): MeshInspection {
  let tris = 0;
  let triangles = 0;
  let quads = 0;
  let ngons = 0;
  let maxSides = 0;
  let degenerateFaces = 0;
  let twistedQuads = 0;
  let smoothFaces = 0;
  const materials = new Set<number>();

  for (const face of mesh.faces.values()) {
    const points = mesh.facePoints(face);
    const sides = points.length;
    tris += Math.max(0, sides - 2);
    if (sides === 3) triangles++;
    else if (sides === 4) quads++;
    else if (sides > 4) ngons++;
    maxSides = Math.max(maxSides, sides);
    if (face.smooth) smoothFaces++;
    materials.add(face.materialIndex);

    let longest = 0;
    for (let i = 0; i < sides; i++) {
      longest = Math.max(longest, length(sub(points[(i + 1) % sides], points[i])));
    }
    if (polygonArea(points) <= SLIVER_RATIO * longest * longest) degenerateFaces++;
    if (sides === 4 && isTwisted(points)) twistedQuads++;
  }

  let nonManifoldEdges = 0;
  let boundaryEdges = 0;
  let wireEdges = 0;
  let flippedEdges = 0;
  let sharpEdges = 0;
  for (const edge of mesh.edges.values()) {
    const faces = edge.loops.length;
    if (faces === 0) wireEdges++;
    else if (faces === 1) boundaryEdges++;
    else if (faces > 2) nonManifoldEdges++;
    // Neighbours that agree on which way is out run along their shared edge
    // in opposite directions, so their loops start at opposite ends.
    else if (edge.loops[0].vert === edge.loops[1].vert) flippedEdges++;
    if (edge.sharp) sharpEdges++;
  }

  const poles = { three: 0, five: 0, sixPlus: 0 };
  let twoEdgeVerts = 0;
  let looseVerts = 0;
  for (const vert of mesh.verts.values()) {
    if (vert.edges.length === 0) {
      looseVerts++;
      continue;
    }
    if (!vert.edges.every((edge) => edge.loops.length === 2)) continue;
    const count = vert.edges.length;
    if (count === 2) twoEdgeVerts++;
    else if (count === 3) poles.three++;
    else if (count === 5) poles.five++;
    else if (count >= 6) poles.sixPlus++;
  }

  const { shells, insideOutShells } = countShells(mesh);

  return {
    verts: mesh.verts.size,
    edges: mesh.edges.size,
    faces: mesh.faces.size,
    tris,
    triangles,
    quads,
    ngons,
    maxSides,
    nonManifoldEdges,
    boundaryEdges,
    wireEdges,
    looseVerts,
    degenerateFaces,
    duplicateVerts: countDuplicates([...mesh.verts.values()]),
    flippedEdges,
    shells,
    insideOutShells,
    poles,
    twoEdgeVerts,
    twistedQuads,
    sharpEdges,
    smoothFaces,
    materials: materials.size,
  };
}

function isTwisted(points: readonly Vec3[]): boolean {
  const normal = polygonNormal(points);
  const middle = centroid(points);
  const diagonal = Math.max(length(sub(points[2], points[0])), length(sub(points[3], points[1])));
  if (diagonal === 0) return false;
  const furthest = Math.max(...points.map((point) => Math.abs(dot(sub(point, middle), normal))));
  return furthest > TWIST_RATIO * diagonal;
}

/**
 * Vertices that share a point with one counted before them, found through a
 * grid of cells one tolerance wide so each vertex is held against its own
 * cell and the 26 round it rather than against every other vertex.
 */
function countDuplicates(verts: readonly Vert[]): number {
  const cells = new Map<string, Vert[]>();
  const cellOf = (value: number) => Math.floor(value / DUPLICATE_DISTANCE);
  let duplicates = 0;
  for (const vert of verts) {
    const [cx, cy, cz] = [cellOf(vert.co.x), cellOf(vert.co.y), cellOf(vert.co.z)];
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx++) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dz = -1; dz <= 1 && !found; dz++) {
          const near = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          found = !!near?.some((other) => length(sub(other.co, vert.co)) <= DUPLICATE_DISTANCE);
        }
      }
    }
    if (found) duplicates++;
    const key = `${cx},${cy},${cz}`;
    const cell = cells.get(key);
    if (cell) cell.push(vert);
    else cells.set(key, [vert]);
  }
  return duplicates;
}

/**
 * The pieces of the mesh with faces in them, and how many of the closed ones
 * are inside out. A closed piece encloses a volume, and its faces point
 * outward when that volume, summed face by face from the origin, comes out
 * positive.
 */
function countShells(mesh: BMesh): { shells: number; insideOutShells: number } {
  const parent = new Map<number, number>();
  const root = (id: number): number => {
    let at = id;
    while (parent.get(at) !== at) {
      const up = parent.get(at) ?? at;
      parent.set(at, parent.get(up) ?? up);
      at = up;
    }
    return at;
  };
  for (const vert of mesh.verts.values()) parent.set(vert.id, vert.id);
  for (const edge of mesh.edges.values()) {
    const a = root(edge.v0.id);
    const b = root(edge.v1.id);
    if (a !== b) parent.set(a, b);
  }

  const volume = new Map<number, number>();
  const open = new Set<number>();
  for (const face of mesh.faces.values()) {
    const points = mesh.facePoints(face);
    const shell = root(face.loop.vert.id);
    let sum = volume.get(shell) ?? 0;
    for (let i = 1; i + 1 < points.length; i++) {
      sum += dot(points[0], cross(points[i], points[i + 1])) / 6;
    }
    volume.set(shell, sum);
    for (const edge of mesh.faceEdges(face)) {
      if (edge.loops.length !== 2) open.add(shell);
    }
  }

  let insideOutShells = 0;
  for (const [shell, enclosed] of volume) {
    if (!open.has(shell) && enclosed < 0) insideOutShells++;
  }
  return { shells: volume.size, insideOutShells };
}
