import { describe, expect, it } from 'vitest';

import { type Vec3, vec3 } from '../math';
import { createBox, createCylinder, createPlane, createUVSphere } from '../primitives';

import { BMesh } from './bmesh';
import { inspectMesh } from './inspect';

const CORNERS: Vec3[] = [
  vec3(-0.5, -0.5, -0.5),
  vec3(0.5, -0.5, -0.5),
  vec3(0.5, -0.5, 0.5),
  vec3(-0.5, -0.5, 0.5),
  vec3(-0.5, 0.5, -0.5),
  vec3(0.5, 0.5, -0.5),
  vec3(0.5, 0.5, 0.5),
  vec3(-0.5, 0.5, 0.5),
];

/** The faces of `createBox`, each wound to face out. */
const BOX_FACES = [
  [0, 1, 2, 3],
  [7, 6, 5, 4],
  [1, 0, 4, 5],
  [3, 2, 6, 7],
  [2, 1, 5, 6],
  [0, 3, 7, 4],
];

/** A box built by hand, with the faces `turned` wound the other way. */
function box(turned: (index: number) => boolean = () => false): BMesh {
  const mesh = new BMesh();
  const verts = CORNERS.map((corner) => mesh.addVert(corner));
  BOX_FACES.forEach((face, index) => {
    const order = turned(index) ? [...face].reverse() : face;
    mesh.addFace(order.map((i) => verts[i]));
  });
  return mesh;
}

describe('inspectMesh', () => {
  it('finds nothing wrong with a closed box of quads', () => {
    const report = inspectMesh(createBox());
    expect(report).toMatchObject({
      verts: 8,
      edges: 12,
      faces: 6,
      tris: 12,
      quads: 6,
      triangles: 0,
      ngons: 0,
      maxSides: 4,
      nonManifoldEdges: 0,
      boundaryEdges: 0,
      wireEdges: 0,
      looseVerts: 0,
      degenerateFaces: 0,
      duplicateVerts: 0,
      flippedEdges: 0,
      shells: 1,
      insideOutShells: 0,
      twoEdgeVerts: 0,
      twistedQuads: 0,
      materials: 1,
    });
    // Every corner of a box has three edges.
    expect(report.poles).toEqual({ three: 8, five: 0, sixPlus: 0 });
  });

  it('counts the caps of a cylinder as n-gons', () => {
    const report = inspectMesh(createCylinder(0.5, 1, 8));
    expect(report.ngons).toBe(2);
    expect(report.maxSides).toBe(8);
    expect(report.quads).toBe(8);
    expect(report.tris).toBe(8 * 2 + 2 * 6);
  });

  it('counts the poles a sphere gathers its rings into', () => {
    const report = inspectMesh(createUVSphere(0.5, 12, 6));
    expect(report.poles.sixPlus).toBe(2);
    expect(report.triangles).toBe(24);
    expect(report.ngons).toBe(0);
  });

  it('counts the rim of an open sheet as boundary, and none of its corners as poles', () => {
    const report = inspectMesh(createPlane());
    expect(report.boundaryEdges).toBe(4);
    expect(report.poles).toEqual({ three: 0, five: 0, sixPlus: 0 });
    expect(report.shells).toBe(1);
    expect(report.insideOutShells).toBe(0);
  });

  it('finds the edges round a face wound the wrong way', () => {
    const report = inspectMesh(box((index) => index === 0));
    expect(report.flippedEdges).toBe(4);
    expect(report.boundaryEdges).toBe(0);
  });

  it('finds a closed shell that faces inward', () => {
    const report = inspectMesh(box(() => true));
    expect(report.flippedEdges).toBe(0);
    expect(report.insideOutShells).toBe(1);
  });

  it('finds an edge three faces share', () => {
    const mesh = new BMesh();
    const a = mesh.addVert(vec3(0, 0, 0));
    const b = mesh.addVert(vec3(0, 1, 0));
    for (const [x, z] of [
      [1, 0],
      [-1, 0],
      [0, 1],
    ]) {
      mesh.addFace([a, b, mesh.addVert(vec3(x, 1, z)), mesh.addVert(vec3(x, 0, z))]);
    }
    expect(inspectMesh(mesh).nonManifoldEdges).toBe(1);
  });

  it('finds loose points, loose edges and points stacked on others', () => {
    const mesh = box();
    for (const corner of CORNERS.slice(0, 2)) mesh.addVert(corner);
    mesh.addVert(vec3(3, 0, 0));
    mesh.addEdge(mesh.addVert(vec3(4, 0, 0)), mesh.addVert(vec3(5, 0, 0)));
    const report = inspectMesh(mesh);
    expect(report.duplicateVerts).toBe(2);
    expect(report.looseVerts).toBe(3);
    expect(report.wireEdges).toBe(1);
    expect(report.shells).toBe(1);
  });

  it('counts each separate piece once', () => {
    const mesh = box();
    const far = CORNERS.map((corner) => mesh.addVert(vec3(corner.x + 3, corner.y, corner.z)));
    for (const face of BOX_FACES) mesh.addFace(face.map((i) => far[i]));
    const report = inspectMesh(mesh);
    expect(report.shells).toBe(2);
    expect(report.duplicateVerts).toBe(0);
  });

  it('finds a twisted quad and a face with no area', () => {
    const mesh = new BMesh();
    mesh.addFace([
      mesh.addVert(vec3(0, 0, 0)),
      mesh.addVert(vec3(1, 0, 0)),
      mesh.addVert(vec3(1, 0.4, 1)),
      mesh.addVert(vec3(0, 0, 1)),
    ]);
    mesh.addFace([
      mesh.addVert(vec3(3, 0, 0)),
      mesh.addVert(vec3(4, 0, 0)),
      mesh.addVert(vec3(5, 0, 0)),
    ]);
    const report = inspectMesh(mesh);
    expect(report.twistedQuads).toBe(1);
    expect(report.degenerateFaces).toBe(1);
  });
});
