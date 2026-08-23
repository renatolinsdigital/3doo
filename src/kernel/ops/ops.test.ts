import { beforeEach, describe, expect, it } from 'vitest';

import { type Vec3, vec3 } from '../math';
import { BMesh } from '../mesh';
import type { Face } from '../mesh/types';
import { createBox, createCylinder, createGrid, createPlane } from '../primitives';

import { bevelEdges } from './bevel';
import { deleteGeometry } from './delete';
import { dissolveEdges, dissolveFaces, limitedDissolve } from './dissolve';
import { extrudeFaces } from './extrude';
import { bridgeEdgeLoops, fillHole } from './fill';
import { insetFaces } from './inset';
import { loopCut } from './loopcut';
import { countMergeByDistance, mergeByDistance, mergeVerts } from './merge';
import { flipNormals, recalculateNormals } from './normals';
import { subdivideFaces, triangulateFaces, trisToQuads } from './subdivide';
import { rotateVerts, scaleVerts, translateVerts } from './transform';
import { selectEdgeLoop, selectEdgeRing, selectLinked } from './select';

/** Euler characteristic of a closed manifold surface is 2 per shell. */
function eulerCharacteristic(mesh: BMesh): number {
  return mesh.verts.size - mesh.edges.size + mesh.faces.size;
}

function isClosed(mesh: BMesh): boolean {
  return [...mesh.edges.values()].every((edge) => edge.loops.length === 2);
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

  it('keeps neighbouring faces watertight on a partial selection', () => {
    const cube = createBox(2);
    const top = faceAt(cube, vec3(0, 1, 0));

    subdivideFaces(cube, [top], { cuts: 1 });

    expect(isClosed(cube)).toBe(true);
    expect(eulerCharacteristic(cube)).toBe(2);
    expect(cube.faces.size).toBe(4 + 5);
    expect(cube.validate()).toEqual([]);
  });

  it('pulls corners toward the limit surface when smoothing', () => {
    const cube = createBox(2);
    const cornerDistance = Math.sqrt(3);

    subdivideFaces(cube, [...cube.faces.values()], { cuts: 1, smooth: 1 });

    // Catmull-Clark leaves face points on the face centres, so the bounding box
    // still touches 1. What must shrink is the corners it rounds off.
    const furthest = Math.max(
      ...[...cube.verts.values()].map((vert) =>
        Math.hypot(vert.co.x, vert.co.y, vert.co.z),
      ),
    );
    expect(furthest).toBeLessThan(cornerDistance);
    expect(cube.validate()).toEqual([]);
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
