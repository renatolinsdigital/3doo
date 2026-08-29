import { describe, expect, it } from 'vitest';

import { BMesh } from '../mesh';
import {
  createBox,
  createCylinder,
  createGrid,
  createIcoSphere,
  createUVSphere,
} from '../primitives';

import {
  DEFAULT_REMESH_SETTINGS,
  type RemeshSettings,
  detectFeatures,
  faceKinds,
  remeshMesh,
  voxelSizeForFaces,
} from './index';
import { decimateMesh } from './simplify';
import { SurfaceIndex, buildSurface, surfaceArea, surfaceBounds } from './surface';

/** Defaults with the method pinned: these blocks are about the voxel path. */
function settings(patch: Partial<RemeshSettings> = {}): RemeshSettings {
  return { ...DEFAULT_REMESH_SETTINGS, method: 'voxel', ...patch };
}

/** Closed and manifold: every edge is shared by exactly two faces. */
function openEdges(mesh: BMesh): number {
  let open = 0;
  for (const edge of mesh.edges.values()) if (edge.loops.length !== 2) open++;
  return open;
}

/** Edges with only one face: a hole in the surface, as opposed to a seam. */
function borderEdges(mesh: BMesh): number {
  let open = 0;
  for (const edge of mesh.edges.values()) if (edge.loops.length === 1) open++;
  return open;
}

function bounds(mesh: BMesh) {
  return surfaceBounds(buildSurface(mesh));
}

/** The eight corners of a box of side two, centred on the origin. */
const CUBE_CORNERS = [-1, 1].flatMap((x) =>
  [-1, 1].flatMap((y) => [-1, 1].map((z) => ({ x, y, z }))),
);

/** How many edges each vertex carries, tallied. */
function valences(mesh: BMesh): Map<number, number> {
  const tally = new Map<number, number>();
  for (const vert of mesh.verts.values()) {
    tally.set(vert.edges.length, (tally.get(vert.edges.length) ?? 0) + 1);
  }
  return tally;
}

/** The shortest edge of any face, against the voxel size it was built at. */
function shortestEdge(mesh: BMesh): number {
  let shortest = Infinity;
  for (const face of mesh.faces.values()) {
    const ring = mesh.facePoints(face);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      shortest = Math.min(shortest, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
    }
  }
  return shortest;
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

  it('lays a plain grid on every face of a cube, the ones flat on the lattice included', () => {
    // The grid is laid out from the model's own bounding box, so the three
    // faces on the minimum side land *exactly* on grid planes. Every grid point
    // there measures a distance of about 1e-16 to the surface, and the vector
    // it would read a side off is pure rounding error, so those planes used to
    // come back signed at random, and the contour shredded them into rosettes
    // of pentagons while the other three sides stayed clean. On a cube every
    // interior vertex owes four edges and only the eight corners may owe three.
    for (const targetFaces of [600, 1506, 5000]) {
      const result = remeshMesh(createBox(2), settings({ targetFaces }));
      const tally = valences(result.mesh);

      expect(tally.get(3)).toBe(8);
      expect(tally.get(4)).toBe(result.mesh.verts.size - 8);
      expect(faceKinds(result.mesh).quads).toBe(result.mesh.faces.size);
      expect(openEdges(result.mesh)).toBe(0);
    }
  });

  it('leaves no edge collapsed along a crease, at any smoothing', () => {
    // Where two faces both meet the grid squarely the contour has two or three
    // cells to offer per step along their edge, and every one of them projects
    // onto the same point of the crease. Snapping all of them lands them on top
    // of one another: an edge of no length and a collapsed quad behind it.
    for (const smoothing of [0, 1, 2, 4]) {
      const result = remeshMesh(createBox(2), settings({ targetFaces: 1506, smoothing }));
      expect(shortestEdge(result.mesh)).toBeGreaterThan(result.voxelSize * 0.2);
    }
  });

  it('refuses a mesh with nothing in it', () => {
    expect(() => remeshMesh(new BMesh(), settings())).toThrow(/no faces/);
  });
});

describe('sharp features', () => {
  /** Mean and worst distance from the result's vertices to the original surface. */
  function drift(source: BMesh, result: BMesh) {
    const index = new SurfaceIndex(buildSurface(source));
    let worst = 0;
    let total = 0;
    for (const vert of result.verts.values()) {
      const distance = index.closest(vert.co)?.distance ?? 0;
      worst = Math.max(worst, distance);
      total += distance;
    }
    return { worst, mean: total / result.verts.size };
  }

  it('finds the creases and corners of a cube', () => {
    const features = detectFeatures(createBox(2), 30);

    expect(features.segments).toHaveLength(12);
    expect(features.corners).toHaveLength(8);
  });

  it('leaves a smooth surface alone', () => {
    // Every edge of a fine sphere turns by a few degrees, so nothing there is a
    // crease and the snapping has nothing to do.
    expect(detectFeatures(createUVSphere(1, 32, 16), 30).segments).toHaveLength(0);
  });

  it('takes the open border of a surface as a crease whatever angle it sits at', () => {
    const features = detectFeatures(createGrid(2, 4), 30);

    // The border of a flat grid: four sides of four segments each.
    expect(features.segments).toHaveLength(16);
    expect(features.corners).toHaveLength(4);
  });

  it('keeps a rim smooth enough to slide along free of corners', () => {
    // A 32-sided cylinder turns 11 degrees per rim segment: a crease to hold,
    // but not a ring of pins that would stop the quads evening out along it.
    const features = detectFeatures(createCylinder(0.6, 2, 32, true), 30);

    expect(features.segments.length).toBeGreaterThan(0);
    expect(features.corners).toHaveLength(0);
  });

  it('holds a remeshed cube to its own edges', () => {
    const source = createBox(2);
    const rounded = remeshMesh(
      source,
      settings({ adaptive: false, voxelSize: 0.25, sharpAngle: 0 }),
    );
    const sharp = remeshMesh(
      source,
      settings({ adaptive: false, voxelSize: 0.25, sharpAngle: 30 }),
    );

    expect(sharp.sharp.corners).toBe(8);
    expect(sharp.sharp.creases).toBeGreaterThan(0);

    // Measured as how far the result stops short of the model's own corners,
    // which is what "holds the edges" actually means. Comparing the drift of
    // the vertices onto the surface (what this asked for before) no longer
    // separates the two at all: both land on the surface to within six
    // thousandths, and the only reason it ever passed was that the contour was
    // tearing itself apart on the faces that lay flat on the grid. That was the
    // bug, not the feature, so the test was reading the wrong number.
    const gap = (mesh: BMesh) => {
      let worst = 0;
      for (const corner of CUBE_CORNERS) {
        let nearest = Infinity;
        for (const vert of mesh.verts.values()) {
          nearest = Math.min(
            nearest,
            Math.hypot(vert.co.x - corner.x, vert.co.y - corner.y, vert.co.z - corner.z),
          );
        }
        worst = Math.max(worst, nearest);
      }
      return worst;
    };

    expect(gap(sharp.mesh)).toBeLessThan(1e-9);
    expect(gap(rounded.mesh)).toBeGreaterThan(0.002);
    // Both stay on the surface; holding the creases is what puts them on the
    // edges of it as well.
    expect(drift(source, sharp.mesh).worst).toBeLessThan(0.01);
  });

  it('puts a vertex on every corner of the cube, exactly', () => {
    const result = remeshMesh(
      createBox(2),
      settings({ adaptive: false, voxelSize: 0.25, sharpAngle: 30 }),
    );

    for (const corner of [
      { x: 1, y: 1, z: 1 },
      { x: -1, y: 1, z: 1 },
      { x: 1, y: -1, z: 1 },
      { x: 1, y: 1, z: -1 },
      { x: -1, y: -1, z: -1 },
    ]) {
      const landed = [...result.mesh.verts.values()].some(
        (vert) =>
          Math.abs(vert.co.x - corner.x) < 1e-6 &&
          Math.abs(vert.co.y - corner.y) < 1e-6 &&
          Math.abs(vert.co.z - corner.z) < 1e-6,
      );
      expect(landed).toBe(true);
    }
  });

  it('still comes out all-quad and unbroken with the creases held', () => {
    const source = createCylinder(0.6, 2, 32, true);
    const held = settings({ adaptive: false, voxelSize: 0.12, sharpAngle: 30 });
    const result = remeshMesh(source, held);
    const rounded = remeshMesh(source, { ...held, sharpAngle: 0 });

    expect(faceKinds(result.mesh).quads).toBe(result.mesh.faces.size);
    expect(borderEdges(result.mesh)).toBe(0);
    // Naive surface nets puts one vertex in a cell however many sheets of the
    // surface pass through it, so a rim this thin against the voxel size leaves
    // a handful of non-manifold junctions either way. Holding the creases must
    // not add to them, which is what this pins down.
    expect(openEdges(result.mesh)).toBe(openEdges(rounded.mesh));
  });

  it('says when corners were finer than the grid could hold', () => {
    // Every edge of an icosphere is a crease at five degrees, so every vertex
    // is a corner: far more of them than a coarse grid has vertices to pin,
    // and the ones that go are worth saying out loud.
    const source = createIcoSphere(1, 2);
    const detected = detectFeatures(source, 5);
    const result = remeshMesh(source, settings({ adaptive: false, voxelSize: 0.3, sharpAngle: 5 }));

    expect(detected.corners.length).toBeGreaterThan(result.sharp.corners);
    expect(result.warnings.join(' ')).toMatch(/finer than one voxel/);
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
    // number of voxels: the blocky look is the whole point of the mode.
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

    expect(result.warnings.join(' ')).toMatch(/Nothing to collapse: a KEEP of 1/);
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

    // The control that set it is labelled in faces, so the answer is too:
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
