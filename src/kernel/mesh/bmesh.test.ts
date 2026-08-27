import { describe, expect, it } from 'vitest';

import { vec3 } from '../math';
import {
  createBox,
  createCapsule,
  createCylinder,
  createGrid,
  createUVSphere,
} from '../primitives';

import { BMesh } from './bmesh';
import { cloneMesh, deserializeMesh, serializeMesh, splitLooseParts } from './serialize';
import { triangulatePolygon } from './triangulate';

describe('BMesh', () => {
  it('builds a quad with a closed loop cycle', () => {
    const mesh = new BMesh();
    const a = mesh.addVert(vec3(0, 0, 0));
    const b = mesh.addVert(vec3(1, 0, 0));
    const c = mesh.addVert(vec3(1, 0, 1));
    const d = mesh.addVert(vec3(0, 0, 1));
    const face = mesh.addFace([a, b, c, d]);

    expect(mesh.faceLoops(face)).toHaveLength(4);
    expect(mesh.edges.size).toBe(4);
    expect(mesh.validate()).toEqual([]);
  });

  it('reuses an existing edge instead of duplicating it', () => {
    const mesh = new BMesh();
    const a = mesh.addVert(vec3(0, 0, 0));
    const b = mesh.addVert(vec3(1, 0, 0));

    expect(mesh.addEdge(a, b)).toBe(mesh.addEdge(b, a));
    expect(mesh.edges.size).toBe(1);
  });

  it('tracks the radial set so two faces share one edge', () => {
    const mesh = new BMesh();
    const a = mesh.addVert(vec3(0, 0, 0));
    const b = mesh.addVert(vec3(1, 0, 0));
    const c = mesh.addVert(vec3(1, 0, 1));
    const d = mesh.addVert(vec3(0, 0, 1));
    const e = mesh.addVert(vec3(2, 0, 0));
    const f = mesh.addVert(vec3(2, 0, 1));

    mesh.addFace([a, b, c, d]);
    mesh.addFace([b, e, f, c]);

    const shared = mesh.findEdge(b, c);
    expect(shared).not.toBeNull();
    expect(shared?.loops).toHaveLength(2);
    expect(mesh.isBoundaryEdge(shared as never)).toBe(false);
    expect(mesh.validate()).toEqual([]);
  });

  it('unlinks loops from the radial set when a face is removed', () => {
    const mesh = createBox(2);
    const face = [...mesh.faces.values()][0];
    const edges = mesh.faceEdges(face);

    mesh.removeFace(face);

    expect(mesh.faces.size).toBe(5);
    for (const edge of edges) expect(edge.loops).toHaveLength(1);
    expect(mesh.validate()).toEqual([]);
  });

  it('cascades removal from vertex to edges to faces', () => {
    const mesh = createBox(2);
    const vert = [...mesh.verts.values()][0];

    mesh.removeVert(vert);

    expect(mesh.verts.size).toBe(7);
    expect(mesh.faces.size).toBe(3);
    expect(mesh.validate()).toEqual([]);
  });
});

describe('primitives', () => {
  it('creates a cube with Euler-consistent counts and outward normals', () => {
    const mesh = createBox(2);

    expect(mesh.verts.size).toBe(8);
    expect(mesh.edges.size).toBe(12);
    expect(mesh.faces.size).toBe(6);
    expect(mesh.validate()).toEqual([]);

    // Every face normal on a convex solid points away from the centre.
    for (const face of mesh.faces.values()) {
      const center = mesh.faceCenter(face);
      const outward =
        center.x * face.normal.x + center.y * face.normal.y + center.z * face.normal.z;
      expect(outward).toBeGreaterThan(0);
    }
  });

  it.each([
    ['cylinder', () => createCylinder(1, 2, 12, true)],
    ['uv sphere', () => createUVSphere(1, 12, 6)],
    ['capsule', () => createCapsule(1, 4, 12, 6)],
    ['grid', () => createGrid(2, 4)],
  ])('builds %s with valid topology', (_name, build) => {
    const mesh = build();
    expect(mesh.validate()).toEqual([]);
    expect(mesh.faces.size).toBeGreaterThan(0);
  });

  it('points closed primitive normals outward', () => {
    const mesh = createUVSphere(1, 16, 8);
    for (const face of mesh.faces.values()) {
      const center = mesh.faceCenter(face);
      const outward =
        center.x * face.normal.x + center.y * face.normal.y + center.z * face.normal.z;
      expect(outward).toBeGreaterThan(0);
    }
  });
});

describe('capsule', () => {
  it('spans the requested height and stays closed', () => {
    const mesh = createCapsule(1, 5, 16, 8);
    expect(mesh.validate()).toEqual([]);

    const ys = [...mesh.verts.values()].map((vert) => vert.co.y);
    expect(Math.max(...ys)).toBeCloseTo(2.5);
    expect(Math.min(...ys)).toBeCloseTo(-2.5);

    // A closed surface has no boundary: every edge is shared by two faces.
    for (const edge of mesh.edges.values()) expect(edge.loops).toHaveLength(2);

    for (const face of mesh.faces.values()) {
      const center = mesh.faceCenter(face);
      const outward =
        center.x * face.normal.x + center.y * face.normal.y + center.z * face.normal.z;
      expect(outward).toBeGreaterThan(0);
    }
  });

  it('collapses to a sphere once the height drops to the diameter', () => {
    const mesh = createCapsule(1, 2, 16, 8);
    for (const vert of mesh.verts.values()) {
      expect(Math.hypot(vert.co.x, vert.co.y, vert.co.z)).toBeCloseTo(1);
    }
  });
});

describe('triangulation', () => {
  it('emits n-2 triangles for a convex polygon', () => {
    const points = [vec3(0, 0, 0), vec3(2, 0, 0), vec3(2, 0, 2), vec3(1, 0, 3), vec3(0, 0, 2)];
    const indices = triangulatePolygon(points, vec3(0, -1, 0));
    expect(indices).toHaveLength((points.length - 2) * 3);
  });

  it('keeps triangle winding aligned with the polygon', () => {
    // This ring runs +x then +z, which winds to -Y; every triangle must agree.
    const points = [vec3(0, 0, 0), vec3(1, 0, 0), vec3(1, 0, 1), vec3(0, 0, 1)];
    const indices = triangulatePolygon(points, vec3(0, -1, 0));

    expect(indices.length).toBeGreaterThan(0);
    for (let i = 0; i < indices.length; i += 3) {
      const a = points[indices[i]];
      const b = points[indices[i + 1]];
      const c = points[indices[i + 2]];
      const normalY = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
      expect(normalY).toBeLessThan(0);
    }
  });

  it('handles a concave polygon without dropping area', () => {
    const points = [vec3(0, 0, 0), vec3(3, 0, 0), vec3(3, 0, 3), vec3(1.5, 0, 1), vec3(0, 0, 3)];
    const indices = triangulatePolygon(points, vec3(0, -1, 0));
    expect(indices).toHaveLength(9);
  });
});

describe('serialization', () => {
  it('round-trips topology, materials and selection', () => {
    const mesh = createBox(2);
    const face = [...mesh.faces.values()][2];
    face.selected = true;
    face.materialIndex = 3;
    face.smooth = true;
    mesh.flushSelection('face');

    const restored = deserializeMesh(serializeMesh(mesh));

    expect(restored.verts.size).toBe(mesh.verts.size);
    expect(restored.edges.size).toBe(mesh.edges.size);
    expect(restored.faces.size).toBe(mesh.faces.size);
    expect(restored.selectedFaces()).toHaveLength(1);
    expect(restored.selectedVerts()).toHaveLength(4);
    expect([...restored.faces.values()].some((f) => f.materialIndex === 3 && f.smooth)).toBe(true);
    expect(restored.validate()).toEqual([]);
  });

  it('round-trips vertex selection order', () => {
    const mesh = createBox(2);
    const face = [...mesh.faces.values()][2];
    // Select the corners newest-first, the reverse of the order the mesh
    // created them, so a restored click order cannot be confused with the
    // iteration order the round-trip itself rebuilds.
    const picked = [...mesh.faceVerts(face)].sort((a, b) => b.id - a.id);
    for (const vert of picked) mesh.selectVert(vert);

    const restored = deserializeMesh(serializeMesh(mesh));
    const order = restored
      .selectedVerts()
      .sort((a, b) => a.selectSeq - b.selectSeq)
      .map((vert) => vert.id);

    expect(order).toEqual(picked.map((vert) => vert.id));
    expect(restored.selectedVerts().every((vert) => vert.selectSeq > 0)).toBe(true);
  });

  it('leaves selection order unset for vertices that were never click-selected', () => {
    const mesh = createBox(2);
    for (const vert of mesh.verts.values()) vert.selected = true;

    const restored = deserializeMesh(serializeMesh(mesh));

    expect(restored.selectedVerts()).toHaveLength(mesh.verts.size);
    expect(restored.selectedVerts().every((vert) => vert.selectSeq === 0)).toBe(true);
  });

  it('preserves wire edges that belong to no face', () => {
    const mesh = new BMesh();
    const a = mesh.addVert(vec3(0, 0, 0));
    const b = mesh.addVert(vec3(1, 0, 0));
    mesh.addEdge(a, b);

    const restored = cloneMesh(mesh);

    expect(restored.edges.size).toBe(1);
    expect(restored.verts.size).toBe(2);
  });

  it('leaves a mesh that is all one piece alone', () => {
    expect(splitLooseParts(createBox(1))).toHaveLength(1);
  });

  it('splits a mesh into one part per loose shell', () => {
    const mesh = createBox(1);
    // A quad off on its own: touching nothing, so a part of its own.
    const a = mesh.addVert(vec3(5, 0, 0));
    const b = mesh.addVert(vec3(6, 0, 0));
    const c = mesh.addVert(vec3(6, 1, 0));
    const d = mesh.addVert(vec3(5, 1, 0));
    mesh.addFace([a, b, c, d], { materialIndex: 2, smooth: true });

    const parts = splitLooseParts(mesh);

    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.faces.size).sort()).toEqual([1, 6]);
    expect(parts.map((part) => part.verts.size).sort((x, y) => x - y)).toEqual([4, 8]);

    // The loose quad keeps what it was carrying: slot and shading come across.
    const quad = parts.find((part) => part.faces.size === 1);
    const face = [...(quad?.faces.values() ?? [])][0];
    expect(face.materialIndex).toBe(2);
    expect(face.smooth).toBe(true);
    for (const part of parts) expect(part.validate()).toEqual([]);
  });

  it('counts a vertex joined by nothing as its own part', () => {
    const mesh = createBox(1);
    mesh.addVert(vec3(9, 9, 9));

    const parts = splitLooseParts(mesh);

    expect(parts).toHaveLength(2);
    expect(parts.some((part) => part.verts.size === 1 && part.faces.size === 0)).toBe(true);
  });

  it('keeps a wire edge with the shell it joins', () => {
    const mesh = new BMesh();
    const a = mesh.addVert(vec3(0, 0, 0));
    const b = mesh.addVert(vec3(1, 0, 0));
    mesh.addEdge(a, b);
    const c = mesh.addVert(vec3(5, 0, 0));
    const d = mesh.addVert(vec3(6, 0, 0));
    mesh.addEdge(c, d);

    const parts = splitLooseParts(mesh);

    expect(parts).toHaveLength(2);
    for (const part of parts) expect(part.edges.size).toBe(1);
  });

  it('produces an independent copy', () => {
    const mesh = createBox(2);
    const copy = cloneMesh(mesh);
    const original = [...mesh.verts.values()][0];
    original.co = vec3(99, 99, 99);

    expect([...copy.verts.values()][0].co.x).toBe(-1);
  });
});
