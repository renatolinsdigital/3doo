import { describe, expect, it } from 'vitest';

import { cross, dot } from '../math';
import type { BMesh } from '../mesh';

import { type Point2, createLathe, createOutlinePrism } from './fromPoints';

/** Positive when every face points out of the solid, and the solid's volume then. */
function signedVolume(mesh: BMesh): number {
  let volume = 0;
  for (const face of mesh.faces.values()) {
    const [first, ...rest] = mesh.facePoints(face);
    for (let i = 0; i < rest.length - 1; i++) {
      volume += dot(first, cross(rest[i], rest[i + 1])) / 6;
    }
  }
  return volume;
}

const euler = (mesh: BMesh) => mesh.verts.size - mesh.edges.size + mesh.faces.size;
const closed = (mesh: BMesh) => [...mesh.edges.values()].every((edge) => edge.loops.length === 2);

function extent(mesh: BMesh, axis: 'x' | 'y' | 'z'): [number, number] {
  const values = [...mesh.verts.values()].map((vert) => vert.co[axis]);
  return [Math.min(...values), Math.max(...values)];
}

const BOTTLE: Point2[] = [
  [0, 0],
  [0.3, 0],
  [0.3, 0.6],
  [0.1, 0.8],
  [0.1, 1],
];

describe('a lathe', () => {
  it('turns a profile into a closed solid, a point on the axis closing it with no hole', () => {
    const mesh = createLathe(BOTTLE, { segments: 8 });

    expect(mesh.verts.size).toBe(1 + 4 * 8);
    expect(mesh.faces.size).toBe(8 + 3 * 8 + 1);
    expect(mesh.validate()).toEqual([]);
    expect(closed(mesh)).toBe(true);
    expect(euler(mesh)).toBe(2);
    expect(signedVolume(mesh)).toBeGreaterThan(0);
    expect(extent(mesh, 'y')).toEqual([0, 1]);
    expect(extent(mesh, 'x')[1]).toBeCloseTo(0.3);
  });

  it('faces outward whichever way the profile is written', () => {
    const up = createLathe(BOTTLE, { segments: 12 });
    const down = createLathe([...BOTTLE].reverse(), { segments: 12 });

    expect(signedVolume(down)).toBeCloseTo(signedVolume(up));
    expect(signedVolume(down)).toBeGreaterThan(0);
  });

  it('comes close to the volume of the solid it stands for', () => {
    const cylinder = createLathe(
      [
        [0.5, 0],
        [0.5, 2],
      ],
      { segments: 64 },
    );

    expect(closed(cylinder)).toBe(true);
    expect(signedVolume(cylinder)).toBeCloseTo(Math.PI * 0.25 * 2, 1);
  });

  it('leaves an end open when asked, as a tube', () => {
    const tube = createLathe(
      [
        [0.5, 0],
        [0.5, 1],
      ],
      { segments: 6, caps: false },
    );

    expect(tube.faces.size).toBe(6);
    expect(tube.validate()).toEqual([]);
    expect(closed(tube)).toBe(false);
  });

  it('turns a loop into a ring with a hole through it', () => {
    const ring = createLathe(
      [
        [1, -0.1],
        [1.2, -0.1],
        [1.2, 0.1],
        [1, 0.1],
      ],
      { segments: 16, closed: true },
    );

    expect(ring.faces.size).toBe(4 * 16);
    expect(ring.validate()).toEqual([]);
    expect(closed(ring)).toBe(true);
    expect(euler(ring)).toBe(0);
    expect(signedVolume(ring)).toBeGreaterThan(0);
  });

  it('refuses a profile with too few points', () => {
    expect(() => createLathe([[1, 0]])).toThrow(/two or more/);
    expect(() =>
      createLathe(
        [
          [1, 0],
          [1, 0],
        ],
        { closed: true },
      ),
    ).toThrow(/three or more/);
  });
});

/** An L, 2 tall, with a foot 1 long: area 1.25. */
const L: Point2[] = [
  [0, 0],
  [1, 0],
  [1, 0.5],
  [0.5, 0.5],
  [0.5, 2],
  [0, 2],
];

describe('an outline made solid', () => {
  it('keeps the outline as one face each side, however concave', () => {
    const mesh = createOutlinePrism(L, { plane: ['x', 'y'], depth: 0.2 });

    expect(mesh.verts.size).toBe(12);
    expect(mesh.faces.size).toBe(2 + 6);
    expect(mesh.validate()).toEqual([]);
    expect(closed(mesh)).toBe(true);
    expect(euler(mesh)).toBe(2);
    expect(signedVolume(mesh)).toBeCloseTo(1.25 * 0.2);
    expect(extent(mesh, 'z')).toEqual([-0.1, 0.1]);
    expect(extent(mesh, 'y')).toEqual([0, 2]);
  });

  it('faces outward on every plane and either way round', () => {
    for (const plane of [
      ['x', 'y'],
      ['z', 'y'],
      ['x', 'z'],
    ] as const) {
      for (const points of [L, [...L].reverse()]) {
        const mesh = createOutlinePrism(points, { plane, depth: 0.5 });
        expect(signedVolume(mesh)).toBeCloseTo(1.25 * 0.5);
      }
    }
  });

  it('puts the points on the axes it is told', () => {
    const side = createOutlinePrism(L, { plane: ['z', 'y'], depth: 0.2 });
    expect(extent(side, 'z')).toEqual([0, 1]);
    expect(extent(side, 'y')).toEqual([0, 2]);
    expect(extent(side, 'x')).toEqual([-0.1, 0.1]);

    const plan = createOutlinePrism(L, { plane: ['x', 'z'], depth: 0.2 });
    expect(extent(plan, 'z')).toEqual([0, 2]);
    expect(extent(plan, 'y')).toEqual([-0.1, 0.1]);
  });

  it('drops a repeated point, the first written again at the end included', () => {
    const mesh = createOutlinePrism([L[0], ...L, L[0]], {
      plane: ['x', 'y'],
      depth: 0.2,
    });
    expect(mesh.verts.size).toBe(12);
  });

  it('rounds off the rims of both faces when asked', () => {
    const plain = createOutlinePrism(L, { plane: ['x', 'y'], depth: 0.2 });
    const bevelled = createOutlinePrism(L, {
      plane: ['x', 'y'],
      depth: 0.2,
      bevel: 0.03,
      bevelSegments: 2,
    });

    expect(bevelled.validate()).toEqual([]);
    expect(closed(bevelled)).toBe(true);
    expect(euler(bevelled)).toBe(2);
    expect(bevelled.faces.size).toBeGreaterThan(plain.faces.size);
    expect(signedVolume(bevelled)).toBeLessThan(signedVolume(plain));
    expect(signedVolume(bevelled)).toBeGreaterThan(signedVolume(plain) * 0.8);
  });

  it('refuses an outline that encloses nothing', () => {
    expect(() =>
      createOutlinePrism(
        [
          [0, 0],
          [1, 0],
        ],
        { plane: ['x', 'y'], depth: 1 },
      ),
    ).toThrow(/three or more/);
    expect(() =>
      createOutlinePrism(
        [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        { plane: ['x', 'y'], depth: 1 },
      ),
    ).toThrow(/no area/);
  });
});
