import { describe, expect, it } from 'vitest';

import { type Vec3, add, dot, polygonNormal, vec3 } from '../math';
import type { BMesh } from '../mesh';
import { triangulatePolygon } from '../mesh/triangulate';
import {
  createBox,
  createCapsule,
  createCone,
  createCylinder,
  createIcoSphere,
  createTorus,
  createUVSphere,
} from '../primitives';

import { booleanMesh } from './boolean';

/** Every edge shared by exactly two faces: the result is a closed solid. */
function isClosed(mesh: BMesh): boolean {
  return [...mesh.edges.values()].every((edge) => edge.loops.length === 2);
}

function bounds(mesh: BMesh): { min: Vec3; max: Vec3 } {
  return mesh.boundingBox();
}

/** Signed volume through the divergence theorem, over a triangle fan per face. */
function volume(mesh: BMesh): number {
  let total = 0;
  for (const face of mesh.faces.values()) {
    const points = mesh.facePoints(face);
    for (let i = 1; i < points.length - 1; i++) {
      const [a, b, c] = [points[0], points[i], points[i + 1]];
      total +=
        a.x * (b.y * c.z - c.y * b.z) -
        a.y * (b.x * c.z - c.x * b.z) +
        a.z * (b.x * c.y - c.x * b.y);
    }
  }
  return Math.abs(total) / 6;
}

/** Half-overlapping unit cubes: the tool sits one half-width along X. */
function offsetBy(offset: Vec3) {
  return (point: Vec3) => add(point, offset);
}

function faceSizes(mesh: BMesh): Map<number, number> {
  const sizes = new Map<number, number>();
  for (const face of mesh.faces.values()) {
    const corners = mesh.faceLoops(face).length;
    sizes.set(corners, (sizes.get(corners) ?? 0) + 1);
  }
  return sizes;
}

function ngonCount(mesh: BMesh): number {
  let ngons = 0;
  for (const [corners, count] of faceSizes(mesh)) {
    if (corners > 4) ngons += count;
  }
  return ngons;
}

describe('mesh booleans', () => {
  it('unions two overlapping cubes into one closed solid', () => {
    const result = booleanMesh('union', createBox(2), createBox(2), offsetBy(vec3(1, 0, 0)));

    expect(isClosed(result)).toBe(true);
    // Two 2m cubes overlapping by half: 8 + 8 − 4 = 12 m³.
    expect(volume(result)).toBeCloseTo(12, 2);
    expect(bounds(result).min.x).toBeCloseTo(-1, 5);
    expect(bounds(result).max.x).toBeCloseTo(2, 5);
  });

  it('cuts the tool out of the target on a difference', () => {
    const result = booleanMesh('difference', createBox(2), createBox(2), offsetBy(vec3(1, 0, 0)));

    expect(isClosed(result)).toBe(true);
    expect(volume(result)).toBeCloseTo(4, 2);
    // The far wall of the target survives; the tool's half is gone.
    expect(bounds(result).min.x).toBeCloseTo(-1, 5);
    expect(bounds(result).max.x).toBeCloseTo(0, 5);
  });

  it('keeps only the shared solid on an intersect', () => {
    const result = booleanMesh('intersect', createBox(2), createBox(2), offsetBy(vec3(1, 0, 0)));

    expect(isClosed(result)).toBe(true);
    expect(volume(result)).toBeCloseTo(4, 2);
    expect(bounds(result).min.x).toBeCloseTo(0, 5);
    expect(bounds(result).max.x).toBeCloseTo(1, 5);
  });

  it('leaves the target alone when the tool is nowhere near it', () => {
    const result = booleanMesh('difference', createBox(2), createBox(2), offsetBy(vec3(10, 0, 0)));

    expect(isClosed(result)).toBe(true);
    expect(volume(result)).toBeCloseTo(8, 2);
  });

  it('empties the mesh when the tool swallows the target whole', () => {
    const result = booleanMesh('difference', createBox(1), createBox(4), offsetBy(vec3()));

    expect(result.faces.size).toBe(0);
  });

  it('cuts on planes that line up with nothing, not just the axes', () => {
    // Turned 45° about Y, so every cut plane is oblique to the target's faces.
    const turn = Math.PI / 4;
    const rotated = (point: Vec3): Vec3 => ({
      x: point.x * Math.cos(turn) + point.z * Math.sin(turn) + 1,
      y: point.y,
      z: -point.x * Math.sin(turn) + point.z * Math.cos(turn),
    });

    const result = booleanMesh('difference', createBox(2), createBox(2), rotated);

    expect(isClosed(result)).toBe(true);
    expect(volume(result)).toBeGreaterThan(0);
    expect(volume(result)).toBeLessThan(8);
  });

  it('cuts a curved solid out of a flat one', () => {
    // Tall enough to pass clean through, so the bore is a through-hole.
    const result = booleanMesh(
      'difference',
      createBox(2),
      createCylinder(0.5, 4),
      offsetBy(vec3()),
    );

    expect(isClosed(result)).toBe(true);
    // A 0.5 m-radius bore through an 8 m³ cube: 8 − π·0.5²·2.
    expect(volume(result)).toBeCloseTo(8 - Math.PI * 0.5, 0);
  });

  /**
   * The shapes a cut actually meets: flat against flat, flat against curved,
   * curved against curved, and one shape whose surface never lies flat at all.
   * Each pairing breaks a different assumption, and the mesh has to survive all
   * of them closed and free of n-gons.
   */
  describe.each([
    ['flat on flat', () => createBox(2), () => createBox(2), vec3(1, 0.5, 0.5)],
    ['flat on curved', () => createBox(2), () => createCylinder(0.5, 4), vec3()],
    ['curved on flat', () => createCylinder(1, 2), () => createBox(1), vec3(0.5, 0, 0)],
    ['curved on curved', () => createUVSphere(1), () => createCylinder(0.4, 4), vec3(0.2, 0, 0)],
    ['triangulated on flat', () => createIcoSphere(1), () => createBox(1), vec3(0.8, 0, 0)],
    ['tapered on curved', () => createCone(1, 2), () => createCylinder(0.3, 4), vec3()],
    ['domed on flat', () => createCapsule(0.5, 2), () => createBox(1), vec3(0.4, 0.5, 0)],
    ['ringed on flat', () => createTorus(), () => createBox(0.6), vec3(0.5, 0, 0)],
  ])('%s', (_name, target, tool, offset) => {
    it.each(['union', 'difference', 'intersect'] as const)('resolves a %s cleanly', (op) => {
      const result = booleanMesh(op, target(), tool(), offsetBy(offset));

      expect(result.faces.size).toBeGreaterThan(0);
      expect(isClosed(result)).toBe(true);
      // Never an n-gon: everything downstream — bevel, loop cut, the exporters —
      // reads a five-sided face as a special case, and a cut should not make one.
      expect(ngonCount(result)).toBe(0);
      expect(volume(result)).toBeGreaterThan(0);
    });
  });

  it('holds up at scales a fixed tolerance would not', () => {
    // A rivet and a building through the same code path. The tolerances are
    // fractions of the model, so both cut the same way.
    for (const size of [0.02, 1, 2000]) {
      const result = booleanMesh(
        'difference',
        createBox(size),
        createBox(size),
        offsetBy(vec3(size / 2, 0, 0)),
      );

      expect(isClosed(result)).toBe(true);
      expect(ngonCount(result)).toBe(0);
      expect(volume(result)).toBeCloseTo(size ** 3 / 2, 5);
    }
  });

  it('keeps a face the cut never reached as the quad it came in as', () => {
    const result = booleanMesh('difference', createBox(2), createBox(2), offsetBy(vec3(1, 0, 0)));

    // Half a cube: five faces untouched by the cut plus the cut wall itself,
    // all of them quads. Triangulating on the way in gave twelve triangles.
    expect(faceSizes(result).get(4)).toBe(6);
    expect(result.faces.size).toBe(6);
  });

  it('cuts a stepped union only where the shape actually steps', () => {
    // Two cubes offset on all three axes. Three of each cube's faces are clear
    // of the other and stay whole; the three that overlap lose a corner each,
    // which is an L and takes two quads. Nine faces per cube, no triangles and
    // nothing carved along a plane the finished shape does not show.
    const result = booleanMesh('union', createBox(2), createBox(2), offsetBy(vec3(1, 0.5, 0.5)));

    expect(result.faces.size).toBe(18);
    expect(faceSizes(result).get(4)).toBe(18);
  });

  it('cuts a stepped difference only where the shape actually steps', () => {
    const result = booleanMesh(
      'difference',
      createBox(2),
      createBox(2),
      offsetBy(vec3(1, 0.5, 0.5)),
    );

    expect(faceSizes(result).get(3) ?? 0).toBe(0);
    expect(ngonCount(result)).toBe(0);
    expect(result.faces.size).toBe(12);
  });

  it('keeps quads in the majority on every cut in the survey above', () => {
    const cases = [
      booleanMesh('difference', createBox(2), createCylinder(0.5, 4), offsetBy(vec3())),
      booleanMesh('difference', createBox(2), createUVSphere(0.8), offsetBy(vec3())),
      booleanMesh('difference', createTorus(), createBox(0.6), offsetBy(vec3(0.5, 0, 0))),
    ];

    for (const result of cases) {
      const quads = faceSizes(result).get(4) ?? 0;
      expect(ngonCount(result)).toBe(0);
      expect(quads).toBeGreaterThan(result.faces.size * 0.8);
    }
  });

  it('leaves no face reaching out over the cut', () => {
    // A sphere sunk into the top of a box. Every vertex of the seam folds the
    // face it lands on, and a folded face split across the fold paints a
    // triangle over the hole that was just cut — which is what a boolean's
    // curved seam is full of, and what the eye reads as material that should
    // not be there.
    const centre = vec3(0, 1, 0);
    const tool = createUVSphere(1, 24, 12);
    const result = booleanMesh('difference', createBox(2), tool, offsetBy(centre));

    // The tool is convex, so its own face planes answer "how far inside is
    // this?" exactly — no ray to graze a seam vertex and no tessellation
    // sagitta to mistake for a real overlap.
    const planes = [...tool.faces.values()].map((face) => {
      const points = tool.facePoints(face).map(offsetBy(centre));
      const normal = polygonNormal(points);
      return { normal, d: dot(normal, points[0]) };
    });

    let deepest = 0;
    for (const face of result.faces.values()) {
      const points = result.facePoints(face);
      // Faces lying in the box's own planes: the material the cut left behind.
      const onBox = (['x', 'y', 'z'] as const).some((axis) =>
        points.every((point) => Math.abs(Math.abs(point[axis]) - 1) < 1e-9),
      );
      if (!onBox) continue;

      const indices = triangulatePolygon(points);
      for (let i = 0; i < indices.length; i += 3) {
        const [a, b, c] = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
        const mid = vec3((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3);
        let outermost = -Infinity;
        for (const plane of planes) {
          outermost = Math.max(outermost, dot(plane.normal, mid) - plane.d);
        }
        deepest = Math.max(deepest, -outermost);
      }
    }

    expect(deepest).toBeLessThan(1e-9);
  });

  it('welds the cut so the result has edges to work with, not loose triangles', () => {
    const result = booleanMesh('union', createBox(2), createBox(2), offsetBy(vec3(1, 0, 0)));

    // Loose triangles would leave every edge on a single face and the vertex
    // count at three per face.
    expect(result.verts.size).toBeLessThan(result.faces.size * 3);
    expect([...result.edges.values()].some((edge) => edge.loops.length === 2)).toBe(true);
  });
});
