import { describe, expect, it } from 'vitest';

import { BMesh } from '../mesh';
import { createBox, createGrid, createUVSphere } from '../primitives';

import {
  DEFAULT_REMESH_SETTINGS,
  type RemeshSettings,
  faceKinds,
  remeshMesh,
  voxelSizeForFaces,
} from './index';
import { decimateMesh } from './simplify';
import { SurfaceIndex, buildSurface, surfaceArea, surfaceBounds } from './surface';

function settings(patch: Partial<RemeshSettings> = {}): RemeshSettings {
  return { ...DEFAULT_REMESH_SETTINGS, ...patch };
}

/** Closed and manifold: every edge is shared by exactly two faces. */
function openEdges(mesh: BMesh): number {
  let open = 0;
  for (const edge of mesh.edges.values()) if (edge.loops.length !== 2) open++;
  return open;
}

function bounds(mesh: BMesh) {
  return surfaceBounds(buildSurface(mesh));
}

describe('surface sampling', () => {
  it('turns every face into triangles with outward normals', () => {
    const triangles = buildSurface(createBox(2));

    expect(triangles).toHaveLength(12);
    for (const triangle of triangles) {
      // The box is centred on the origin, so an outward normal points away
      // from it at every corner of every triangle.
      const centre = {
        x: (triangle.a.x + triangle.b.x + triangle.c.x) / 3,
        y: (triangle.a.y + triangle.b.y + triangle.c.y) / 3,
        z: (triangle.a.z + triangle.b.z + triangle.c.z) / 3,
      };
      const outward =
        centre.x * triangle.na.x + centre.y * triangle.na.y + centre.z * triangle.na.z;
      expect(outward).toBeGreaterThan(0);
    }
  });

  it('measures the area of a unit box as six faces', () => {
    expect(surfaceArea(buildSurface(createBox(1)))).toBeCloseTo(6, 6);
  });

  it('signs points inside the solid negative and points outside positive', () => {
    const index = new SurfaceIndex(buildSurface(createBox(2)));

    expect(index.signedDistance({ x: 0, y: 0, z: 0 })).toBeLessThan(0);
    expect(index.signedDistance({ x: 0.9, y: 0, z: 0 })).toBeCloseTo(-0.1, 5);
    expect(index.signedDistance({ x: 3, y: 0, z: 0 })).toBeCloseTo(2, 5);
  });

  it('finds the nearest point on the surface', () => {
    const index = new SurfaceIndex(buildSurface(createBox(2)));
    const hit = index.closest({ x: 2, y: 0, z: 0 });

    expect(hit?.point.x).toBeCloseTo(1, 6);
    expect(hit?.distance).toBeCloseTo(1, 6);
  });
});

describe('voxel remesh', () => {
  it('rebuilds a box as a closed quad shell', () => {
    const result = remeshMesh(
      createBox(2),
      settings({ adaptive: false, voxelSize: 0.25, smoothing: 1, projection: 0.8 }),
    );

    expect(result.mesh.faces.size).toBeGreaterThan(50);
    expect(faceKinds(result.mesh)).toEqual({
      tris: 0,
      quads: result.mesh.faces.size,
      ngons: 0,
    });
    expect(openEdges(result.mesh)).toBe(0);
    // A closed surface of genus zero, however it was tiled.
    expect(result.mesh.verts.size - result.mesh.edges.size + result.mesh.faces.size).toBe(2);
  });

  it('winds every face outward', () => {
    // A sphere is convex and centred on the origin, so an outward normal is one
    // that agrees with the direction of the face it belongs to. Inverted
    // winding is the failure that renders as a black, inside-out shell.
    const result = remeshMesh(
      createUVSphere(1, 24, 12),
      settings({ adaptive: false, voxelSize: 0.15 }),
    );

    for (const face of result.mesh.faces.values()) {
      const centre = result.mesh.faceCenter(face);
      const outward =
        centre.x * face.normal.x + centre.y * face.normal.y + centre.z * face.normal.z;
      expect(outward).toBeGreaterThan(0);
    }
  });

  it('keeps the shape it was given', () => {
    const source = createUVSphere(1, 24, 12);
    const result = remeshMesh(source, settings({ adaptive: false, voxelSize: 0.12 }));

    const before = bounds(source);
    const after = bounds(result.mesh);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(after.min[axis]).toBeCloseTo(before.min[axis], 1);
      expect(after.max[axis]).toBeCloseTo(before.max[axis], 1);
    }
  });

  it('lands near the face count it was asked for', () => {
    const result = remeshMesh(createUVSphere(1, 32, 16), settings({ targetFaces: 1000 }));

    expect(result.mesh.faces.size).toBeGreaterThan(600);
    expect(result.mesh.faces.size).toBeLessThan(1600);
  });

  it('gets denser as the voxel size drops', () => {
    const coarse = remeshMesh(createBox(2), settings({ adaptive: false, voxelSize: 0.4 }));
    const fine = remeshMesh(createBox(2), settings({ adaptive: false, voxelSize: 0.2 }));

    expect(fine.mesh.faces.size).toBeGreaterThan(coarse.mesh.faces.size * 2);
  });

  it('emits triangles when asked for them', () => {
    const result = remeshMesh(
      createBox(2),
      settings({ adaptive: false, voxelSize: 0.4, topology: 'triangles' }),
    );

    expect(faceKinds(result.mesh).quads).toBe(0);
    expect(faceKinds(result.mesh).tris).toBe(result.mesh.faces.size);
    expect(openEdges(result.mesh)).toBe(0);
  });

  it('closes an open mesh over, and says so', () => {
    const result = remeshMesh(createGrid(2, 4), settings({ adaptive: false, voxelSize: 0.25 }));

    expect(openEdges(result.mesh)).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/open edge/);
  });

  it('projection pulls the shell back onto the original surface', () => {
    const source = createBox(2);
    const index = new SurfaceIndex(buildSurface(source));
    const drift = (mesh: BMesh) => {
      let total = 0;
      for (const vert of mesh.verts.values()) total += Math.abs(index.signedDistance(vert.co));
      return total / mesh.verts.size;
    };

    const loose = remeshMesh(
      source,
      settings({ adaptive: false, voxelSize: 0.3, smoothing: 4, projection: 0 }),
    );
    const projected = remeshMesh(
      source,
      settings({ adaptive: false, voxelSize: 0.3, smoothing: 4, projection: 1 }),
    );

    // Relaxing with nothing to hold it rounds the shell off the model;
    // re-projecting after every pass is what puts it back on the surface.
    expect(drift(projected.mesh)).toBeLessThan(drift(loose.mesh) / 4);
    expect(drift(projected.mesh)).toBeLessThan(0.01);
  });

  it('carries material slots across', () => {
    const source = createBox(2);
    for (const face of source.faces.values()) {
      face.materialIndex = face.normal.y > 0.5 ? 1 : 0;
    }

    const result = remeshMesh(source, settings({ adaptive: false, voxelSize: 0.25 }));
    const slots = new Set([...result.mesh.faces.values()].map((face) => face.materialIndex));

    expect(slots).toContain(0);
    expect(slots).toContain(1);
  });

  it('refuses a mesh with nothing in it', () => {
    expect(() => remeshMesh(new BMesh(), settings())).toThrow(/no faces/);
  });
});

describe('blocks remesh', () => {
  it('puts every vertex on the voxel lattice', () => {
    const result = remeshMesh(
      createUVSphere(1, 16, 8),
      settings({ method: 'blocks', adaptive: false, voxelSize: 0.25 }),
    );

    expect(openEdges(result.mesh)).toBe(0);

    // Cell centres, so every coordinate differs from every other by a whole
    // number of voxels — the blocky look is the whole point of the mode.
    const first = [...result.mesh.verts.values()][0].co;
    for (const vert of result.mesh.verts.values()) {
      const steps = (vert.co.x - first.x) / result.voxelSize;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-4);
    }
  });
});

describe('decimate', () => {
  it('collapses towards the triangle budget', () => {
    const source = createUVSphere(1, 32, 16);
    const before = source.stats().tris;
    const { mesh, collapsed } = decimateMesh(source, {
      targetTriangles: Math.round(before * 0.25),
      preserveBoundary: true,
    });

    expect(collapsed).toBeGreaterThan(0);
    expect(mesh.stats().tris).toBeLessThan(before * 0.35);
    expect(openEdges(mesh)).toBe(0);
  });

  it('keeps the silhouette while it does it', () => {
    const source = createUVSphere(1, 32, 16);
    const { mesh } = decimateMesh(source, {
      targetTriangles: 200,
      preserveBoundary: true,
    });

    const after = bounds(mesh);
    expect(after.max.x).toBeGreaterThan(0.85);
    expect(after.min.x).toBeLessThan(-0.85);
  });

  it('keeps the faces wound the way it found them', () => {
    const { mesh } = decimateMesh(createUVSphere(1, 24, 12), {
      targetTriangles: 150,
      preserveBoundary: true,
    });

    for (const face of mesh.faces.values()) {
      const centre = mesh.faceCenter(face);
      const outward =
        centre.x * face.normal.x + centre.y * face.normal.y + centre.z * face.normal.z;
      expect(outward).toBeGreaterThan(0);
    }
  });

  it('leaves the border of an open mesh alone when told to', () => {
    const source = createGrid(2, 10);
    const border = [...source.verts.values()].filter((vert) =>
      vert.edges.some((edge) => edge.loops.length === 1),
    ).length;

    const { mesh } = decimateMesh(source, { targetTriangles: 20, preserveBoundary: true });
    const kept = [...mesh.verts.values()].filter((vert) =>
      vert.edges.some((edge) => edge.loops.length === 1),
    ).length;

    expect(kept).toBe(border);
  });

  it('runs through remeshMesh with a ratio and re-quads the result', () => {
    const source = createUVSphere(1, 32, 16);
    const result = remeshMesh(
      source,
      settings({ method: 'decimate', adaptive: false, ratio: 0.3, topology: 'quads' }),
    );

    expect(result.mesh.stats().tris).toBeLessThan(source.stats().tris * 0.45);
    expect(faceKinds(result.mesh).quads).toBeGreaterThan(0);
  });

  it('leaves the mesh alone when the target is above what it already has', () => {
    const source = createBox(1);
    const result = remeshMesh(
      source,
      settings({ method: 'decimate', adaptive: false, ratio: 1, topology: 'quads' }),
    );

    expect(result.warnings.join(' ')).toMatch(/Nothing to collapse — a KEEP of 1/);
    // Not triangulated and re-paired into quads on the way through: a run that
    // collapses nothing has no business changing the face count.
    expect(result.mesh.faces.size).toBe(source.faces.size);
    expect(result.mesh.verts.size).toBe(source.verts.size);
  });

  it('counts in faces when it says a target was unreachable', () => {
    const result = remeshMesh(
      createBox(1),
      settings({ method: 'decimate', adaptive: true, targetFaces: 5000, topology: 'quads' }),
    );

    // The control that set it is labelled in faces, so the answer is too —
    // quoting the triangles the collapse counts in reads as a different
    // measurement having gone wrong.
    // The thousands separator is the reader's own, so only the units are
    // asserted here.
    expect(result.warnings.join(' ')).toMatch(/already down to 6 faces, below the target of/);
    expect(result.warnings.join(' ')).not.toMatch(/triangle/i);
  });
});

describe('settings', () => {
  it('solves a face count back into a voxel size', () => {
    // Six one-metre faces at 600 quads is ten quads per metre each way.
    expect(voxelSizeForFaces(6, 600)).toBeCloseTo(0.1, 6);
  });

  it('counts faces by their corners', () => {
    expect(faceKinds(createBox(1))).toEqual({ tris: 0, quads: 6, ngons: 0 });
  });
});
