import { beforeEach, describe, expect, it } from 'vitest';

import { type Vec3, clamp, degToRad, distance, dot, lerp, sub, vec3 } from '../math';
import { BMesh } from '../mesh';
import type { Face, Vert } from '../mesh/types';
import {
  createBox,
  createCircle,
  createCone,
  createCylinder,
  createGrid,
  createPlane,
} from '../primitives';

import { bevelEdges } from './bevel';
import { booleanMesh } from './boolean';
import { connectVerts } from './connect';
import { deleteGeometry } from './delete';
import {
  dissolveEdges,
  dissolveFaces,
  dissolveVerts,
  isDissolvableEdge,
  isDissolvableVert,
  limitedDissolve,
} from './dissolve';
import { extrudeFaces } from './extrude';
import { bridgeEdgeLoops, fillHole } from './fill';
import { insetFaces } from './inset';
import { canLoopCut, loopCut } from './loopcut';
import { relaxVerts } from './relax';
import { countMergeByDistance, mergeByDistance, mergeVerts } from './merge';
import { flipNormals, recalculateNormals } from './normals';
import { budgetRefusal, vertsAfterEdgeSubdivide, worthWarning } from './budget';
import {
  subdivideEdges,
  subdivideFaces,
  subdivisionCost,
  triangulateFaces,
  trisToQuads,
} from './subdivide';
import { rotateVerts, scaleVerts, translateVerts } from './transform';
import {
  faceLoopAtClick,
  hasConnectedEdges,
  selectEdgeLoop,
  selectEdgeLoops,
  selectEdgeRing,
  selectLinked,
} from './select';

/** Euler characteristic of a closed manifold surface is 2 per shell. */
function eulerCharacteristic(mesh: BMesh): number {
  return mesh.verts.size - mesh.edges.size + mesh.faces.size;
}

function isClosed(mesh: BMesh): boolean {
  return [...mesh.edges.values()].every((edge) => edge.loops.length === 2);
}

function faceAtCenter(mesh: BMesh, center: Vec3): Face {
  for (const face of mesh.faces.values()) {
    const found = mesh.faceCenter(face);
    if (Math.abs(found.x - center.x) < 1e-6 && Math.abs(found.z - center.z) < 1e-6) return face;
  }
  throw new Error('No face found at that centre');
}

function faceAt(mesh: BMesh, normal: Vec3): Face {
  for (const face of mesh.faces.values()) {
    const alignment =
      face.normal.x * normal.x + face.normal.y * normal.y + face.normal.z * normal.z;
    if (alignment > 0.99) return face;
  }
  throw new Error('No face found with that normal');
}

describe('extrude', () => {
  let cube: BMesh;

  beforeEach(() => {
    cube = createBox(2);
  });

  it('adds a wall per boundary edge and keeps the mesh closed', () => {
    const top = faceAt(cube, vec3(0, 1, 0));

    extrudeFaces(cube, [top], { offset: 1 });

    expect(cube.verts.size).toBe(12);
    expect(cube.faces.size).toBe(10);
    expect(cube.edges.size).toBe(20);
    expect(eulerCharacteristic(cube)).toBe(2);
    expect(isClosed(cube)).toBe(true);
    expect(cube.validate()).toEqual([]);
  });

  it('moves the extruded face by the offset', () => {
    const top = faceAt(cube, vec3(0, 1, 0));

    const result = extrudeFaces(cube, [top], { offset: 1.5 });

    for (const vert of result.newVerts) expect(vert.co.y).toBeCloseTo(2.5);
    expect(faceAt(cube, vec3(0, 1, 0)).normal.y).toBeCloseTo(1);
  });

  it('extrudes a multi-face region as one connected block', () => {
    const grid = createGrid(4, 2);
    const faces = [...grid.faces.values()];

    extrudeFaces(grid, faces, { offset: 1 });

    expect(isClosed(grid)).toBe(false); // the grid's outer rim stays open
    expect(grid.faces.size).toBe(4 + 8);
    expect(grid.validate()).toEqual([]);
  });

  it('extrudes faces individually when asked', () => {
    const top = faceAt(cube, vec3(0, 1, 0));
    const bottom = faceAt(cube, vec3(0, -1, 0));

    extrudeFaces(cube, [top, bottom], { offset: 1, individual: true });

    expect(cube.faces.size).toBe(14);
    expect(isClosed(cube)).toBe(true);
    expect(cube.validate()).toEqual([]);
  });
});

describe('inset', () => {
  it('rings a face with a border and shrinks the original', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));

    const result = insetFaces(cube, [top], { thickness: 0.25 });

    expect(result.borderFaces).toHaveLength(4);
    expect(cube.faces.size).toBe(10);
    expect(isClosed(cube)).toBe(true);
    expect(eulerCharacteristic(cube)).toBe(2);

    for (const vert of cube.faceVerts(result.faces[0])) {
      expect(Math.abs(vert.co.x)).toBeCloseTo(0.75);
      expect(Math.abs(vert.co.z)).toBeCloseTo(0.75);
      expect(vert.co.y).toBeCloseTo(1);
    }
    expect(cube.validate()).toEqual([]);
  });

  it('pushes the inner face along the normal when given depth', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));

    const result = insetFaces(cube, [top], { thickness: 0.25, depth: -0.5 });

    for (const vert of cube.faceVerts(result.faces[0])) expect(vert.co.y).toBeCloseTo(0.5);
  });

  it('keeps the outline when insetting a region', () => {
    const cube = createBox(2);
    const faces = [faceAt(cube, vec3(0, 1, 0)), faceAt(cube, vec3(1, 0, 0))];

    insetFaces(cube, faces, { thickness: 0.2 });

    expect(isClosed(cube)).toBe(true);
    expect(cube.validate()).toEqual([]);
  });
});

describe('bevel', () => {
  it('chamfers every edge of a cube into a 26-face solid', () => {
    const cube = createBox(2);

    bevelEdges(cube, [...cube.edges.values()], { width: 0.3 });

    expect(cube.verts.size).toBe(24);
    expect(cube.faces.size).toBe(26);
    expect(cube.edges.size).toBe(48);
    expect(eulerCharacteristic(cube)).toBe(2);
    expect(isClosed(cube)).toBe(true);
    expect(cube.validate()).toEqual([]);
  });

  it('points every bevelled face outward', () => {
    const cube = createBox(2);
    bevelEdges(cube, [...cube.edges.values()], { width: 0.3 });

    for (const face of cube.faces.values()) {
      const center = cube.faceCenter(face);
      const outward =
        center.x * face.normal.x + center.y * face.normal.y + center.z * face.normal.z;
      expect(outward).toBeGreaterThan(0);
    }
  });

  it('rounds the profile with extra segments', () => {
    const cube = createBox(2);

    bevelEdges(cube, [...cube.edges.values()], { width: 0.3, segments: 3 });

    expect(isClosed(cube)).toBe(true);
    expect(eulerCharacteristic(cube)).toBe(2);
    expect(cube.faces.size).toBeGreaterThan(26);
    expect(cube.validate()).toEqual([]);
  });

  it('bevels a single closed edge loop', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));
    const ring = cube.faceEdges(top);

    bevelEdges(cube, ring, { width: 0.3 });

    expect(isClosed(cube)).toBe(true);
    expect(eulerCharacteristic(cube)).toBe(2);
    expect(cube.validate()).toEqual([]);
  });

  it('clamps the width so offsets never cross an edge', () => {
    const cube = createBox(2);

    bevelEdges(cube, [...cube.edges.values()], { width: 50 });

    expect(isClosed(cube)).toBe(true);
    expect(cube.validate()).toEqual([]);
    for (const vert of cube.verts.values()) {
      expect(Math.abs(vert.co.x)).toBeLessThanOrEqual(1.001);
    }
  });
});

describe('loop cut', () => {
  it('rings a cube with one new loop of four edges', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));
    const start = cube.faceEdges(top)[0];

    const result = loopCut(cube, start, { cuts: 1 });

    expect(result.verts).toHaveLength(4);
    expect(cube.verts.size).toBe(12);
    expect(cube.faces.size).toBe(10);
    expect(eulerCharacteristic(cube)).toBe(2);
    expect(isClosed(cube)).toBe(true);
    expect(cube.validate()).toEqual([]);
  });

  it('inserts several evenly spaced loops', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));

    const result = loopCut(cube, cube.faceEdges(top)[0], { cuts: 3 });

    expect(result.verts).toHaveLength(12);
    expect(isClosed(cube)).toBe(true);
    expect(eulerCharacteristic(cube)).toBe(2);
    expect(cube.validate()).toEqual([]);
  });

  it('stops at the end of an open ring', () => {
    const grid = createGrid(4, 2);
    const face = [...grid.faces.values()][0];

    const result = loopCut(grid, grid.faceEdges(face)[0], { cuts: 1 });

    expect(result.verts.length).toBeGreaterThan(0);
    expect(grid.validate()).toEqual([]);
  });

  it('has no ring to cut across a cone', () => {
    // Every side face is a triangle and the base is one n-gon, so the ring walk
    // has nowhere to step — the same reason Blender will not cut one either.
    const cone = createCone(0.5, 1, 12, true);

    for (const edge of cone.edges.values()) {
      expect(canLoopCut(cone, edge)).toBe(false);
      expect(loopCut(cone, edge, { cuts: 1 }).verts).toHaveLength(0);
    }
    expect(cone.verts.size).toBe(13);
  });

  it('has a ring to cut wherever a quad sits on the edge', () => {
    const cube = createBox(2);
    const edge = [...cube.edges.values()][0];

    expect(canLoopCut(cube, edge)).toBe(true);
    expect(loopCut(cube, edge, { cuts: 1 }).verts.length).toBeGreaterThan(0);
  });
});

describe('relax', () => {
  /** The top ring of an open cylinder, in the order it runs round the axis. */
  function topRing(mesh: BMesh): Vert[] {
    return [...mesh.verts.values()]
      .filter((vert) => vert.co.y > 0)
      .sort((a, b) => Math.atan2(a.co.z, a.co.x) - Math.atan2(b.co.z, b.co.x));
  }

  function gaps(ring: readonly Vert[]): number[] {
    return ring.map((vert, i) => distance(vert.co, ring[(i + 1) % ring.length].co));
  }

  /** How far `point` sits off the closed polyline through `path`. */
  function offPath(point: Vec3, path: readonly Vec3[]): number {
    let closest = Infinity;
    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      const along = sub(b, a);
      const t = clamp(dot(sub(point, a), along) / Math.max(dot(along, along), 1e-12), 0, 1);
      closest = Math.min(closest, distance(point, lerp(a, b, t)));
    }
    return closest;
  }

  it('evens out a loop bunched up against itself, keeping the surface', () => {
    const tube = createCylinder(0.5, 1, 8, false);
    const ring = topRing(tube);
    // One vertex slid round from 45° to within 5° of its neighbour, where the
    // rest of the ring sits 45° apart.
    const angle = degToRad(5);
    ring[4].co = vec3(Math.cos(angle) * 0.5, 0.5, Math.sin(angle) * 0.5);

    const before = gaps(topRing(tube));
    const path = topRing(tube).map((vert) => ({ ...vert.co }));
    expect(Math.max(...before) / Math.min(...before)).toBeGreaterThan(8);

    relaxVerts(tube, ring, { factor: 1, iterations: 4 });

    const after = gaps(topRing(tube));
    expect(Math.max(...after) / Math.min(...after)).toBeLessThan(1.2);
    // Spread along the ring, not pulled off it: every vertex is still on the
    // path it started on, which is made of edges of the mesh.
    for (const vert of ring) {
      expect(offPath(vert.co, path)).toBeLessThan(1e-9);
      expect(vert.co.y).toBeCloseTo(0.5, 6);
    }
    expect(tube.validate()).toEqual([]);
  });

  it('pulls the kinks out of a loop running across the surface', () => {
    const grid = createGrid(4, 4);
    // The column of vertices at x = 0, running from one border to the other,
    // thrown into a zigzag: the loop a user selects and relaxes.
    const column = [...grid.verts.values()]
      .filter((vert) => vert.co.x === 0)
      .sort((a, b) => a.co.z - b.co.z);
    expect(column).toHaveLength(5);

    [0.4, -0.4, 0.4].forEach((x, i) => {
      column[i + 1].co = vec3(x, 0, column[i + 1].co.z);
    });

    relaxVerts(grid, column, { factor: 1, iterations: 20 });

    for (const vert of column) {
      expect(vert.co.x).toBeCloseTo(0, 2);
      expect(vert.co.y).toBeCloseTo(0, 9);
    }
    // The loop ran out at the border, so the vertices it ran out at held still
    // and the rest were spaced against them.
    expect(column[0].co.z).toBeCloseTo(-2, 9);
    expect(column[4].co.z).toBeCloseTo(2, 9);
    expect(grid.validate()).toEqual([]);
  });

  it('brings a kinked ring back into line without leaving the wall it runs round', () => {
    const tube = createCylinder(0.5, 2, 8, true);
    const vertical = [...tube.edges.values()].find(
      (edge) => edge.v0.co.x === edge.v1.co.x && edge.v0.co.z === edge.v1.co.z,
    );
    if (!vertical) throw new Error('no vertical edge');

    const ring = loopCut(tube, vertical, { cuts: 1 }).verts;
    expect(ring).toHaveLength(8);
    ring[0].co = vec3(ring[0].co.x, 0.6, ring[0].co.z);

    relaxVerts(tube, ring, { factor: 1, iterations: 25 });

    // Back into one flat ring. It settles at the average height of the loop it
    // started as rather than back at zero, the way a relaxed curve settles
    // wherever its own slack leaves it.
    const heights = ring.map((vert) => vert.co.y);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.02);

    for (const vert of ring) {
      // Still on the wall: a relaxed ring slides across the tube rather than
      // sinking into it, which is what the plain average of the neighbours —
      // every one of them inside the ring — would have done.
      expect(Math.hypot(vert.co.x, vert.co.z)).toBeGreaterThan(0.5 * Math.cos(Math.PI / 8) - 1e-9);
      expect(Math.hypot(vert.co.x, vert.co.z)).toBeLessThan(0.5 + 1e-9);
    }
    expect(tube.validate()).toEqual([]);
  });

  it('flattens a spike once it is allowed off the surface', () => {
    const cube = createBox(2);
    const [corner] = [...cube.verts.values()];
    corner.co = vec3(6, 6, 6);

    relaxVerts(cube, [...cube.verts.values()], { factor: 0.5, iterations: 10, keepShape: false });

    expect(corner.co.x).toBeLessThan(2);
    expect(cube.verts.size).toBe(8);
    expect(cube.faces.size).toBe(6);
    expect(cube.validate()).toEqual([]);
  });

  it('relaxes an open border along itself rather than dragging it inward', () => {
    const grid = createGrid(2, 4);

    relaxVerts(grid, [...grid.verts.values()], { factor: 0.5, iterations: 20, keepShape: false });

    // Averaged against the interior instead, the border would close in on it a
    // little more with every pass.
    const box = grid.boundingBox();
    expect(box.min.x).toBeCloseTo(-1, 6);
    expect(box.max.x).toBeCloseTo(1, 6);
    expect(box.min.z).toBeCloseTo(-1, 6);
    expect(box.max.z).toBeCloseTo(1, 6);
    expect(grid.validate()).toEqual([]);
  });

  it('leaves the vertices it was not given alone', () => {
    const grid = createGrid(2, 4);
    const moved = [...grid.verts.values()].find((vert) => vert.co.x === 0 && vert.co.z === 0);
    if (!moved) throw new Error('no centre vertex');
    moved.co = vec3(0, 1, 0);

    const before = [...grid.verts.values()].map((vert) => ({ ...vert.co }));
    relaxVerts(grid, [moved], { factor: 1, iterations: 5, keepShape: false });

    const after = [...grid.verts.values()];
    for (let i = 0; i < after.length; i++) {
      if (after[i] === moved) continue;
      expect(after[i].co).toEqual(before[i]);
    }
    expect(moved.co.y).toBeCloseTo(0, 6);
  });
});

describe('subdivide', () => {
  it('turns each cube face into four quads', () => {
    const cube = createBox(2);

    subdivideFaces(cube, [...cube.faces.values()], { cuts: 1 });

    expect(cube.verts.size).toBe(26);
    expect(cube.faces.size).toBe(24);
    expect(cube.edges.size).toBe(48);
    expect(eulerCharacteristic(cube)).toBe(2);
    expect(cube.validate()).toEqual([]);
  });

  const quads = (mesh: BMesh) =>
    [...mesh.faces.values()].every((face) => mesh.faceLoops(face).length === 4);

  it('runs its cuts on round the mesh, so nothing is left half cut', () => {
    // One face of a cube, one cut, and the two rings that cut crosses run all
    // the way round: the face itself comes back as four, the face across from
    // it as four, and the four each ring passes through as two. Every one of
    // them is still a quad. A cut that stopped at the selection would leave its
    // neighbours carrying a vertex in the middle of one side, which is the
    // state nothing can be cut into afterwards.
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));

    subdivideFaces(cube, [top], { cuts: 1 });

    expect(cube.faces.size).toBe(4 + 4 + 4 * 2);
    expect(quads(cube)).toBe(true);
    expect(isClosed(cube)).toBe(true);
    expect(eulerCharacteristic(cube)).toBe(2);
    expect(cube.validate()).toEqual([]);
  });

  it('takes exactly the cuts it is given, and no more', () => {
    // Four cuts is a five by five grid, not four rounds of the one-cut scheme:
    // that would cut every edge sixteen ways and hand back 256 faces. The cuts
    // travel, so the face across the cube is gridded with it and the four the
    // rings pass through come back as five strips each.
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));

    const cut = subdivideFaces(cube, [top], { cuts: 4 });

    expect(cut.length).toBe(25);
    expect(cube.faces.size).toBe(25 + 25 + 4 * 5);
    expect(quads(cube)).toBe(true);
    expect(isClosed(cube)).toBe(true);
    expect(eulerCharacteristic(cube)).toBe(2);
    expect(cube.validate()).toEqual([]);
  });

  /** The faces of a grid whose centres fall inside the box, in grid units. */
  function block(mesh: BMesh, min: number, max: number): Face[] {
    return [...mesh.faces.values()].filter((face) => {
      const centre = mesh.faceCenter(face);
      return centre.x > min && centre.x < max && centre.z > min && centre.z < max;
    });
  }

  it('carries the cuts of a region out to the edge of the mesh', () => {
    // Ten by ten of unit cells, four by four of them selected, one cut each.
    // That is four cuts across the block and four down it, and every one of
    // them runs to the edge of the mesh: fourteen by fourteen cells, all quads.
    const grid = createGrid(10, 10);
    const region = block(grid, -2, 2);
    expect(region.length).toBe(16);

    subdivideFaces(grid, region, { cuts: 1 });

    expect(grid.faces.size).toBe(14 * 14);
    expect(grid.verts.size).toBe(15 * 15);
    expect(quads(grid)).toBe(true);
    expect(grid.validate()).toEqual([]);
  });

  it('cuts the face beside one already cut, rather than nothing at all', () => {
    // The complaint this answers: subdivide a face, try to subdivide the face
    // next to it, and nothing happened at all — the first cut had left it
    // carrying a row of vertices along the shared side, and no cut at the
    // spacing asked for could land on them. Cuts that run leave no such face.
    const grid = createGrid(10, 10);
    const first = subdivideFaces(grid, block(grid, -1, 0), { cuts: 4 });
    const cut = new Set(first.map((face) => face.id));

    const beside = [...grid.faces.values()].find(
      (face) =>
        !cut.has(face.id) &&
        grid
          .faceEdges(face)
          .some((edge) => grid.edgeFaces(edge).some((other) => cut.has(other.id))),
    );
    const before = grid.faces.size;

    const second = subdivideFaces(grid, [beside as Face], { cuts: 4 });

    expect(second.length).toBe(25);
    expect(grid.faces.size).toBeGreaterThan(before);
    expect(quads(grid)).toBe(true);
    expect(grid.validate()).toEqual([]);
  });

  it('keeps the surface it started with, however far the cuts run', () => {
    // Two subdivisions of two different faces at two different counts, the
    // second reading a mesh the first cut through. Nothing may be lost or
    // gained: a fan across a face, or a cell hung off a vertex that is not
    // there, shows up here as surface that was not in the cage.
    const cube = createBox(2);
    const area = () => [...cube.faces.values()].reduce((sum, face) => sum + cube.faceArea(face), 0);
    const before = area();

    subdivideFaces(cube, [faceAt(cube, vec3(0, 1, 0))], { cuts: 4 });
    subdivideFaces(cube, [faceAt(cube, vec3(1, 0, 0))], { cuts: 3 });

    expect(area()).toBeCloseTo(before, 9);
    expect(quads(cube)).toBe(true);
    expect(isClosed(cube)).toBe(true);
    expect(eulerCharacteristic(cube)).toBe(2);
    expect(cube.validate()).toEqual([]);

    // A fan would leave a hub carrying every quad of the face at once; a grid
    // leaves four apiece.
    const crowded = Math.max(
      ...[...cube.verts.values()].map((vert) => cube.vertFaces(vert).length),
    );
    expect(crowded).toBeLessThanOrEqual(4);
  });

  it('pulls corners toward the limit surface when smoothing', () => {
    const cube = createBox(2);
    const cornerDistance = Math.sqrt(3);

    subdivideFaces(cube, [...cube.faces.values()], { cuts: 1, smooth: 1 });

    // Catmull-Clark leaves face points on the face centres, so the bounding box
    // still touches 1. What must shrink is the corners it rounds off.
    const furthest = Math.max(
      ...[...cube.verts.values()].map((vert) => Math.hypot(vert.co.x, vert.co.y, vert.co.z)),
    );
    expect(furthest).toBeLessThan(cornerDistance);
    expect(cube.validate()).toEqual([]);
  });

  it('keeps a face it cannot fan whole, rather than starring across the gap in it', () => {
    // A C: a square with a slot cut in from one side. The average of its
    // corners lands in the slot, off the face entirely, and the quads
    // subdivision fans off each corner would sweep across the slot to reach it.
    // The same shape a boolean leaves around a hole it cut, and the same
    // starburst if it is fanned anyway.
    const mesh = new BMesh();
    const ring = [
      vec3(-1, 0, -1),
      vec3(1, 0, -1),
      vec3(1, 0, -0.2),
      vec3(0, 0, -0.2),
      vec3(0, 0, 0.2),
      vec3(1, 0, 0.2),
      vec3(1, 0, 1),
      vec3(-1, 0, 1),
    ].map((point) => mesh.addVert(point));
    mesh.addFace(ring);

    const before = mesh.faceArea([...mesh.faces.values()][0]);
    expect(before).toBeCloseTo(4 - 0.4, 9);

    // Smoothing off, so the split is topology alone and the surface it covers
    // cannot have changed by so much as a rounding error.
    subdivideFaces(mesh, [...mesh.faces.values()], { cuts: 1, smooth: 0 });

    const after = [...mesh.faces.values()].reduce((sum, face) => sum + mesh.faceArea(face), 0);
    expect(after).toBeCloseTo(before, 9);
    expect(mesh.validate()).toEqual([]);
  });

  it('does not fold a face with a hole in it, however fine the hole is', () => {
    // The shape every boolean leaves behind: a slab with a hole, stated as the
    // two faces one ring each can manage. Fanning either from the middle of its
    // corners paints over the hole, and cutting either into splinters folds the
    // slab into fins once the smoothing pulls on them. Both show up as surface
    // that was not there before.
    const slab = (segments: number): BMesh => {
      const mesh = new BMesh();
      const square = [vec3(-1, 0, -1), vec3(1, 0, -1), vec3(1, 0, 1), vec3(-1, 0, 1)].map((point) =>
        mesh.addVert(point),
      );
      const hole = Array.from({ length: segments }, (_, i) => {
        const turn = (-2 * Math.PI * i) / segments;
        return mesh.addVert(vec3(0.7 * Math.cos(turn), 0, 0.7 * Math.sin(turn)));
      });
      const half = Math.floor(segments / 2);
      mesh.addFace([square[0], square[1], square[2], ...hole.slice(0, half + 1)]);
      mesh.addFace([square[2], square[3], square[0], ...hole.slice(half), hole[0]]);
      mesh.computeNormals();
      return mesh;
    };
    const area = (mesh: BMesh) =>
      [...mesh.faces.values()].reduce((sum, face) => sum + mesh.faceArea(face), 0);

    for (const segments of [8, 16, 32, 64]) {
      const before = area(slab(segments));

      const split = slab(segments);
      subdivideFaces(split, [...split.faces.values()], { cuts: 1, smooth: 0 });
      expect(area(split)).toBeCloseTo(before, 9);

      // Smoothing pulls the surface in, never out: anything larger than the
      // cage is surface folded back over itself.
      const smoothed = slab(segments);
      subdivideFaces(smoothed, [...smoothed.faces.values()], { cuts: 1, smooth: 1 });
      expect(area(smoothed)).toBeLessThan(before);
      expect(smoothed.validate()).toEqual([]);
    }
  });

  it('leaves the surface of a bored solid the size it was', () => {
    // The whole of it: the bored face comes back as two rings of surface around
    // the hole, and fanning either one from the middle of its corners paints
    // over the bore.
    const bored = booleanMesh('difference', createBox(2), createCylinder(0.4, 1, 24), (point) => ({
      ...point,
      y: point.y + 1.3,
    }));

    const before = [...bored.faces.values()].reduce((sum, face) => sum + bored.faceArea(face), 0);
    subdivideFaces(bored, [...bored.faces.values()], { cuts: 1, smooth: 0 });
    const after = [...bored.faces.values()].reduce((sum, face) => sum + bored.faceArea(face), 0);

    expect(after).toBeCloseTo(before, 9);
    expect(isClosed(bored)).toBe(true);
    expect(bored.validate()).toEqual([]);
  });

  it('triangulates and rebuilds quads', () => {
    const cube = createBox(2);

    triangulateFaces(cube, [...cube.faces.values()]);
    expect(cube.faces.size).toBe(12);
    expect(cube.validate()).toEqual([]);

    trisToQuads(cube, [...cube.faces.values()]);
    expect(cube.faces.size).toBe(6);
    expect(cube.validate()).toEqual([]);
  });
});

describe('mesh budget', () => {
  it('refuses a result past what a tab holds, and lets a smaller one through', () => {
    expect(budgetRefusal({ faces: 140_630 })).toBeNull();
    expect(budgetRefusal({ faces: 3_515_750 })).toMatch(/3,515,750 faces/);
    expect(budgetRefusal({ verts: vertsAfterEdgeSubdivide(282008, 282008, 16) })).toMatch(
      /vertices/,
    );
  });

  it('warns about a result worth warning about', () => {
    expect(worthWarning({ faces: 3_750 })).toBe(false);
    expect(worthWarning({ faces: 93_750 })).toBe(true);
  });

  it('costs a subdivision by the cuts it would run, not the faces selected', () => {
    // Four cuts over one face of a cube is twenty-five faces where it was
    // asked, but the cuts run: the face across the cube is gridded with it and
    // the four the rings pass through come back as strips. Costing the
    // selection alone would have promised thirty and delivered seventy.
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));

    expect(subdivisionCost(cube, [top], 4)).toBe(25 + 25 + 4 * 5);

    subdivideFaces(cube, [top], { cuts: 4 });
    expect(cube.faces.size).toBe(25 + 25 + 4 * 5);
  });
});

describe('merge by distance', () => {
  it('welds coincident vertices and reports the count', () => {
    const mesh = new BMesh();
    const a = mesh.addVert(vec3(0, 0, 0));
    const b = mesh.addVert(vec3(1, 0, 0));
    const c = mesh.addVert(vec3(1, 0, 1));
    const d = mesh.addVert(vec3(0, 0, 1));
    mesh.addFace([a, b, c, d]);

    const e = mesh.addVert(vec3(1.0001, 0, 0));
    const f = mesh.addVert(vec3(2, 0, 0));
    const g = mesh.addVert(vec3(2, 0, 1));
    const h = mesh.addVert(vec3(1.0001, 0, 1));
    mesh.addFace([e, f, g, h]);

    expect(mesh.verts.size).toBe(8);
    expect(countMergeByDistance([...mesh.verts.values()], 0.01)).toBe(2);

    const result = mergeByDistance(mesh, [...mesh.verts.values()], 0.01);

    expect(result.removed).toBe(2);
    expect(mesh.verts.size).toBe(6);
    expect(mesh.faces.size).toBe(2);
    expect(mesh.findEdge(b, c)?.loops).toHaveLength(2);
    expect(mesh.validate()).toEqual([]);
  });

  it('leaves geometry alone below the threshold', () => {
    const cube = createBox(2);

    const result = mergeByDistance(cube, [...cube.verts.values()], 0.001);

    expect(result.removed).toBe(0);
    expect(cube.verts.size).toBe(8);
  });

  it('keeps wire edges and isolated points the weld did not orphan', () => {
    const mesh = new BMesh();
    const a = mesh.addVert(vec3(0, 0, 0));
    const b = mesh.addVert(vec3(1, 0, 0));
    const c = mesh.addVert(vec3(1.0001, 0, 0));
    const d = mesh.addVert(vec3(2, 0, 0));
    mesh.addEdge(a, b);
    mesh.addEdge(c, d);
    const island = mesh.addVert(vec3(9, 9, 9));

    const result = mergeByDistance(mesh, [...mesh.verts.values()], 0.001);

    expect(result.removed).toBe(1);
    expect(mesh.edges.size).toBe(2);
    expect(mesh.verts.has(island.id)).toBe(true);
    expect(mesh.validate()).toEqual([]);
  });

  it('drops faces that collapse to a sliver', () => {
    const cylinder = createCylinder(1, 2, 8, true);
    const before = cylinder.faces.size;

    mergeByDistance(cylinder, [...cylinder.verts.values()], 5);

    expect(cylinder.faces.size).toBeLessThan(before);
    expect(cylinder.validate()).toEqual([]);
  });

  it('merges a selection to its centre', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));
    const verts = cube.faceVerts(top);

    mergeVerts(cube, verts, 'center');

    expect(cube.verts.size).toBe(5);
    expect(cube.faces.size).toBe(5);
    expect(cube.validate()).toEqual([]);
  });

  it('merges to the first- or last-clicked vertex, not the mesh order', () => {
    // Click the top corners newest-first, the reverse of the order the mesh
    // created them, so a correct pick cannot coincide with iteration order.
    const clickTopFace = (mesh: BMesh) => {
      const corners = [...mesh.faceVerts(faceAt(mesh, vec3(0, 1, 0)))].sort((a, b) => b.id - a.id);
      for (const vert of corners) mesh.selectVert(vert);
      return corners;
    };

    const first = createBox(2);
    const firstClicks = clickTopFace(first);
    mergeVerts(first, first.selectedVerts(), 'first');
    expect(first.verts.has(firstClicks[0].id)).toBe(true);
    expect(first.verts.has(firstClicks[firstClicks.length - 1].id)).toBe(false);

    const last = createBox(2);
    const lastClicks = clickTopFace(last);
    mergeVerts(last, last.selectedVerts(), 'last');
    expect(last.verts.has(lastClicks[lastClicks.length - 1].id)).toBe(true);
    expect(last.verts.has(lastClicks[0].id)).toBe(false);
  });
});

describe('subdivide edges', () => {
  it('puts a vertex on the midpoint and splices it into both faces', () => {
    const cube = createBox(2);
    const edge = [...cube.edges.values()][0];
    const midpoint = vec3(
      (edge.v0.co.x + edge.v1.co.x) / 2,
      (edge.v0.co.y + edge.v1.co.y) / 2,
      (edge.v0.co.z + edge.v1.co.z) / 2,
    );

    const added = subdivideEdges(cube, [edge]);

    expect(added).toHaveLength(1);
    expect(added[0].co).toEqual(midpoint);
    expect(cube.verts.size).toBe(9);
    expect(cube.faces.size).toBe(6);
    // The two faces sharing the edge gain the vertex; the other four are untouched.
    expect([...cube.faces.values()].map((face) => cube.faceVerts(face).length).sort()).toEqual([
      4, 4, 4, 4, 5, 5,
    ]);
    expect(cube.validate()).toEqual([]);
  });

  it('keeps the surface closed', () => {
    const cube = createBox(2);

    subdivideEdges(cube, [...cube.edges.values()]);

    expect(cube.verts.size - cube.edges.size + cube.faces.size).toBe(2);
    expect(cube.validate()).toEqual([]);
    for (const face of cube.faces.values()) expect(cube.faceVerts(face)).toHaveLength(8);
  });

  it('adds several evenly spaced vertices when asked for more cuts', () => {
    const plane = createPlane(2);
    const edge = [...plane.edges.values()][0];

    const added = subdivideEdges(plane, [edge], 3);

    expect(added).toHaveLength(3);
    expect(plane.faceVerts([...plane.faces.values()][0])).toHaveLength(7);
    expect(plane.validate()).toEqual([]);
  });

  it('splits a wire edge that has no face to rebuild', () => {
    const ring = createCircle(1, 6, false);
    expect(ring.faces.size).toBe(0);

    subdivideEdges(ring, [[...ring.edges.values()][0]]);

    expect(ring.verts.size).toBe(7);
    expect(ring.edges.size).toBe(7);
    expect(ring.validate()).toEqual([]);
  });
});

describe('dissolving on an open mesh keeps it intact', () => {
  // The region's boundary edges are the merged face's own ring. Pruning every
  // edge left without a loop took those too whenever no face outside the region
  // shared them, deleting the ring's vertices out from under the rebuilt face.
  it('merges a whole open region without leaving edges on dead vertices', () => {
    const grid = createGrid(2, 2);

    dissolveFaces(grid, [...grid.faces.values()]);

    expect(grid.validate()).toEqual([]);
    expect(grid.faces.size).toBe(1);
    expect(grid.verts.size).toBe(8);
    expect(grid.faceVerts([...grid.faces.values()][0])).toHaveLength(8);
  });

  it('merges part of an open region without corrupting the rest', () => {
    const grid = createGrid(2, 2);

    dissolveFaces(grid, [...grid.faces.values()].slice(0, 2));

    expect(grid.validate()).toEqual([]);
    expect(grid.faces.size).toBe(3);
  });

  it('collapses a flat fan into one n-gon and drops the vertex', () => {
    const grid = createGrid(2, 2);
    const centre = [...grid.verts.values()].filter((vert) => grid.vertFaces(vert).length === 4);
    expect(centre).toHaveLength(1);

    dissolveVerts(grid, centre);

    expect(grid.validate()).toEqual([]);
    expect(grid.verts.has(centre[0].id)).toBe(false);
    expect(grid.faces.size).toBe(1);
    expect(grid.verts.size).toBe(8);
  });

  it('trims a boundary vertex out of the single face using it', () => {
    const plane = createPlane(2);

    dissolveVerts(plane, [[...plane.verts.values()][0]]);

    expect(plane.validate()).toEqual([]);
    expect(plane.verts.size).toBe(3);
    expect(plane.faces.size).toBe(1);
  });

  it('removes a cube corner cleanly, leaving a closed surface', () => {
    const cube = createBox(2);

    dissolveVerts(cube, [[...cube.verts.values()][0]]);

    expect(cube.validate()).toEqual([]);
    // Euler characteristic of a closed genus-0 surface.
    expect(cube.verts.size - cube.edges.size + cube.faces.size).toBe(2);
    expect(cube.verts.size).toBe(7);
  });
});

describe('dissolvable edges', () => {
  it('rejects a cube edge, whose faces meet at 90 degrees', () => {
    const cube = createBox(2);
    for (const edge of cube.edges.values()) {
      expect(isDissolvableEdge(cube, edge)).toBe(false);
    }
  });

  it('accepts an edge between coplanar faces', () => {
    const plane = createPlane(2);
    const [a, , c] = plane.faceVerts([...plane.faces.values()][0]);
    connectVerts(plane, a, c);

    const seam = plane.findEdge(a, c);
    expect(seam).not.toBeNull();
    expect(seam && isDissolvableEdge(plane, seam)).toBe(true);
  });

  it("accepts a cylinder's gently folded side seams", () => {
    const cylinder = createCylinder(1, 2, 24, true);
    const side = [...cylinder.edges.values()].filter((edge) => {
      const faces = cylinder.edgeFaces(edge);
      return faces.length === 2 && faces.every((face) => Math.abs(face.normal.y) < 0.01);
    });

    expect(side.length).toBeGreaterThan(0);
    for (const edge of side) expect(isDissolvableEdge(cylinder, edge)).toBe(true);
  });

  it('honours a caller-supplied limit', () => {
    const cube = createBox(2);
    const edge = [...cube.edges.values()][0];

    expect(isDissolvableEdge(cube, edge, 95)).toBe(true);
  });

  it('allows an edge midpoint however sharply its two faces meet', () => {
    const cube = createBox(2);
    const [midpoint] = subdivideEdges(cube, [[...cube.edges.values()][0]]);

    // Two edges, so removing it merges nothing — the cube's 90° fold is irrelevant.
    expect(midpoint.edges).toHaveLength(2);
    expect(isDissolvableVert(cube, midpoint)).toBe(true);
  });

  it('round-trips: subdividing an edge then dissolving the midpoint restores the cube', () => {
    const cube = createBox(2);
    const [midpoint] = subdivideEdges(cube, [[...cube.edges.values()][0]]);
    expect(cube.verts.size).toBe(9);

    dissolveVerts(cube, [midpoint]);

    expect(cube.verts.size).toBe(8);
    expect(cube.edges.size).toBe(12);
    expect(cube.faces.size).toBe(6);
    // Every face is a quad again — the two 5-gons were trimmed, not merged.
    for (const face of cube.faces.values()) expect(cube.faceVerts(face)).toHaveLength(4);
    expect(cube.validate()).toEqual([]);
  });

  it('trims an edge midpoint out of the single face using it', () => {
    const plane = createPlane(2);
    const [midpoint] = subdivideEdges(plane, [[...plane.edges.values()][0]]);

    dissolveVerts(plane, [midpoint]);

    expect(plane.verts.size).toBe(4);
    expect(plane.faces.size).toBe(1);
    expect(plane.validate()).toEqual([]);
  });

  it('rejects a cube corner, where three perpendicular faces meet', () => {
    const cube = createBox(2);
    for (const vert of cube.verts.values()) {
      expect(isDissolvableVert(cube, vert)).toBe(false);
    }
  });

  it("accepts a flat grid's interior vertex, which is what vertex dissolve is for", () => {
    const grid = createGrid(2, 2);
    const interior = [...grid.verts.values()].filter((vert) => grid.vertFaces(vert).length === 4);

    expect(interior).toHaveLength(1);
    expect(isDissolvableVert(grid, interior[0])).toBe(true);
  });

  it('accepts a vertex with nothing around it to fold', () => {
    const mesh = new BMesh();
    const loose = mesh.addVert(vec3(0, 0, 0));

    expect(isDissolvableVert(mesh, loose)).toBe(true);
  });

  it('honours a caller-supplied limit for vertices too', () => {
    const cube = createBox(2);
    const vert = [...cube.verts.values()][0];

    expect(isDissolvableVert(cube, vert, 95)).toBe(true);
  });

  it('leaves a boundary edge alone: it has no second face to merge with', () => {
    const plane = createPlane(2);
    const edge = [...plane.edges.values()][0];

    expect(isDissolvableEdge(plane, edge)).toBe(false);
  });
});

describe('connect verts', () => {
  it('splits a face into two along the new edge', () => {
    const plane = createPlane(2);
    const [a, , c] = plane.faceVerts([...plane.faces.values()][0]);

    const result = connectVerts(plane, a, c);

    expect(result.reason).toBe('split');
    // One quad becomes two triangles sharing the new edge.
    expect(plane.faces.size).toBe(2);
    expect(plane.findEdge(a, c)).not.toBeNull();
    for (const face of plane.faces.values()) expect(plane.faceVerts(face)).toHaveLength(3);
    expect(plane.validate()).toEqual([]);
  });

  it('keeps the parent winding on both halves', () => {
    const plane = createPlane(2);
    const original = [...plane.faces.values()][0].normal;
    const [a, , c] = plane.faceVerts([...plane.faces.values()][0]);

    connectVerts(plane, a, c);

    for (const face of plane.faces.values()) {
      const alignment =
        face.normal.x * original.x + face.normal.y * original.y + face.normal.z * original.z;
      expect(alignment).toBeGreaterThan(0.99);
    }
  });

  it('adds a bare edge when the vertices share no face', () => {
    const mesh = new BMesh();
    const a = mesh.addVert(vec3(0, 0, 0));
    const b = mesh.addVert(vec3(1, 0, 0));

    const result = connectVerts(mesh, a, b);

    expect(result.reason).toBe('bare');
    expect(result.faces).toEqual([]);
    expect(mesh.findEdge(a, b)).not.toBeNull();
    expect(mesh.validate()).toEqual([]);
  });

  it('refuses vertices that an edge already joins', () => {
    const plane = createPlane(2);
    const [a, b] = plane.faceVerts([...plane.faces.values()][0]);

    const result = connectVerts(plane, a, b);

    expect(result.reason).toBe('connected');
    expect(result.faces).toEqual([]);
    expect(plane.faces.size).toBe(1);
  });

  it('splits only the shared face, leaving the rest of the mesh alone', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));
    const [a, , c] = cube.faceVerts(top);

    connectVerts(cube, a, c);

    expect(cube.faces.size).toBe(7);
    expect(cube.validate()).toEqual([]);
  });
});

describe('delete and dissolve', () => {
  it('deletes faces and the edges only they used', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));

    deleteGeometry(cube, { verts: [], edges: [], faces: [top] }, 'faces');

    expect(cube.faces.size).toBe(5);
    expect(cube.verts.size).toBe(8);
    expect(cube.edges.size).toBe(12);
    expect(cube.validate()).toEqual([]);
  });

  it('deletes vertices and everything attached to them', () => {
    const cube = createBox(2);
    const vert = [...cube.verts.values()][0];

    deleteGeometry(cube, { verts: [vert], edges: [], faces: [] }, 'verts');

    expect(cube.verts.size).toBe(7);
    expect(cube.faces.size).toBe(3);
    expect(cube.validate()).toEqual([]);
  });

  it('dissolves an edge into a single n-gon', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));
    const shared = cube.faceEdges(top)[0];

    const merged = dissolveEdges(cube, [shared]);

    expect(merged).toHaveLength(1);
    expect(cube.faceLoops(merged[0])).toHaveLength(6);
    expect(cube.faces.size).toBe(5);
    expect(cube.edges.size).toBe(11);
    expect(cube.validate()).toEqual([]);
  });

  it('dissolves a face region into one face', () => {
    const cube = createBox(2);
    subdivideFaces(cube, [faceAt(cube, vec3(0, 1, 0))], { cuts: 1 });
    const quads = [...cube.faces.values()].filter((face) => face.normal.y > 0.99);

    dissolveFaces(cube, quads);

    expect([...cube.faces.values()].filter((face) => face.normal.y > 0.99)).toHaveLength(1);
    expect(cube.validate()).toEqual([]);
  });

  it('flattens coplanar triangulation with limited dissolve', () => {
    const cube = createBox(2);
    triangulateFaces(cube, [...cube.faces.values()]);
    expect(cube.faces.size).toBe(12);

    limitedDissolve(cube, 1);

    expect(cube.faces.size).toBe(6);
    expect(cube.validate()).toEqual([]);
  });
});

describe('fill and bridge', () => {
  it('fills an open boundary loop', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));
    const ring = cube.faceEdges(top);
    deleteGeometry(cube, { verts: [], edges: [], faces: [top] }, 'onlyFaces');
    expect(isClosed(cube)).toBe(false);

    const filled = fillHole(cube, ring);

    expect(filled).toHaveLength(1);
    expect(isClosed(cube)).toBe(true);
    expect(cube.faceVerts(filled[0])).toHaveLength(4);
    expect(cube.validate()).toEqual([]);
  });

  it('winds the fill to match the surrounding surface', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));
    const ring = cube.faceEdges(top);
    deleteGeometry(cube, { verts: [], edges: [], faces: [top] }, 'onlyFaces');

    const filled = fillHole(cube, ring);

    expect(filled[0].normal.y).toBeCloseTo(1);
  });

  it('bridges two open loops with a band of quads', () => {
    const lower = createPlane(2);
    const upper = createPlane(2);
    for (const vert of upper.verts.values()) vert.co = { ...vert.co, y: 2 };

    const mesh = new BMesh();
    const lowerRing = [...lower.verts.values()].map((vert) => mesh.addVert(vert.co));
    const upperRing = [...upper.verts.values()].map((vert) => mesh.addVert(vert.co));
    const edges = [];
    for (let i = 0; i < 4; i++) {
      edges.push(mesh.addEdge(lowerRing[i], lowerRing[(i + 1) % 4]));
      edges.push(mesh.addEdge(upperRing[i], upperRing[(i + 1) % 4]));
    }

    const bridged = bridgeEdgeLoops(mesh, edges);

    expect(bridged).toHaveLength(4);
    expect(mesh.faces.size).toBe(4);
    expect(mesh.validate()).toEqual([]);
  });
});

describe('normals', () => {
  it('flips a face winding', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));

    const [flipped] = flipNormals(cube, [top]);

    expect(flipped.normal.y).toBeCloseTo(-1);
    expect(cube.validate()).toEqual([]);
  });

  it('recalculates a single inverted face back outward', () => {
    const cube = createBox(2);
    flipNormals(cube, [faceAt(cube, vec3(0, 1, 0))]);

    recalculateNormals(cube, true);

    for (const face of cube.faces.values()) {
      const center = cube.faceCenter(face);
      const outward =
        center.x * face.normal.x + center.y * face.normal.y + center.z * face.normal.z;
      expect(outward).toBeGreaterThan(0);
    }
    expect(cube.validate()).toEqual([]);
  });

  it('re-inverts a fully inside-out mesh', () => {
    const cube = createBox(2);
    flipNormals(cube, [...cube.faces.values()]);

    recalculateNormals(cube, true);

    for (const face of cube.faces.values()) {
      const center = cube.faceCenter(face);
      const outward =
        center.x * face.normal.x + center.y * face.normal.y + center.z * face.normal.z;
      expect(outward).toBeGreaterThan(0);
    }
  });

  it('can point normals inward on request', () => {
    const cube = createBox(2);

    recalculateNormals(cube, false);

    for (const face of cube.faces.values()) {
      const center = cube.faceCenter(face);
      const outward =
        center.x * face.normal.x + center.y * face.normal.y + center.z * face.normal.z;
      expect(outward).toBeLessThan(0);
    }
  });
});

describe('transform', () => {
  it('translates only the selected vertices', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));
    const verts = cube.faceVerts(top);

    translateVerts(cube, verts, vec3(0, 2, 0));

    for (const vert of verts) expect(vert.co.y).toBeCloseTo(3);
    expect(cube.boundingBox().min.y).toBeCloseTo(-1);
  });

  it('rotates about a pivot', () => {
    const cube = createBox(2);
    const verts = [...cube.verts.values()];

    rotateVerts(cube, verts, vec3(0, 1, 0), Math.PI / 2, vec3(0, 0, 0));

    const box = cube.boundingBox();
    expect(box.min.x).toBeCloseTo(-1);
    expect(box.max.z).toBeCloseTo(1);
  });

  it('scales about a pivot', () => {
    const cube = createBox(2);

    scaleVerts(cube, [...cube.verts.values()], vec3(2, 1, 1), vec3(0, 0, 0));

    expect(cube.boundingBox().max.x).toBeCloseTo(2);
    expect(cube.boundingBox().max.y).toBeCloseTo(1);
  });

  it('spreads a move through the falloff radius when proportional editing is on', () => {
    const grid = createGrid(4, 4);
    const corner = [...grid.verts.values()][0];

    translateVerts(grid, [corner], vec3(0, 1, 0), {
      enabled: true,
      radius: 2,
      falloff: 'smooth',
    });

    const moved = [...grid.verts.values()].filter((vert) => vert.co.y > 0.001);
    expect(moved.length).toBeGreaterThan(1);
    expect(corner.co.y).toBeCloseTo(1);
  });
});

describe('selection walks', () => {
  it('follows an edge loop across valence-4 vertices', () => {
    const grid = createGrid(4, 4);
    const interior = [...grid.edges.values()].find(
      (edge) => edge.v0.edges.length === 4 && edge.v1.edges.length === 4,
    );
    expect(interior).toBeDefined();

    const loop = selectEdgeLoop(grid, interior as never);

    expect(loop.length).toBeGreaterThan(1);
    // A grid row loop runs straight, so one axis stays constant along it.
    const constantAxis = loop.every((edge) => edge.v0.co.z === edge.v1.co.z);
    const otherAxis = loop.every((edge) => edge.v0.co.x === edge.v1.co.x);
    expect(constantAxis || otherAxis).toBe(true);
  });

  it('stops an edge loop at a pole', () => {
    const cylinder = createCylinder(1, 2, 8, false);
    const vertical = [...cylinder.edges.values()].find(
      (edge) => Math.abs(edge.v0.co.y - edge.v1.co.y) > 1,
    );
    expect(vertical).toBeDefined();

    // An open tube's rim is valence 3, so the vertical loop cannot continue.
    expect(selectEdgeLoop(cylinder, vertical as never)).toHaveLength(1);
  });

  it('brings back one loop whole from a stroke of edges along it', () => {
    const grid = createGrid(4, 4);
    const row = [...grid.edges.values()].filter(
      (edge) => edge.v0.co.z === 0 && edge.v1.co.z === 0 && edge.v0.co.x !== edge.v1.co.x,
    );
    expect(row.length).toBe(4);

    // Two edges of the row, out of the four it takes to cross the grid.
    const loop = selectEdgeLoops(grid, [row[0], row[1]]);

    expect(new Set(loop)).toEqual(new Set(row));
  });

  it('brings back one loop each from edges lying on different ones', () => {
    const grid = createGrid(4, 4);
    const across = [...grid.edges.values()].find(
      (edge) => edge.v0.co.z === 0 && edge.v1.co.z === 0 && edge.v0.co.x !== edge.v1.co.x,
    );
    const along = [...grid.edges.values()].find(
      (edge) => edge.v0.co.x === 0 && edge.v1.co.x === 0 && edge.v0.co.z !== edge.v1.co.z,
    );
    if (!across || !along) throw new Error('no interior edges');

    const loop = selectEdgeLoops(grid, [across, along]);

    expect(loop).toHaveLength(8);
  });

  it('reads two edges that meet as a stroke, and two that never do as neither', () => {
    const cube = createBox(2);
    const [first] = [...cube.edges.values()];
    const touching = [...cube.edges.values()].find(
      (edge) => edge !== first && (edge.v0 === first.v0 || edge.v1 === first.v0),
    );
    const apart = [...cube.edges.values()].find(
      (edge) =>
        edge.v0 !== first.v0 &&
        edge.v1 !== first.v0 &&
        edge.v0 !== first.v1 &&
        edge.v1 !== first.v1,
    );
    if (!touching || !apart) throw new Error('no such pair');

    expect(hasConnectedEdges([first, touching])).toBe(true);
    expect(hasConnectedEdges([first, apart])).toBe(false);
    expect(hasConnectedEdges([first])).toBe(false);
  });

  it('names a face loop from the edge nearest the click', () => {
    const grid = createGrid(4, 4);
    const face = faceAtCenter(grid, vec3(-0.5, 0, -0.5));

    const across = faceLoopAtClick(grid, face, vec3(-0.9, 0, -0.5));
    const along = faceLoopAtClick(grid, face, vec3(-0.5, 0, -0.9));

    expect(across.every((member) => grid.faceCenter(member).z === -0.5)).toBe(true);
    expect(along.every((member) => grid.faceCenter(member).x === -0.5)).toBe(true);
  });

  it('names the same face loop however much is already selected', () => {
    const grid = createGrid(8, 8);
    const clicked = faceAtCenter(grid, vec3(-2.5, 0, -2.5));
    const wanted = faceLoopAtClick(grid, clicked, vec3(-2.9, 0, -2.5));

    // The row below and the column beside, as earlier Shift+Alt clicks would
    // leave things. A selected neighbour on one edge of the clicked face used
    // to rename its loop, and once a second edge had one the click stopped
    // selecting anything new at all.
    const below = faceLoopAtClick(
      grid,
      faceAtCenter(grid, vec3(-2.5, 0, -3.5)),
      vec3(-2.9, 0, -3.5),
    );
    const beside = faceLoopAtClick(
      grid,
      faceAtCenter(grid, vec3(-3.5, 0, -2.5)),
      vec3(-3.5, 0, -2.9),
    );
    for (const face of [...below, ...beside]) face.selected = true;

    const loop = faceLoopAtClick(grid, clicked, vec3(-2.9, 0, -2.5));

    expect(loop).toEqual(wanted);
    expect(loop.some((face) => !face.selected)).toBe(true);
  });

  it('names no face loop through a triangle', () => {
    const disc = createCircle(1, 6, true);
    const [face] = [...disc.faces.values()];

    expect(faceLoopAtClick(disc, face)).toHaveLength(0);
  });

  it('walks the ring of edges a loop cut would cross', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));

    const ring = selectEdgeRing(cube, cube.faceEdges(top)[0]);

    expect(ring).toHaveLength(4);
  });

  it('flood fills across connected geometry only', () => {
    const cube = createBox(2);
    const island = cube.addVert(vec3(9, 9, 9));

    const linked = selectLinked(cube, [[...cube.verts.values()][0]]);

    expect(linked).toHaveLength(8);
    expect(linked).not.toContain(island);
  });
});
