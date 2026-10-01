import { describe, expect, it } from 'vitest';

import {
  type Vec3,
  add,
  basisFromNormal,
  dot,
  normalize,
  polygonArea,
  polygonNormal,
  vec3,
} from '../math';
import { BMesh } from '../mesh';
import type { Vert } from '../mesh/types';
import { triangulatePolygon } from '../mesh/triangulate';
import {
  createBox,
  createCapsule,
  createCircle,
  createCone,
  createCylinder,
  createGrid,
  createIcoSphere,
  createTorus,
  createUVSphere,
} from '../primitives';

import { booleanMesh, booleanMeshStaged } from './boolean';
import { subdivideFaces } from './subdivide';

/** Runs a staged operation to its end, keeping only the result. */
function drainStages<T>(steps: Generator<number, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

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

/**
 * A dense sphere shaken off its lattice, so nothing lines up by accident.
 *
 * A cut through a surface this irregular is where a boolean's arithmetic shows:
 * the split leaves slivers with no area to speak of, they are dropped, and the
 * surface comes back with a few edges that have nothing on the far side. That
 * is what a real model does to it, and the same jitter every time so a failure
 * can be looked at twice.
 */
function shaken(radius: number, amount: number): BMesh {
  const mesh = createUVSphere(radius, 48, 24);
  let seed = 1;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };

  for (const vert of mesh.verts.values()) {
    vert.co = {
      x: vert.co.x + next() * amount,
      y: vert.co.y + next() * amount,
      z: vert.co.z + next() * amount,
    };
  }

  mesh.computeNormals();
  return mesh;
}

/**
 * Whether a face's outline runs over itself once flattened onto its own plane.
 *
 * Such a ring has no honest inside. Nothing errors on one: it is closed, it
 * has an area, it triangulates, but the triangles miss part of the surface
 * and cover ground the face never had, which the viewport draws as a hole
 * straight through solid material.
 */
function crossesItself(points: readonly Vec3[]): boolean {
  const { u, v } = basisFromNormal(normalize(polygonNormal(points)));
  const flat = points.map((point) => ({ x: dot(point, u), y: dot(point, v) }));
  const turn = (a: { x: number; y: number }, b: typeof a, c: typeof a) =>
    Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      // Segments next to each other share an endpoint, which is not a crossing.
      if ((i + 1) % flat.length === j || (j + 1) % flat.length === i) continue;
      const [a, b] = [flat[i], flat[(i + 1) % flat.length]];
      const [c, d] = [flat[j], flat[(j + 1) % flat.length]];
      if (turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0) return true;
    }
  }

  return false;
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
   * of them closed and holding its volume.
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
    // of the other and stay the quads they came in as; the three that overlap
    // lose a corner each, which is an L. Six faces per cube, no triangles and
    // nothing carved along a plane the finished shape does not show.
    const result = booleanMesh('union', createBox(2), createBox(2), offsetBy(vec3(1, 0.5, 0.5)));

    expect(result.faces.size).toBe(12);
    expect(faceSizes(result).get(4)).toBe(6);
    expect(faceSizes(result).get(6)).toBe(6);
  });

  it('cuts a stepped difference only where the shape actually steps', () => {
    const result = booleanMesh(
      'difference',
      createBox(2),
      createBox(2),
      offsetBy(vec3(1, 0.5, 0.5)),
    );

    // Three faces stand clear of the tool and stay whole; the three it reaches
    // lose a corner each, which is an L. The union splits those into two quads
    // apiece because its surface is there to be modelled on: a cut keeps them
    // as the six-sided rings they are, and never leaves a triangle behind.
    expect(faceSizes(result).get(3) ?? 0).toBe(0);
    expect(faceSizes(result).get(4)).toBe(6);
    expect(faceSizes(result).get(6)).toBe(3);
    expect(result.faces.size).toBe(9);
  });

  it('leaves no splinters behind on a cut', () => {
    const cases = [
      booleanMesh('difference', createBox(2), createCylinder(0.5, 4), offsetBy(vec3())),
      booleanMesh('difference', createBox(2), createUVSphere(0.8), offsetBy(vec3())),
      booleanMesh('difference', createTorus(), createBox(0.6), offsetBy(vec3(0.5, 0, 0))),
    ];

    // Triangles are what a boolean falls back on when it cannot state a piece
    // of surface any better. A handful along a curved seam is expected; a
    // result made mostly of them is one that has shattered.
    //
    // Counted rather than weighed against the quads: merging a bored-through
    // face into two whole rings removes a dozen quads and improves the mesh,
    // which a quad *share* reads as a step backwards.
    for (const result of cases) {
      const tris = faceSizes(result).get(3) ?? 0;
      expect(tris).toBeLessThan(result.faces.size * 0.2);
    }
  });

  it('leaves the face a cut traced whole, rather than fanning it into quads', () => {
    // A sphere sunk into a corner, biting into the three faces that meet
    // there. Each keeps the outline the rim traced as a single ring, and the
    // three faces the sphere never reached stay the quads they came in as.
    const result = booleanMesh(
      'difference',
      createBox(2),
      createUVSphere(1, 24, 12),
      offsetBy(vec3(1, 1, 1)),
    );

    expect(isClosed(result)).toBe(true);
    expect(ngonCount(result)).toBe(3);
  });

  it('reads a union of the same pair the same way', () => {
    // The face the rim traced is the face the rim traced, whichever side of it
    // the operation kept: three bitten box faces, one ring each.
    const result = booleanMesh(
      'union',
      createBox(2),
      createUVSphere(1, 24, 12),
      offsetBy(vec3(1, 1, 1)),
    );

    expect(isClosed(result)).toBe(true);
    expect(ngonCount(result)).toBe(3);
  });

  it('fuses where the solids touch without carving the faces around it', () => {
    // A sphere sitting in the middle of the top face: the case that used to
    // come back with that face shredded into thirty splintered strips, one per
    // segment of the seam, because a ring of surface around a hole cannot be
    // closed by merging neighbours pairwise.
    const result = booleanMesh(
      'union',
      createBox(2),
      createUVSphere(1, 32, 16),
      offsetBy(vec3(0, 1.7, 0)),
    );

    expect(isClosed(result)).toBe(true);

    const walls: [string, (point: Vec3) => boolean][] = [
      ['top', (point) => Math.abs(point.y - 1) < 1e-9],
      ['bottom', (point) => Math.abs(point.y + 1) < 1e-9],
      ['x=1', (point) => Math.abs(point.x - 1) < 1e-9],
      ['x=-1', (point) => Math.abs(point.x + 1) < 1e-9],
      ['z=1', (point) => Math.abs(point.z - 1) < 1e-9],
      ['z=-1', (point) => Math.abs(point.z + 1) < 1e-9],
    ];

    for (const [wall, onWall] of walls) {
      const faces = [...result.faces.values()].filter((face) =>
        result.facePoints(face).every(onWall),
      );
      // The five walls the sphere never reaches stay one face each. The top,
      // which it lands in the middle of, becomes a ring of surface around a
      // hole: two faces, because one ring cannot state a hole.
      const expected = wall === 'top' ? 2 : 1;
      expect({ wall, faces: faces.length }).toEqual({ wall, faces: expected });
    }

    // And the surface it does keep is the whole of the box bar the disc.
    const disc = Math.PI * (1 - 0.7 * 0.7);
    const boxArea = walls.reduce(
      (total, [, onWall]) =>
        total +
        [...result.faces.values()]
          .filter((face) => result.facePoints(face).every(onWall))
          .reduce((sum, face) => sum + polygonArea(result.facePoints(face)), 0),
      0,
    );
    expect(boxArea).toBeCloseTo(6 * 4 - disc, 1);
  });

  it('does not paint the split face back over the hole it goes round', () => {
    // The two halves are ordinary simple polygons, so an ear clipper fills
    // them without reaching across. Stated as area: a fill that closed over
    // the seam would cover the disc as well and come out too large.
    const result = booleanMesh(
      'union',
      createBox(2),
      createUVSphere(1, 24, 12),
      offsetBy(vec3(0, 1.7, 0)),
    );

    let filled = 0;
    for (const face of result.faces.values()) {
      const points = result.facePoints(face);
      if (!points.every((point) => Math.abs(point.y - 1) < 1e-9)) continue;

      const indices = triangulatePolygon(points);
      for (let i = 0; i < indices.length; i += 3) {
        filled += polygonArea([points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]]);
      }
    }

    const disc = Math.PI * (1 - 0.7 * 0.7);
    expect(filled).toBeCloseTo(4 - disc, 1);
  });

  it('bores a face without marking the walls behind it', () => {
    // Splitting a holed face has to break its outline in two places, and
    // wherever it breaks it, a vertex is pinned there for good: it keeps a
    // third edge, so the pass that dissolves what the cut left behind walks
    // past it. That outline is the box's own top edge, shared with the wall
    // below it, which is how a cylinder sunk into the top used to leave the
    // side of the box a six-sided face the cutter had never gone near.
    const result = booleanMesh(
      'difference',
      createBox(2),
      createCylinder(0.4, 1, 24),
      offsetBy(vec3(0, 1.3, 0)),
    );

    expect(isClosed(result)).toBe(true);

    const walls: [string, (point: Vec3) => boolean][] = [
      ['bottom', (point) => Math.abs(point.y + 1) < 1e-9],
      ['x=1', (point) => Math.abs(point.x - 1) < 1e-9],
      ['x=-1', (point) => Math.abs(point.x + 1) < 1e-9],
      ['z=1', (point) => Math.abs(point.z - 1) < 1e-9],
      ['z=-1', (point) => Math.abs(point.z + 1) < 1e-9],
    ];

    for (const [wall, onWall] of walls) {
      const faces = [...result.faces.values()].filter((face) =>
        result.facePoints(face).every(onWall),
      );
      const corners = faces.map((face) => result.faceLoops(face).length);
      expect({ wall, corners }).toEqual({ wall, corners: [4] });
    }

    // And the bored face keeps its own outline too: the seams run out to two
    // of the square's corners, so the four it came in with are still all it has.
    const top = [...result.faces.values()].filter((face) =>
      result.facePoints(face).every((point) => Math.abs(point.y - 1) < 1e-9),
    );
    expect(top.length).toBe(2);

    const outline = new Set(
      top
        .flatMap((face) => result.facePoints(face))
        .filter((point) => Math.abs(point.x) > 1 - 1e-9 || Math.abs(point.z) > 1 - 1e-9)
        .map((point) => `${point.x},${point.z}`),
    );
    expect([...outline].sort()).toEqual(['-1,-1', '-1,1', '1,-1', '1,1']);
  });

  it('puts the cut face back together even where the cut tore the surface', () => {
    const tool = shaken(0.8, 0.05);
    const result = booleanMesh('union', createBox(2), tool, offsetBy(vec3(0.12, 1.05, -0.07)));

    const onTop = [...result.faces.values()].filter((face) =>
      result.facePoints(face).every((point) => Math.abs(point.y - 1) < 1e-9),
    );

    // A tear somewhere along a face's outline is a local thing, and the face is
    // still a face. Giving up on the whole surface over one hands back the
    // hundreds of strips the split carved it into, which is the state this
    // pass exists to undo.
    expect(onTop.length).toBeLessThanOrEqual(2);
    expect(onTop.filter((face) => crossesItself(result.facePoints(face))).length).toBe(0);
  });

  it('never hands back a face whose outline crosses itself', () => {
    // A sphere landing off-centre leaves a ring of surface around its
    // footprint, and a ring is the one thing a single face cannot state.
    // Threading a seam out to the hole and back does state it, as an outline
    // that runs over itself the moment the seam is drawn anywhere but straight
    // across the ring, which is what these placements are chosen to be.
    const placements: [number, Vec3][] = [
      [0.7, vec3(0.3, 1, 0.25)],
      [0.9, vec3(0.15, 0.6, 0)],
      [1.1, vec3(0.3, 0.6, 0.25)],
    ];

    for (const [radius, at] of placements) {
      const result = booleanMesh(
        'union',
        createBox(2),
        createUVSphere(radius, 32, 16),
        offsetBy(at),
      );

      const crossing = [...result.faces.values()].filter((face) =>
        crossesItself(result.facePoints(face)),
      );
      expect({ radius, crossing: crossing.length }).toEqual({ radius, crossing: 0 });
      // Two faces bridged across a hole also meet along the bridge twice over,
      // which leaves edges the seam has no second face for.
      expect({ radius, closed: isClosed(result) }).toEqual({ radius, closed: true });
    }
  });

  it('leaves no face reaching out over the cut', () => {
    // A sphere sunk into the top of a box. Every vertex of the seam folds the
    // face it lands on, and a folded face split across the fold paints a
    // triangle over the hole that was just cut, which is what a boolean's
    // curved seam is full of, and what the eye reads as material that should
    // not be there.
    const centre = vec3(0, 1, 0);
    const tool = createUVSphere(1, 24, 12);
    const result = booleanMesh('difference', createBox(2), tool, offsetBy(centre));

    // The tool is convex, so its own face planes answer "how far inside is
    // this?" exactly: no ray to graze a seam vertex and no tessellation
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

  it('does not fold a warped face over the hole it cuts in it', () => {
    // A box with its top turned a little, which twists every wall into a quad
    // that is not flat. A wall like that goes into the cut as triangles, and
    // stitching the pieces of two of them back into one face gave a ring bent
    // across both planes. Drawn flat, it folded over the hole the sphere left
    // and painted a flap across it.
    const target = createBox(1);
    const turn = (30 * Math.PI) / 180;
    for (const vert of target.verts.values()) {
      if (vert.co.y < 0) continue;
      const { x, y, z } = vert.co;
      vert.co = vec3(
        x * Math.cos(turn) + z * Math.sin(turn),
        y,
        -x * Math.sin(turn) + z * Math.cos(turn),
      );
    }
    target.computeNormals();

    const walls = [...target.faces.values()].map((face) => target.facePoints(face));
    const result = booleanMesh(
      'difference',
      target,
      createUVSphere(0.5, 24, 12),
      offsetBy(vec3(0.5, 0.35, 0.15)),
    );

    expect(isClosed(result)).toBe(true);

    const shapeOf = (points: readonly Vec3[]) =>
      points
        .map((point) => `${point.x.toFixed(9)},${point.y.toFixed(9)},${point.z.toFixed(9)}`)
        .sort()
        .join('|');
    const warpOf = (points: readonly Vec3[]) => {
      const normal = polygonNormal(points);
      const offsets = points.map((point) => dot(normal, point));
      return Math.max(...offsets) - Math.min(...offsets);
    };

    // A face may only be warped if it is a wall the cut never reached, handed
    // back as the very quad it went in as. Anything the cut made is flat.
    const untouched = new Set(walls.map(shapeOf));
    const warped = [...result.faces.values()]
      .map((face) => result.facePoints(face))
      .filter((points) => warpOf(points) > 1e-9);
    expect(warped.filter((points) => !untouched.has(shapeOf(points)))).toEqual([]);

    // The wall on the far side from the sphere is twisted and nowhere near the
    // cut, so it comes back whole rather than as the triangles it went in as.
    const far = walls.find((points) => points.every((point) => point.x < 0)) as Vec3[];
    expect(warpOf(far)).toBeGreaterThan(1e-3);
    expect(warped.map(shapeOf)).toContain(shapeOf(far));
  });

  it('welds the cut so the result has edges to work with, not loose triangles', () => {
    const result = booleanMesh('union', createBox(2), createBox(2), offsetBy(vec3(1, 0, 0)));

    // Loose triangles would leave every edge on a single face and the vertex
    // count at three per face.
    expect(result.verts.size).toBeLessThan(result.faces.size * 3);
    expect([...result.edges.values()].some((edge) => edge.loops.length === 2)).toBe(true);
  });
});

describe('what a boolean must not touch', () => {
  /** A face as a position-keyed string, so "the very same face" is testable. */
  const shapeOf = (points: readonly Vec3[]) =>
    points
      .map((point) => `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`)
      .sort()
      .join('|');

  function shapes(mesh: BMesh, move: (point: Vec3) => Vec3 = (point) => point): Set<string> {
    const all = new Set<string>();
    for (const face of mesh.faces.values()) all.add(shapeOf(mesh.facePoints(face).map(move)));
    return all;
  }

  /**
   * A sphere resting in the top face of a cube, at three tessellations.
   *
   * Everything above the cube's top is outside it, so the union has nothing to
   * say about those faces and must hand them back exactly. The fine sphere is
   * the case that matters: its pole cap folds by about half a degree from one
   * facet to the next, which a coplanarity limit cannot tell apart from the
   * splits a BSP makes, and the cap used to be dissolved away by it. Provenance
   * is what separates the two: a fragment knows which face it is part of.
   */
  it.each([16, 32, 64])('hands back every sphere face clear of the box, at %i segments', (seg) => {
    const shift = vec3(0, 1.8, 0);
    const sphere = createUVSphere(1, seg, seg / 2);
    const result = booleanMesh(
      'union',
      createBox(2),
      createUVSphere(1, seg, seg / 2),
      offsetBy(shift),
    );

    const clear = [...sphere.faces.values()]
      .map((face) => sphere.facePoints(face).map(offsetBy(shift)))
      .filter((points) => points.every((point) => point.y > 1 + 1e-9));

    const survived = shapes(result);
    const kept = clear.filter((points) => survived.has(shapeOf(points)));

    expect(clear.length).toBeGreaterThan(0);
    expect(kept.length).toBe(clear.length);
  });

  it('leaves the faces a union never reached as one face each, not as many', () => {
    const result = booleanMesh(
      'union',
      createBox(2),
      createUVSphere(0.5, 24, 12),
      offsetBy(vec3(0, 1, 0)),
    );

    // Only the top of the box is cut: the sphere is a 0.5 radius sitting on
    // the middle of it. Each of the other five faces has to come back as the
    // one face it went in as, covering the same ground: re-tiling used to hand
    // back twenty-two faces between them.
    //
    // Counted as faces and area rather than as an identical ring, because a
    // side face legitimately picks up points along its top edge, where the cut
    // face's own edges land on it. Those keep the surface watertight; they add
    // no faces and move nothing.
    const walls: [string, (point: Vec3) => boolean][] = [
      ['y=-1', (point) => Math.abs(point.y + 1) < 1e-9],
      ['x=1', (point) => Math.abs(point.x - 1) < 1e-9],
      ['x=-1', (point) => Math.abs(point.x + 1) < 1e-9],
      ['z=1', (point) => Math.abs(point.z - 1) < 1e-9],
      ['z=-1', (point) => Math.abs(point.z + 1) < 1e-9],
    ];

    for (const [wall, onWall] of walls) {
      const faces = [...result.faces.values()].filter((face) =>
        result.facePoints(face).every(onWall),
      );
      expect({ wall, faces: faces.length }).toEqual({ wall, faces: 1 });
      expect(polygonArea(result.facePoints(faces[0]))).toBeCloseTo(4, 9);
    }
  });

  it('does not shatter the one face it does cut', () => {
    const result = booleanMesh(
      'union',
      createBox(2),
      createUVSphere(0.5, 24, 12),
      offsetBy(vec3(0, 1, 0)),
    );

    // The cut face is the box's top. Tiling its ring back into quads turned it
    // into hundreds of slivers; reassembled and left alone it is a handful of
    // faces tracing the seam.
    const onTop = [...result.faces.values()].filter((face) =>
      result.facePoints(face).every((point) => Math.abs(point.y - 1) < 1e-9),
    );

    expect(onTop.length).toBeGreaterThan(0);
    expect(onTop.length).toBeLessThan(40);
  });
});

describe('what a boolean costs', () => {
  it('grows with the cut, not with the square of it', () => {
    // Two passes over the same shape at two densities. What is asserted is the
    // ratio between them, not either time, because a ratio is the same on a
    // fast machine and a slow one, and it is the ratio that gives away a step
    // that walks the whole mesh once per region of it, which is what a dense
    // boolean used to do and what froze the window for ten seconds.
    const cut = (cuts: number) => {
      const box = createBox(2);
      subdivideFaces(box, [...box.faces.values()], { cuts, smooth: 0 });
      const tool = createUVSphere(0.9, 32, 16);
      const started = performance.now();
      booleanMesh('union', box, tool, offsetBy(vec3(1, 0, 0)));
      return performance.now() - started;
    };

    cut(7); // warm the code paths up, so the first timed run is not the slow one
    const small = cut(15);
    const large = cut(63);

    // Sixteen times the faces. Linear would be sixteen, and the rebuild it does
    // on top of the cut is not linear, so there is room; quadratic would be far
    // past this, and used to be.
    expect(large / small).toBeLessThan(40);
  }, 120000);
});

describe('reporting progress', () => {
  it('climbs from nought to one without ever going backwards', () => {
    const steps = booleanMeshStaged(
      'union',
      createBox(2),
      createUVSphere(1, 16, 8),
      offsetBy(vec3(0, 1.5, 0)),
    );

    const reported: number[] = [];
    let step = steps.next();
    while (!step.done) {
      reported.push(step.value);
      step = steps.next();
    }

    expect(reported.length).toBeGreaterThan(2);
    for (const value of reported) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // A bar that goes back on itself reads as a fault in the operation.
    for (let i = 1; i < reported.length; i++) {
      expect(reported[i]).toBeGreaterThanOrEqual(reported[i - 1]);
    }
  });

  it.each(['union', 'difference', 'intersect'] as const)(
    'gives a %s the same mesh whether it reports or not',
    (op) => {
      const args = () =>
        [createBox(2), createUVSphere(1, 16, 8), offsetBy(vec3(0, 1.5, 0))] as const;

      const [t1, u1, m1] = args();
      const direct = booleanMesh(op, t1, u1, m1);
      const [t2, u2, m2] = args();
      const staged = drainStages(booleanMeshStaged(op, t2, u2, m2));

      // `booleanMesh` is the staged run drained, so this is really a guard
      // against the two ever being given separate implementations.
      expect(staged.faces.size).toBe(direct.faces.size);
      expect(staged.verts.size).toBe(direct.verts.size);
      expect(volume(staged)).toBeCloseTo(volume(direct), 9);
    },
  );
});

describe('operands that arrive inside out', () => {
  /** The same geometry with every face wound the other way round. */
  function inverted(mesh: BMesh): BMesh {
    const flipped = new BMesh();
    const moved = new Map<number, Vert>();
    for (const vert of mesh.verts.values()) moved.set(vert.id, flipped.addVert({ ...vert.co }));
    for (const face of mesh.faces.values()) {
      const ring = mesh.faceVerts(face).flatMap((vert) => moved.get(vert.id) ?? []);
      flipped.addFace([...ring].reverse());
    }
    flipped.computeNormals();
    return flipped;
  }

  /** A quarter turn about Z, which keeps handedness. */
  const turned = (point: Vec3): Vec3 => ({ x: point.y, y: -point.x, z: point.z });

  /** The same quarter turn with two axes swapped instead, which reverses it. */
  const mirrored = (point: Vec3): Vec3 => ({ x: point.y, y: point.x, z: point.z });

  it('reads a mirrored tool the same as a turned one', () => {
    // Two crossed cylinders. A scene is free to hold an object mirrored by a
    // negative scale, and the map that carries it into the target's space then
    // reverses every ring, which used to reach the BSP as a solid whose inside
    // and outside had swapped places. Nothing errored: the union came back as
    // two disjoint shells with one of the arms missing altogether.
    const arm = () => createCylinder(0.5, 2.4, 24, true);

    const turn = booleanMesh('union', arm(), arm(), turned);
    const mirror = booleanMesh('union', arm(), arm(), mirrored);

    expect(isClosed(mirror)).toBe(true);
    expect(volume(mirror)).toBeCloseTo(volume(turn), 6);
    expect(bounds(mirror).min.y).toBeCloseTo(-1.2, 6);
    expect(bounds(mirror).max.y).toBeCloseTo(1.2, 6);
  });

  it('cuts with a mirrored tool rather than returning it', () => {
    // The same reversal on a difference handed back the cutter itself in place
    // of the cut, which is the whole box gone and the bore left standing.
    const bore = () => createCylinder(0.45, 3, 24, true);

    const result = booleanMesh('difference', createBox(2), bore(), mirrored);

    expect(isClosed(result)).toBe(true);
    expect(volume(result)).toBeCloseTo(8 - Math.PI * 0.45 * 0.45 * 2, 1);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(bounds(result).min[axis]).toBeCloseTo(-1, 6);
      expect(bounds(result).max[axis]).toBeCloseTo(1, 6);
    }
  });

  it('reads a mesh that was already wound inward the same as one that was not', () => {
    // Not only the transform: a solid whose own faces point inward is no more
    // usable to the BSP, and either operand can be the one at fault.
    const expected = volume(booleanMesh('union', createBox(2), createBox(2), offsetBy(vec3(1))));

    for (const [target, tool] of [
      [createBox(2), inverted(createBox(2))],
      [inverted(createBox(2)), createBox(2)],
      [inverted(createBox(2)), inverted(createBox(2))],
    ] as const) {
      const result = booleanMesh('union', target, tool, offsetBy(vec3(1)));

      expect(isClosed(result)).toBe(true);
      expect(volume(result)).toBeCloseTo(expected, 6);
    }
  });

  it('leaves an open shell alone, having no inside to read a direction off', () => {
    // The sign of the volume of something that encloses nothing says only where
    // it happens to sit relative to the origin, so it is no evidence at all.
    const near = booleanMesh('union', createGrid(3, 4), createBox(1), offsetBy(vec3()));
    const far = booleanMesh('union', createGrid(3, 4), createBox(1), offsetBy(vec3(0, 40, 0)));

    expect(near.faces.size).toBeGreaterThan(0);
    expect(far.faces.size).toBeGreaterThan(0);
  });
});

describe('operands that are surfaces rather than solids', () => {
  /** A filled circle wider than the 2 m box, lying flat through its middle. */
  const disc = () => createCircle(2, 24, true);

  function surfaceArea(mesh: BMesh): number {
    let total = 0;
    for (const face of mesh.faces.values()) total += mesh.faceArea(face);
    return total;
  }

  /** The area of the faces lying flat at height `y`. */
  function areaAt(mesh: BMesh, y: number): number {
    let total = 0;
    for (const face of mesh.faces.values()) {
      const points = mesh.facePoints(face);
      if (points.every((point) => Math.abs(point.y - y) < 1e-6)) total += polygonArea(points);
    }
    return total;
  }

  /** The same box with one face on vertices of its own, so its rim is a seam. */
  function unwelded(mesh: BMesh): BMesh {
    const copy = new BMesh();
    const moved = new Map<number, Vert>();
    for (const vert of mesh.verts.values()) moved.set(vert.id, copy.addVert({ ...vert.co }));
    const [first, ...rest] = [...mesh.faces.values()];
    copy.addFace(mesh.faceVerts(first).map((vert) => copy.addVert({ ...vert.co })));
    for (const face of rest) {
      copy.addFace(mesh.faceVerts(face).flatMap((vert) => moved.get(vert.id) ?? []));
    }
    copy.computeNormals();
    return copy;
  }

  it('unions a filled circle with a box without cutting the box', () => {
    // Read as a solid, the circle's one plane stood for everything on one side
    // of it, and the union sliced the box in half along it.
    for (const [target, tool] of [
      [createBox(2), disc()],
      [disc(), createBox(2)],
    ] as const) {
      const result = booleanMesh('union', target, tool, offsetBy(vec3()));

      expect(volume(result)).toBeCloseTo(8, 6);
      expect(areaAt(result, 1)).toBeCloseTo(4, 6);
      expect(areaAt(result, -1)).toBeCloseTo(4, 6);
      // The part of the circle inside the box is inside the solid, and goes.
      expect(areaAt(result, 0)).toBeCloseTo(surfaceArea(disc()) - 4, 6);
    }
  });

  it('takes nothing away with a surface, having nothing inside it', () => {
    const result = booleanMesh('difference', createBox(2), disc(), offsetBy(vec3()));

    expect(result.faces.size).toBe(6);
    expect(volume(result)).toBeCloseTo(8, 6);
  });

  it('cuts a hole in a surface without walling it in', () => {
    // An imported image is a plane, and a box pushed through one should leave
    // a window in the picture rather than half a box hanging off it.
    const result = booleanMesh('difference', createGrid(4, 4), createBox(2), offsetBy(vec3()));

    expect(areaAt(result, 0)).toBeCloseTo(12, 6);
    expect(surfaceArea(result)).toBeCloseTo(12, 6);
  });

  it('keeps the part of a surface inside the solid on an intersect', () => {
    for (const [target, tool] of [
      [createBox(2), disc()],
      [disc(), createBox(2)],
    ] as const) {
      const result = booleanMesh('intersect', target, tool, offsetBy(vec3()));

      expect(areaAt(result, 0)).toBeCloseTo(4, 6);
      expect(surfaceArea(result)).toBeCloseTo(4, 6);
    }
  });

  it('still cuts with a solid whose seam was never welded', () => {
    // Open along the seam as far as the topology goes, and as closed as ever
    // as far as the shape goes, which is what decides whether it has an inside.
    const result = booleanMesh(
      'difference',
      createBox(2),
      unwelded(createBox(2)),
      offsetBy(vec3(1, 0, 0)),
    );

    expect(isClosed(result)).toBe(true);
    expect(volume(result)).toBeCloseTo(4, 2);
  });
});
