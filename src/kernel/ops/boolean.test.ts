import { describe, expect, it } from 'vitest';

import {
  type Vec3,
  add,
  basisFromNormal,
  centroid,
  dot,
  normalize,
  polygonArea,
  polygonNormal,
  vec3,
} from '../math';
import { BMesh } from '../mesh';
import type { Face, Vert } from '../mesh/types';
import { triangulatePolygon } from '../mesh/triangulate';
import {
  createBox,
  createCapsule,
  createCircle,
  createCone,
  createCylinder,
  createGrid,
  createIcoSphere,
  createPlane,
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

/** A copy of `mesh` with every vertex carried by `move`, faces and all. */
function mapped(mesh: BMesh, move: (point: Vec3) => Vec3): BMesh {
  const copy = new BMesh();
  const verts = new Map<number, Vert>();
  for (const vert of mesh.verts.values()) verts.set(vert.id, copy.addVert(move(vert.co)));
  for (const face of mesh.faces.values()) {
    copy.addFace(mesh.faceVerts(face).map((vert) => verts.get(vert.id) as Vert));
  }
  return copy;
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

  it('finishes on a small model with a face a hair off flat', () => {
    // One corner of the top lifted by 8 µm leaves the quad 2 µm off its own
    // plane: inside a fixed 5 µm tolerance, outside 5 µm per metre of a 30 cm
    // pair. Read as flat by one and as straddling by the other, its piece on
    // the high side was sorted against the same plane forever.
    const target = createBox(0.2);
    const corner = [...target.verts.values()].find(
      (vert) => vert.co.x > 0 && vert.co.y > 0 && vert.co.z > 0,
    ) as Vert;
    corner.co = add(corner.co, vec3(0, 8e-6, 0));

    const result = booleanMesh('union', target, createBox(0.2), offsetBy(vec3(0.1, 0, 0)));

    expect(volume(result)).toBeCloseTo(0.012, 5);
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

  it('puts a face bent a hair off flat back together after the cut', () => {
    // One corner of the top lifted a centimetre, as a face moved by hand seldom
    // ends up exactly flat. Anything off its plane by more than the cut's own
    // tolerance went in as triangles of its own, so the face the tool landed on
    // came back halved along a diagonal it never showed: a pillar with a row of
    // ribs stuck to it came back slashed corner to corner.
    const target = createBox(2);
    const corner = [...target.verts.values()].find(
      (vert) => vert.co.x > 0 && vert.co.y > 0 && vert.co.z > 0,
    ) as Vert;
    corner.co = add(corner.co, vec3(0, 0.02, 0));
    target.computeNormals();

    const top = (mesh: BMesh) =>
      [...mesh.faces.values()].filter((face) =>
        mesh.facePoints(face).every((point) => point.y > 1 - 1e-9 && point.y < 1.02 + 1e-9),
      );

    // Notched where the tool crosses its edge, the top is still one face.
    const notched = booleanMesh('union', target, createBox(0.5), offsetBy(vec3(0.3, 1, 1)));
    expect(top(notched).length).toBe(1);

    // Bored through, it is the two halves a flat top would be, split along seams
    // from corner to corner. Its fragments tilt either way of the plane, so
    // their areas never matched the halves' and the split fell back on growing
    // pieces, which pinned points part-way along the outline.
    const bored = booleanMesh('union', target, createBox(0.5), offsetBy(vec3(0.3, 1, 0.3)));
    const corners = top(bored).map((face) => bored.faceLoops(face).length);
    expect(corners).toEqual([6, 6]);
  });

  /** The 1 m box's side at x = -0.5, which a tool one along X buries in the 2 m box. */
  function buriedSide(tool: BMesh): Face {
    return [...tool.faces.values()].find((face) =>
      tool.facePoints(face).every((point) => point.x === -0.5),
    ) as Face;
  }

  /** The floor that side leaves in the 2 m box, at x = 0.5. */
  function notchFloor(mesh: BMesh): number[] {
    return [...mesh.faces.values()]
      .filter((face) => mesh.facePoints(face).every((point) => Math.abs(point.x - 0.5) < 1e-6))
      .map((face) => mesh.faceLoops(face).length);
  }

  it('lines a hole with one face for each flat side of the cutter', () => {
    const tool = createBox(1);
    const side = buriedSide(tool);
    const ring = tool.faceVerts(side);
    tool.removeFace(side);
    const hub = tool.addVert(vec3(-0.5, 0.1, -0.2));
    for (let i = 0; i < ring.length; i++) {
      tool.addFace([ring[i], ring[(i + 1) % ring.length], hub]);
    }
    tool.computeNormals();

    const result = booleanMesh('difference', createBox(2), tool, offsetBy(vec3(1, 0, 0)));

    // The side was a fan of triangles, and the floor of the notch came through
    // as the same fan: a row of ribs cut into a pillar left one notch with its
    // floor slashed by diagonals where the others had a single face.
    expect(notchFloor(result)).toEqual([4]);
    expect(isClosed(result)).toBe(true);
  });

  it('closes a crack in the cutter before cutting with it', () => {
    // The buried side split along a diagonal whose far end is two corners a
    // tenth of a millimetre apart, each face round it holding its own.
    const tool = createBox(1);
    const side = buriedSide(tool);
    const [a, b, c, d] = tool.faceVerts(side);
    const twin = tool.addVert(add(c.co, vec3(0, 0, c.co.z > 0 ? -1e-4 : 1e-4)));
    const beside = [...tool.faces.values()].find((face) => {
      const verts = tool.faceVerts(face);
      return face !== side && verts.includes(c) && verts.includes(d);
    }) as Face;
    const besideRing = tool.faceVerts(beside).map((vert) => (vert === c ? twin : vert));

    tool.removeFace(side);
    tool.removeFace(beside);
    tool.removeEdge(tool.findEdge(c, d) as NonNullable<ReturnType<BMesh['findEdge']>>);
    tool.addFace([a, b, c]);
    tool.addFace([a, twin, d]);
    tool.addFace(besideRing);
    tool.computeNormals();
    expect([...tool.edges.values()].filter((edge) => edge.loops.length === 1).length).toBe(4);

    const result = booleanMesh('difference', createBox(2), tool, offsetBy(vec3(1, 0, 0)));

    // The crack came through into the notch, open along the floor's diagonal
    // and up the corner beside it, and the floor stayed in two halves.
    expect(isClosed(result)).toBe(true);
    expect(result.validate()).toEqual([]);
    expect(notchFloor(result)).toEqual([4]);
  });

  it('welds the cut so the result has edges to work with, not loose triangles', () => {
    const result = booleanMesh('union', createBox(2), createBox(2), offsetBy(vec3(1, 0, 0)));

    // Loose triangles would leave every edge on a single face and the vertex
    // count at three per face.
    expect(result.verts.size).toBeLessThan(result.faces.size * 3);
    expect([...result.edges.values()].some((edge) => edge.loops.length === 2)).toBe(true);
  });
});

/**
 * Two small parts of a real model, inside each other's boxes without touching.
 *
 * Nothing but a real model has shown what these do, so they are kept as data:
 * the BSP reads scraps of faces that touch nothing as lying inside the other.
 */
const APART_PAIR = {
  diamond: {
    verts: [
      -0.01235, 0.33827, -0.0155, -0.01348, 0.33598, -0.0155, -0.01348, 0.33598, 0.0155, -0.01235,
      0.33827, 0.0155, -0.01198, 0.33563, 0.017, -0.01229, 0.33596, 0.017, -0.01229, 0.33596,
      -0.017, -0.01198, 0.33563, -0.017, -0.01348, 0.32252, -0.0155, -0.01348, 0.32252, 0.0155,
      -0.01198, 0.32262, 0.017, -0.01198, 0.32262, -0.017, -0.01148, 0.30652, -0.0155, -0.01148,
      0.30652, 0.0155, -0.01004, 0.30705, 0.017, -0.01004, 0.30705, -0.017, 0.00352, 0.28402,
      -0.0155, 0.00352, 0.28402, 0.0155, 0.00458, 0.28512, 0.017, 0.00458, 0.28512, -0.017, 0.00562,
      0.2827, -0.0155, 0.00562, 0.2827, 0.0155, 0.005, 0.28486, 0.017, 0.005, 0.28486, -0.017,
      0.00748, 0.28652, -0.0155, 0.00748, 0.28652, 0.0155, 0.00597, 0.28686, 0.017, 0.00597,
      0.28686, -0.017, 0.00734, 0.30284, -0.0155, 0.00734, 0.30284, 0.0155, 0.00584, 0.30244, 0.017,
      0.00584, 0.30244, -0.017,
    ],
    faces: [
      [0, 1, 2, 3],
      [3, 2, 4, 5],
      [6, 7, 1, 0],
      [1, 8, 9, 2],
      [2, 9, 10, 4],
      [7, 11, 8, 1],
      [8, 12, 13, 9],
      [9, 13, 14, 10],
      [11, 15, 12, 8],
      [12, 16, 17, 13],
      [13, 17, 18, 14],
      [15, 19, 16, 12],
      [16, 20, 21, 17],
      [17, 21, 22, 18],
      [19, 23, 20, 16],
      [20, 24, 25, 21],
      [21, 25, 26, 22],
      [23, 27, 24, 20],
      [24, 28, 29, 25],
      [25, 29, 30, 26],
      [27, 31, 28, 24],
      [28, 0, 3, 29],
      [29, 3, 5, 30],
      [31, 6, 0, 28],
      [4, 10, 14],
      [15, 11, 7],
      [4, 14, 18],
      [19, 15, 7],
      [4, 18, 22],
      [23, 19, 7],
      [4, 22, 26],
      [27, 23, 7],
      [4, 26, 30],
      [31, 27, 7],
      [5, 4, 30],
      [31, 7, 6],
    ],
  },
  hook: {
    verts: [
      -0.01985, 0.29927, -0.0145, -0.021, 0.2955, -0.0145, -0.021, 0.2955, 0.0145, -0.01985,
      0.29927, 0.0145, -0.01947, 0.29537, 0.016, -0.01945, 0.29703, 0.016, -0.01945, 0.29703,
      -0.016, -0.01947, 0.29537, -0.016, -0.01985, 0.28615, -0.0145, -0.01985, 0.28615, 0.0145,
      -0.01843, 0.28688, 0.016, -0.01843, 0.28688, -0.016, -0.00187, 0.26963, -0.0145, -0.00187,
      0.26963, 0.0145, -0.00081, 0.27068, 0.016, -0.00081, 0.27068, -0.016, 0.02217, 0.24267,
      -0.0145, 0.02217, 0.24267, 0.0145, 0.0231, 0.24388, 0.016, 0.0231, 0.24388, -0.016, 0.02414,
      0.24169, -0.0145, 0.02414, 0.24169, 0.0145, 0.02428, 0.24329, 0.016, 0.02428, 0.24329, -0.016,
      0.02735, 0.24265, -0.0145, 0.02735, 0.24265, 0.0145, 0.02643, 0.24394, 0.016, 0.02643,
      0.24394, -0.016, 0.03363, 0.25146, -0.0145, 0.03363, 0.25146, 0.0145, 0.0318, 0.25042, 0.016,
      0.0318, 0.25042, -0.016, 0.02414, 0.25069, -0.0145, 0.02414, 0.25069, 0.0145, 0.02378,
      0.24915, 0.016, 0.02378, 0.24915, -0.016, 0.01765, 0.25465, -0.0145, 0.01765, 0.25465, 0.0145,
      0.01669, 0.25348, 0.016, 0.01669, 0.25348, -0.016, -0.00185, 0.27565, -0.0145, -0.00185,
      0.27565, 0.0145, -0.003, 0.27468, 0.016, -0.003, 0.27468, -0.016,
    ],
    faces: [
      [0, 1, 2, 3],
      [3, 2, 4, 5],
      [6, 7, 1, 0],
      [1, 8, 9, 2],
      [2, 9, 10, 4],
      [7, 11, 8, 1],
      [8, 12, 13, 9],
      [9, 13, 14, 10],
      [11, 15, 12, 8],
      [12, 16, 17, 13],
      [13, 17, 18, 14],
      [15, 19, 16, 12],
      [16, 20, 21, 17],
      [17, 21, 22, 18],
      [19, 23, 20, 16],
      [20, 24, 25, 21],
      [21, 25, 26, 22],
      [23, 27, 24, 20],
      [24, 28, 29, 25],
      [25, 29, 30, 26],
      [27, 31, 28, 24],
      [28, 32, 33, 29],
      [29, 33, 34, 30],
      [31, 35, 32, 28],
      [32, 36, 37, 33],
      [33, 37, 38, 34],
      [35, 39, 36, 32],
      [36, 40, 41, 37],
      [37, 41, 42, 38],
      [39, 43, 40, 36],
      [40, 0, 3, 41],
      [41, 3, 5, 42],
      [43, 6, 0, 40],
      [42, 5, 4],
      [7, 6, 43],
      [42, 4, 10],
      [11, 7, 43],
      [42, 10, 14],
      [15, 11, 43],
      [42, 14, 18],
      [19, 15, 43],
      [42, 18, 22],
      [23, 19, 43],
      [22, 26, 30],
      [31, 27, 23],
      [22, 30, 34],
      [35, 31, 23],
      [22, 34, 38],
      [39, 35, 23],
      [22, 38, 42],
      [43, 39, 23],
    ],
  },
};

function meshFrom(data: { verts: number[]; faces: number[][] }): BMesh {
  const mesh = new BMesh();
  const verts: Vert[] = [];
  for (let i = 0; i < data.verts.length; i += 3) {
    verts.push(mesh.addVert(vec3(data.verts[i], data.verts[i + 1], data.verts[i + 2])));
  }
  for (const ring of data.faces) mesh.addFace(ring.map((at) => verts[at]));
  mesh.computeNormals();
  return mesh;
}

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

  /** A face's ring starting from its lowest corner: same shape, same winding. */
  const ringOf = (points: readonly Vec3[]) => {
    const corners = points.map(
      (point) => `${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`,
    );
    const first = corners.indexOf([...corners].sort()[0]);
    return [...corners.slice(first), ...corners.slice(0, first)].join('|');
  };

  /**
   * A long ridged column of quads a hair off flat, the way a modelled part is.
   *
   * The jitter is what matters: every quad is cut as two triangles in planes of
   * their own, so a plane running past from the far end of the other operand
   * leaves pieces the merge cannot always fit back together.
   */
  function ridgedColumn(seed: number, amount = 0.002): BMesh {
    const mesh = new BMesh();
    const segments = 10;
    const rings = 24;
    let state = seed;
    const next = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return (state / 2147483648 - 0.5) * amount;
    };

    const grid: Vert[][] = [];
    for (let r = 0; r <= rings; r++) {
      const radius = r % 2 ? 0.34 : 0.42;
      const row: Vert[] = [];
      for (let s = 0; s < segments; s++) {
        const angle = (s / segments) * Math.PI * 2;
        row.push(
          mesh.addVert(
            vec3(
              Math.cos(angle) * radius + next(),
              (r / rings) * 6 - 3 + next(),
              Math.sin(angle) * radius + next(),
            ),
          ),
        );
      }
      grid.push(row);
    }

    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segments; s++) {
        const t = (s + 1) % segments;
        mesh.addFace([grid[r][s], grid[r + 1][s], grid[r + 1][t], grid[r][t]]);
      }
    }
    mesh.addFace([...grid[0]]);
    mesh.addFace([...grid[rings]].reverse());
    mesh.computeNormals();
    return mesh;
  }

  /** A box turned off every axis, its planes running on down the whole column. */
  const turnedBoxAt = (y: number) => (point: Vec3) => {
    const [c, s, c2, s2] = [Math.cos(0.7), Math.sin(0.7), Math.cos(0.4), Math.sin(0.4)];
    const x = point.x * c - point.y * s;
    return vec3(x * c2 + point.z * s2, point.x * s + point.y * c + y, -x * s2 + point.z * c2);
  };

  /** Whether a point stands clear of the box round everything `move` puts down. */
  const clearOf = (tool: BMesh, move: (point: Vec3) => Vec3, margin: number) => {
    const moved = [...tool.verts.values()].map((vert) => move(vert.co));
    const reach = (pick: (point: Vec3) => number) => {
      const values = moved.map(pick);
      return [Math.min(...values) - margin, Math.max(...values) + margin];
    };
    const [[x0, x1], [y0, y1], [z0, z1]] = [
      reach((point) => point.x),
      reach((point) => point.y),
      reach((point) => point.z),
    ];
    return (point: Vec3) =>
      point.x < x0 || point.x > x1 || point.y < y0 || point.y > y1 || point.z < z0 || point.z > z1;
  };

  /** Every face of `part` standing clear, as a ring in `move`d space. */
  const clearRings = (part: BMesh, clear: (point: Vec3) => boolean) =>
    [...part.faces.values()]
      .map((face) => part.facePoints(face))
      .filter((points) => points.every(clear))
      .map(ringOf);

  // A plane of the tool running on past it used to cut these faces, and where
  // the pieces would not merge back they stayed: quads handed back with five,
  // six, nine corners a long way from anything the union touched.
  it.each([1, 21])('hands back a long part as it came in, away from the contact (%i)', (seed) => {
    const column = ridgedColumn(seed);
    const tool = createBox(1.2);
    const move = turnedBoxAt(-3);
    const clear = clearOf(tool, move, 0.05);
    const expected = clearRings(column, clear);

    const result = booleanMesh('union', column, tool, move);
    const rings = new Set(
      [...result.faces.values()].map((face) => ringOf(result.facePoints(face))),
    );

    expect(expected.length).toBeGreaterThan(150);
    expect(expected.filter((ring) => !rings.has(ring))).toEqual([]);
  });

  it.each([1, 21])('makes no new n-gons away from the contact, from either side (%i)', (seed) => {
    const column = ridgedColumn(seed);
    const box = createBox(1.2);
    const move = turnedBoxAt(-3);
    const clear = clearOf(box, move, 0.05);
    // One end cap of the column is clear of the box and was an n-gon already.
    const farNgons = (mesh: BMesh) =>
      [...mesh.faces.values()].filter((face) => {
        const points = mesh.facePoints(face);
        return points.length > 4 && points.every(clear);
      }).length;

    expect(farNgons(booleanMesh('union', column, box, move))).toBe(1);

    // The same pair with the operands the other way round: the far faces now
    // belong to the tool, and they go through the same cut.
    const back = (point: Vec3) => {
      const [c, s, c2, s2] = [Math.cos(0.7), Math.sin(0.7), Math.cos(0.4), Math.sin(0.4)];
      const y = point.y + 3;
      const x = point.x * c2 - point.z * s2;
      const z = point.x * s2 + point.z * c2;
      return vec3(x * c + y * s, -x * s + y * c, z);
    };
    expect(farNgons(mapped(booleanMesh('union', box, column, back), move))).toBe(1);
  });

  // The face the tool bites can stay in two pieces, and the line between them
  // ended part-way along the edge it shares with the next face over, which
  // carried the point to stay sealed: a quad with five corners and nothing
  // touching it. Only the exact pairs below ever showed it, so they are named.
  it.each([
    { amount: 0.002, seed: 5, size: 0.05, at: vec3(-0.36, -1.2, -0.1) },
    { amount: 0.002, seed: 6, size: 0.12, at: vec3(0.38, 0.1, 0.02) },
    { amount: 0.002, seed: 5, size: 0.3, at: vec3(0.38, 0.1, 0.02) },
    { amount: 0.01, seed: 8, size: 0.12, at: vec3(0.4, 0.02, 0) },
    { amount: 0.01, seed: 8, size: 0.3, at: vec3(0.05, 1.5, 0.38) },
  ])('hands back the face beside the one it cut (seed $seed, size $size)', (trial) => {
    const column = ridgedColumn(trial.seed, trial.amount);
    const tool = createBox(trial.size);
    const move = offsetBy(trial.at);
    const reach = trial.size / 2 + 1e-3;
    // Boxes apart along an axis: such a face cannot be touching the tool, even
    // standing right beside the faces that are.
    const clearOfTool = (points: readonly Vec3[]) =>
      (['x', 'y', 'z'] as const).some(
        (axis) =>
          points.every((point) => point[axis] < trial.at[axis] - reach) ||
          points.every((point) => point[axis] > trial.at[axis] + reach),
      );
    const expected = [...column.faces.values()]
      .map((face) => column.facePoints(face))
      .filter(clearOfTool)
      .map(ringOf);

    const result = booleanMesh('union', column, tool, move);
    const rings = new Set(
      [...result.faces.values()].map((face) => ringOf(result.facePoints(face))),
    );

    expect(expected.filter((ring) => !rings.has(ring))).toEqual([]);

    // Taking those points back must leave the surface where it was: what the
    // union and the intersect hold between them is what the two held to begin.
    // Close rather than exact, because the faces the tool does cut lose a sliver.
    const moved = mapped(tool, move);
    const between = volume(result) + volume(booleanMesh('intersect', column, tool, move));
    expect(between).toBeCloseTo(volume(column) + volume(moved), 3);
  });

  // Running a stray point along an edge moves the line between two pieces of the
  // cut face, and a line moved too far folds a piece back over its neighbour, or
  // runs a ring over itself, or leaves one passing a corner twice. None of that
  // can be seen from the ring of the clear face, which comes out right regardless.
  it.each([
    { amount: 0.01, seed: 8, tool: () => createIcoSphere(0.08, 1), at: vec3(-0.25, 0.9, 0.3) },
    { amount: 0.002, seed: 6, tool: () => createIcoSphere(0.08, 1), at: vec3(0.4, 0.02, 0) },
    { amount: 0.01, seed: 25, tool: () => createBox(0.3), at: vec3(0.2, 0.4, -0.33) },
  ])('leaves the cut face sound when it clears its neighbour (seed $seed)', (trial) => {
    const column = ridgedColumn(trial.seed, trial.amount);
    const tool = trial.tool();
    const move = offsetBy(trial.at);
    const area = (mesh: BMesh) =>
      [...mesh.faces.values()].reduce((sum, face) => sum + polygonArea(mesh.facePoints(face)), 0);

    const union = booleanMesh('union', column, tool, move);
    const intersect = booleanMesh('intersect', column, tool, move);

    expect(union.validate()).toEqual([]);
    expect(
      [...union.faces.values()].filter((f) => crossesItself(union.facePoints(f))),
    ).toHaveLength(0);
    // Every stretch of either surface is on the outside of one of the two results,
    // so a piece folded over another shows up as ground counted twice.
    expect(area(union) + area(intersect)).toBeCloseTo(area(column) + area(tool), 2);
  });

  // Two that never meet still cut each other along every plane either has, and
  // the union of a part with something beside it used to come back with quads
  // of five and six corners and less volume than the two held between them.
  it.each([1, 21])('hands back both operands whole when they never touch (%i)', (seed) => {
    const column = ridgedColumn(seed);
    const tool = createBox(1.2);
    const move = (point: Vec3) => add(turnedBoxAt(0)(point), vec3(4, 0, 0));
    const expected = [...column.faces.values()].map((face) => ringOf(column.facePoints(face)));
    const moved = mapped(tool, move);
    for (const face of moved.faces.values()) expected.push(ringOf(moved.facePoints(face)));

    const result = booleanMesh('union', column, tool, move);
    const rings = new Set(
      [...result.faces.values()].map((face) => ringOf(result.facePoints(face))),
    );

    expect(expected.filter((ring) => !rings.has(ring))).toEqual([]);
    expect(result.faces.size).toBe(column.faces.size + tool.faces.size);
    expect(volume(result)).toBeCloseTo(volume(column) + volume(moved), 9);
  });

  // The BSP reads scraps of these faces as lying inside the other part, though
  // neither touches the other. A union used to carve eighteen extra faces out of
  // them and an intersect returned five faces of nothing at all; on another pair
  // a difference lost half a face from a part the tool never came near.
  it('takes no notice of what the cut reads into faces that touch nothing', () => {
    const diamond = meshFrom(APART_PAIR.diamond);
    const hook = meshFrom(APART_PAIR.hook);
    const same = (point: Vec3) => point;
    const ringsOf = (mesh: BMesh) =>
      [...mesh.faces.values()].map((f) => ringOf(mesh.facePoints(f)));

    const union = new Set(ringsOf(booleanMesh('union', diamond, hook, same)));
    expect(union.size).toBe(diamond.faces.size + hook.faces.size);
    expect([...ringsOf(diamond), ...ringsOf(hook)].filter((ring) => !union.has(ring))).toEqual([]);

    expect(booleanMesh('intersect', diamond, hook, same).faces.size).toBe(0);

    const left = new Set(ringsOf(booleanMesh('difference', diamond, hook, same)));
    expect(left.size).toBe(diamond.faces.size);
    expect(ringsOf(diamond).filter((ring) => !left.has(ring))).toEqual([]);
  });

  // Asked at its middle, a C-shaped face reads as lying inside whatever sits in
  // its notch, though no part of the face comes near it.
  it('asks whether a face is inside at a point on the face', () => {
    const notched = new BMesh();
    const outline: [number, number][] = [
      [0, 0],
      [3, 0],
      [3, 3],
      [0, 3],
      [0, 2.5],
      [2.5, 2.5],
      [2.5, 0.5],
      [0, 0.5],
    ];
    const low = outline.map(([x, z]) => notched.addVert(vec3(x, 0, z)));
    const high = outline.map(([x, z]) => notched.addVert(vec3(x, 1, z)));
    notched.addFace([...low]);
    notched.addFace([...high].reverse());
    outline.forEach((_, i) => {
      const j = (i + 1) % outline.length;
      notched.addFace([low[j], low[i], high[i], high[j]]);
    });
    notched.computeNormals();

    // Tall enough to stand through the plane of the C, in the middle of its notch.
    const pillar = (point: Vec3) => vec3(point.x + 1.5, point.y * 3 + 0.5, point.z + 1.5);
    const result = booleanMesh('union', notched, createBox(1), pillar);

    expect(result.faces.size).toBe(notched.faces.size + 6);
  });

  // A sheet makes no cavity, so there is nothing for it to line, and it holds
  // no inside for anything to be kept in. Only a solid can claim a face.
  it('takes nothing away with a sheet buried in a solid, and keeps it on an intersect', () => {
    const target = createBox(4);
    const sheet = createPlane(1);
    const move = turnedBoxAt(0);

    const left = booleanMesh('difference', target, sheet, move);
    expect(left.faces.size).toBe(target.faces.size);
    expect(volume(left)).toBeCloseTo(volume(target), 9);

    expect(booleanMesh('intersect', target, sheet, move).faces.size).toBe(sheet.faces.size);
  });

  // A bowl wraps most of the way round what sits in it, so it winds round that
  // point far enough to pass for a solid. It is still a surface, and a surface
  // has no inside to swallow anything with.
  it('does not let a bowl swallow what sits in it without touching', () => {
    const sphere = createUVSphere(2, 16, 8);
    const bowl = new BMesh();
    const verts = new Map<number, Vert>();
    for (const vert of sphere.verts.values()) verts.set(vert.id, bowl.addVert(vert.co));
    for (const face of sphere.faces.values()) {
      if (sphere.facePoints(face).every((point) => point.y >= -1e-9)) continue;
      bowl.addFace(sphere.faceVerts(face).map((vert) => verts.get(vert.id) as Vert));
    }
    bowl.computeNormals();

    const result = booleanMesh('union', bowl, createBox(0.5), offsetBy(vec3(0, -1.2, 0)));

    expect(result.faces.size).toBe(bowl.faces.size + 6);
  });

  // An open part wound inward is turned over along with the lids that close it
  // for the cut, and its faces have to turn with it: handed back as they came,
  // the far side of the part faced into it while the side that was cut faced out.
  it('turns an open part wound inward the same way all round, away from the cut', () => {
    const box = createBox(2);
    const open = new BMesh();
    const verts = new Map<number, Vert>();
    for (const vert of box.verts.values()) verts.set(vert.id, open.addVert(vert.co));
    for (const face of box.faces.values()) {
      if (box.facePoints(face).every((point) => point.y === 1)) continue;
      open.addFace(
        box
          .faceVerts(face)
          .map((vert) => verts.get(vert.id) as Vert)
          .reverse(),
      );
    }
    open.computeNormals();

    const farWall = [...box.faces.values()]
      .map((face) => box.facePoints(face))
      .find((points) => points.every((point) => point.x === -1)) as Vec3[];

    // Bites the wall at x = 1, leaving the one at x = -1 well clear.
    const result = booleanMesh('union', open, createBox(0.5), offsetBy(vec3(1, -0.5, 0)));
    const rings = new Set(
      [...result.faces.values()].map((face) => ringOf(result.facePoints(face))),
    );

    expect(rings.has(ringOf(farWall))).toBe(true);
  });

  // Two shells in one object can stand on either side of the other operand's
  // surface, so one's answer is no answer for the other.
  it('settles separate shells of one object each on its own', () => {
    const shells = mapped(createBox(1), (point) => point);
    const beside = mapped(createBox(1), offsetBy(vec3(5, 0, 0)));
    const verts = new Map<number, Vert>();
    for (const vert of beside.verts.values()) verts.set(vert.id, shells.addVert(vert.co));
    for (const face of beside.faces.values()) {
      shells.addFace(beside.faceVerts(face).map((vert) => verts.get(vert.id) as Vert));
    }
    shells.computeNormals();

    // Swallows the first shell whole and comes nowhere near the second.
    const result = booleanMesh('union', shells, createBox(3), (point) => point);

    expect(result.faces.size).toBe(12);
    expect(volume(result)).toBeCloseTo(28, 9);
  });

  // The walls of a cavity are the tool's faces turned inside out, and they come
  // back whole from a tool that never reaches the surface: facing out of the
  // tool they would seal the cavity off as a second solid inside the first.
  it('hands back a buried tool as the cut needs it, wound as the cut left it', () => {
    const target = createBox(4);
    const tool = createBox(1);
    const move = (point: Vec3) => turnedBoxAt(0)(point);
    const moved = mapped(tool, move);
    const toolRings = [...moved.faces.values()].map((face) => moved.facePoints(face));

    const ringsOf = (mesh: BMesh) =>
      new Set([...mesh.faces.values()].map((face) => ringOf(mesh.facePoints(face))));

    const cavity = booleanMesh('difference', target, tool, move);
    const walls = ringsOf(cavity);
    expect(toolRings.every((ring) => walls.has(ringOf([...ring].reverse())))).toBe(true);
    expect(volume(cavity)).toBeCloseTo(volume(target) - volume(moved), 9);

    const kept = ringsOf(booleanMesh('intersect', target, tool, move));
    expect(kept.size).toBe(toolRings.length);
    expect(toolRings.every((ring) => kept.has(ringOf(ring)))).toBe(true);

    const swallowed = booleanMesh('union', target, tool, move);
    expect(swallowed.faces.size).toBe(target.faces.size);
    expect(volume(swallowed)).toBeCloseTo(volume(target), 9);
  });

  // A vertex of one face lying on the edge of the next, with no edge of its own
  // there, is a crack the model already had. Closing it handed the wide quad back
  // with five corners, however far away the cut was. Running the vertex along
  // the edge to a corner to get it off the quad would be worse: the ridge ending
  // on it would move, and the model with it. So it stays, whichever of the faces
  // beside the crack the tool reaches.
  it.each([
    { reached: 'nothing beside the crack', tool: vec3(5, 0.5, 0) },
    { reached: 'the faces beside the crack', tool: vec3(2, 1.5, 0) },
  ])('leaves a crack the mesh already had as it was, with $reached cut', ({ tool }) => {
    const mesh = new BMesh();
    const add3 = (x: number, y: number, z: number) => mesh.addVert(vec3(x, y, z));
    // A slab whose top is one wide quad butted against a two-faced roof, whose
    // ridge runs from `mid` down to a vertex part-way along the wide quad's edge.
    const [a, b, c, d] = [add3(-2, 1, -1), add3(0, 1, -1), add3(0, 1, 1), add3(-2, 1, 1)];
    const [e, f, ridge, mid] = [add3(2, 1, -1), add3(2, 1, 1), add3(0, 1, 0), add3(2, 1.5, 0)];
    const [h, i, j, k] = [add3(-2, 0, -1), add3(2, 0, -1), add3(2, 0, 1), add3(-2, 0, 1)];
    mesh.addFace([a, d, c, b]);
    mesh.addFace([b, ridge, mid, e]);
    mesh.addFace([ridge, c, f, mid]);
    mesh.addFace([h, i, j, k]);
    mesh.addFace([a, b, e, i, h]);
    mesh.addFace([e, mid, f, j, i]);
    mesh.addFace([f, c, d, k, j]);
    mesh.addFace([d, a, h, k]);
    mesh.computeNormals();

    const result = booleanMesh('union', mesh, createBox(0.4), offsetBy(tool));
    const rings = new Set(
      [...result.faces.values()].map((face) => ringOf(result.facePoints(face))),
    );
    const points = [...result.verts.values()].map((vert) => vert.co);

    expect(rings.has(ringOf([a, d, c, b].map((vert) => vert.co)))).toBe(true);
    expect(points.some((point) => point.x === 0 && point.y === 1 && point.z === 0)).toBe(true);
  });

  // A corner on a straight edge bends nothing, so it looked like one of the
  // split's own stray points, and went: from both faces it belonged to, on a
  // stretch of the model the cut never came near.
  it('keeps a corner left on a straight edge, far from the cut', () => {
    const mesh = createBox(2);
    const [top] = [...mesh.faces.values()].filter((face) =>
      mesh.facePoints(face).every((point) => point.y === 1),
    );
    const beside = [...mesh.faces.values()].find(
      (face) =>
        face !== top &&
        mesh.faceVerts(face).filter((vert) => mesh.faceVerts(top).includes(vert)).length === 2,
    ) as Face;
    const shared = mesh.faceVerts(top).filter((vert) => mesh.faceVerts(beside).includes(vert));
    const halfway = mesh.addVert(
      vec3(
        (shared[0].co.x + shared[1].co.x) / 2,
        (shared[0].co.y + shared[1].co.y) / 2,
        (shared[0].co.z + shared[1].co.z) / 2,
      ),
    );
    const widen = (face: Face) => {
      const ring = mesh.faceVerts(face);
      const at = ring.findIndex(
        (vert, index) => shared.includes(vert) && shared.includes(ring[(index + 1) % ring.length]),
      );
      ring.splice(at + 1, 0, halfway);
      mesh.removeFace(face);
      return ring;
    };
    const rings = [widen(top), widen(beside)];
    for (const ring of rings) mesh.addFace(ring);
    mesh.computeNormals();

    // Under the box, away from both of the faces carrying the corner.
    const result = booleanMesh('union', mesh, createBox(0.5), offsetBy(vec3(0, -1, 0)));
    const out = new Set([...result.faces.values()].map((face) => ringOf(result.facePoints(face))));

    for (const ring of rings) expect(out.has(ringOf(ring.map((vert) => vert.co)))).toBe(true);
  });

  // The tidying pass pairs a seam triangle with the coplanar triangle beside it,
  // and only asked whether the first of the two was its to change. A triangle
  // the cut never reshaped was taken as the second and came back part of a quad.
  it('does not pair a triangle the cut left alone into a quad with one it cut', () => {
    const mesh = new BMesh();
    const add3 = (x: number, y: number, z: number) => mesh.addVert(vec3(x, y, z));
    const [a, b, c, d] = [add3(-1, 1, -1), add3(1, 1, -1), add3(1, 1, 1), add3(-1, 1, 1)];
    const [e, f, g, h] = [add3(-1, -1, -1), add3(1, -1, -1), add3(1, -1, 1), add3(-1, -1, 1)];
    mesh.addFace([a, c, b]);
    mesh.addFace([a, d, c]);
    mesh.addFace([e, f, g, h]);
    mesh.addFace([a, b, f, e]);
    mesh.addFace([b, c, g, f]);
    mesh.addFace([c, d, h, g]);
    mesh.addFace([d, a, e, h]);
    mesh.computeNormals();

    // A wedge with its point on corner `a`, biting the far corner of one top
    // triangle along a line from `a`, so what is left of it is still a triangle.
    const tool = new BMesh();
    const wedge = (y: number) => [
      tool.addVert(vec3(-1, y, -1)),
      tool.addVert(vec3(2, y, -2)),
      tool.addVert(vec3(4, y, 1.5)),
    ];
    const [low, high] = [wedge(0.5), wedge(1.5)];
    tool.addFace([low[0], low[1], low[2]]);
    tool.addFace([high[2], high[1], high[0]]);
    tool.addFace([low[1], low[0], high[0], high[1]]);
    tool.addFace([low[2], low[1], high[1], high[2]]);
    tool.addFace([low[0], low[2], high[2], high[0]]);
    tool.computeNormals();

    const result = booleanMesh('union', mesh, tool, (point) => point);
    const rings = new Set(
      [...result.faces.values()].map((face) => ringOf(result.facePoints(face))),
    );

    expect(rings.has(ringOf([a, d, c].map((vert) => vert.co)))).toBe(true);
  });

  it.each([1, 21])('leaves a long part as it came in when a cut bites its end (%i)', (seed) => {
    const column = ridgedColumn(seed);
    const tool = createBox(1.2);
    const move = turnedBoxAt(-3);
    const clear = clearOf(tool, move, 0.05);
    const expected = clearRings(column, clear);

    const result = booleanMesh('difference', column, tool, move);
    const rings = new Set(
      [...result.faces.values()].map((face) => ringOf(result.facePoints(face))),
    );

    expect(expected.filter((ring) => !rings.has(ring))).toEqual([]);
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

  it('unions a filled circle with a box without slicing half the box away', () => {
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

  /** How many pieces the mesh falls into, following edges from vertex to vertex. */
  function pieces(mesh: BMesh): number {
    const seen = new Set<number>();
    let count = 0;
    for (const start of mesh.verts.values()) {
      if (seen.has(start.id)) continue;
      count += 1;
      seen.add(start.id);
      const stack = [start];
      while (stack.length > 0) {
        const vert = stack.pop() as Vert;
        for (const edge of vert.edges) {
          const other = mesh.edgeOther(edge, vert);
          if (seen.has(other.id)) continue;
          seen.add(other.id);
          stack.push(other);
        }
      }
    }
    return count;
  }

  /** A 6 by 1 strip lying flat, turned about Y by `degrees`. */
  const strip = (degrees: number) => {
    const turn = (degrees * Math.PI) / 180;
    return (point: Vec3): Vec3 => {
      const x = point.x * 6;
      return {
        x: x * Math.cos(turn) + point.z * Math.sin(turn),
        y: point.y,
        z: -x * Math.sin(turn) + point.z * Math.cos(turn),
      };
    };
  };

  it('joins two surfaces lying in one plane where their outlines cross', () => {
    // Two strips crossed like an X. Neither has an inside, and they used to come
    // back as two sheets stacked over the middle with no vertex in common.
    const flat = (degrees: number) => {
      const mesh = createPlane(1);
      for (const vert of mesh.verts.values()) vert.co = strip(degrees)(vert.co);
      mesh.computeNormals();
      return mesh;
    };
    const result = booleanMesh('union', flat(0), createPlane(1), strip(60));

    expect(pieces(result)).toBe(1);

    // One sheet, so the faces cover the union once: both strips, less the
    // rhombus where they cross, counted a single time.
    const crossing = 1 / Math.sin(Math.PI / 3);
    expect(surfaceArea(result)).toBeCloseTo(12 - crossing, 6);

    // Each of the four points where an outline crosses the other is a vertex.
    const corners = [...result.verts.values()].filter(
      (vert) => Math.abs(Math.abs(vert.co.z) - 0.5) < 1e-9 && Math.abs(vert.co.x) < 1,
    );
    expect(corners).toHaveLength(4);
    for (const vert of corners) expect(vert.edges.length).toBe(3);
  });

  it('joins a surface to a solid along the line where it passes through', () => {
    // The box takes the part of the plane inside it, and the plane marks the
    // box in return: each wall is split where the plane leaves it, so the two
    // share the four edges the plane hangs off rather than merely meeting.
    for (const [target, tool] of [
      [createBox(2), createPlane(4)],
      [createPlane(4), createBox(2)],
    ] as const) {
      const result = booleanMesh('union', target, tool, offsetBy(vec3()));

      expect(pieces(result)).toBe(1);
      const seams = [...result.edges.values()].filter((edge) => edge.loops.length === 3);
      expect(seams).toHaveLength(4);
      expect(areaAt(result, 1)).toBeCloseTo(4, 6);
      expect(areaAt(result, 0)).toBeCloseTo(16 - 4, 6);
    }
  });

  it('keeps one sheet where a surface lies flat on a face of a solid', () => {
    for (const [target, tool, shift, top] of [
      [createBox(2), createPlane(3), vec3(0, 1, 0), 1],
      [createPlane(3), createBox(2), vec3(0, -1, 0), 0],
    ] as const) {
      const result = booleanMesh('union', target, tool, offsetBy(shift));

      expect(pieces(result)).toBe(1);
      // The box's top and the plane round it, with nothing laid twice: the
      // other five faces of the box and nine square metres of sheet.
      expect(areaAt(result, top)).toBeCloseTo(9, 6);
      expect(surfaceArea(result)).toBeCloseTo(5 * 4 + 9, 6);
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

  it('cuts one surface with another lying in the same plane', () => {
    // Two planes have no inside, so this used to hand the target back whole
    // while the cutter was still consumed.
    const notched = booleanMesh('difference', createPlane(2), createPlane(2), offsetBy(vec3(1)));

    expect(areaAt(notched, 0)).toBeCloseTo(2, 6);
    expect(surfaceArea(notched)).toBeCloseTo(2, 6);
    expect(notched.faces.size).toBe(1);
    expect(Math.max(...[...notched.verts.values()].map((vert) => vert.co.x))).toBeCloseTo(0, 6);

    const holed = booleanMesh('difference', createPlane(4), createPlane(1), offsetBy(vec3()));

    expect(surfaceArea(holed)).toBeCloseTo(15, 6);
    expect(pieces(holed)).toBe(1);
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

  /** The 2 m box with its top taken away, as a part separated off a model is left open. */
  function topless(): BMesh {
    const mesh = createBox(2);
    const top = [...mesh.faces.values()].find((face) =>
      mesh.facePoints(face).every((point) => point.y === 1),
    ) as Face;
    mesh.removeFace(top);
    mesh.computeNormals();
    return mesh;
  }

  it('cuts a part left open where it was separated as the solid it is', () => {
    // Open at the top, the box leans by the face it lacks, and read as a
    // surface it had no inside: a union kept the whole of the tool, the half
    // buried in the box included. Ribs stuck into a pillar separated off a
    // sword came back with their walls running on inside it, and a line along
    // each rib where the pillar passed through.
    for (const [target, tool, shift, centre] of [
      [topless(), createBox(1), vec3(1, 0, 0), vec3()],
      [createBox(1), topless(), vec3(-1, 0, 0), vec3(-1, 0, 0)],
    ] as const) {
      const result = booleanMesh('union', target, tool, offsetBy(shift));

      const buried = [...result.faces.values()].filter((face) => {
        const at = centroid(result.facePoints(face));
        const reach = Math.max(
          Math.abs(at.x - centre.x),
          Math.abs(at.y - centre.y),
          Math.abs(at.z - centre.z),
        );
        return reach < 1 - 1e-9;
      });
      expect(buried.length).toBe(0);
      expect([...result.edges.values()].filter((edge) => edge.loops.length > 2).length).toBe(0);

      // The top stays open: whatever closed it for the cut is gone again.
      expect([...result.edges.values()].filter((edge) => edge.loops.length === 1).length).toBe(4);
    }
  });

  it('reads nothing past the opening of an open part as inside it', () => {
    // Read straight off the walls, everything over the box's footprint lies
    // behind every one of them, so a union with anything sitting above the
    // opening would throw it away. Closing the rim for the cut is what stops it.
    const result = booleanMesh('union', topless(), createBox(1), offsetBy(vec3(0, 2, 0)));

    expect(result.faces.size).toBe(5 + 6);
  });
});
