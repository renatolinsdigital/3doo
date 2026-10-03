import { describe, expect, it } from 'vitest';

import { execOperator } from '../commands/operators';
import { type Vec3, dot, vec3 } from '../math';
import { BMesh } from '../mesh';
import type { Face, Vert } from '../mesh/types';
import { createBox, createGrid, createImagePlane, createPlane } from '../primitives';

import { type KnifePoint, knifeCut, knifeSegmentFace } from './knife';

function vertAt(mesh: BMesh, x: number, y: number, z: number): Vert {
  const found = [...mesh.verts.values()].find(
    (vert) =>
      Math.abs(vert.co.x - x) < 1e-9 &&
      Math.abs(vert.co.y - y) < 1e-9 &&
      Math.abs(vert.co.z - z) < 1e-9,
  );
  if (!found) throw new Error(`no vertex at ${x}, ${y}, ${z}`);
  return found;
}

/** A point `along` of the way from `a` to `b`, whichever way round the edge was built. */
function onEdge(mesh: BMesh, a: Vert, b: Vert, along = 0.5): KnifePoint {
  const edge = mesh.findEdge(a, b);
  if (!edge) throw new Error(`no edge between ${a.id} and ${b.id}`);
  return { kind: 'edge', edge: edge.id, t: edge.v0 === a ? along : 1 - along };
}

function atVert(vert: Vert): KnifePoint {
  return { kind: 'vert', vert: vert.id };
}

function inFace(face: Face, co: Vec3): KnifePoint {
  return { kind: 'face', face: face.id, co };
}

function onlyFace(mesh: BMesh): Face {
  const [face] = mesh.faces.values();
  return face;
}

/** The plane's corners, named by where they sit when looked at from above. */
function planeCorners(plane: BMesh) {
  return {
    nearLeft: vertAt(plane, -1, 0, 1),
    nearRight: vertAt(plane, 1, 0, 1),
    farRight: vertAt(plane, 1, 0, -1),
    farLeft: vertAt(plane, -1, 0, -1),
  };
}

function corners(mesh: BMesh, face: Face): number {
  return mesh.faceVerts(face).length;
}

function eulerCharacteristic(mesh: BMesh): number {
  return mesh.verts.size - mesh.edges.size + mesh.faces.size;
}

describe('knifeCut', () => {
  it('divides a face along a line from one edge to the opposite one', () => {
    const plane = createPlane(2);
    const { nearLeft, nearRight, farRight, farLeft } = planeCorners(plane);

    const result = knifeCut(plane, [
      [onEdge(plane, farLeft, nearLeft), onEdge(plane, nearRight, farRight)],
    ]);

    expect(result.splits).toBe(1);
    expect(result.loose).toBe(0);
    expect(result.verts).toHaveLength(2);
    expect(plane.faces.size).toBe(2);
    expect(plane.verts.size).toBe(6);
    // Four border pieces either side of the new vertices, two untouched sides,
    // and the cut itself.
    expect(plane.edges.size).toBe(7);
    for (const face of plane.faces.values()) expect(corners(plane, face)).toBe(4);
    expect(plane.validate()).toEqual([]);

    const left = vertAt(plane, -1, 0, 0);
    const right = vertAt(plane, 1, 0, 0);
    const edge = plane.findEdge(left, right);
    expect(edge).not.toBeNull();
    expect(result.edges).toContain(edge);
  });

  it('runs corner to corner like a connect', () => {
    const plane = createPlane(2);
    const { nearLeft, farRight } = planeCorners(plane);

    const result = knifeCut(plane, [[atVert(nearLeft), atVert(farRight)]]);

    expect(result.splits).toBe(1);
    expect(result.verts).toHaveLength(0);
    expect(plane.faces.size).toBe(2);
    for (const face of plane.faces.values()) expect(corners(plane, face)).toBe(3);
    expect(plane.findEdge(nearLeft, farRight)).not.toBeNull();
    expect(plane.validate()).toEqual([]);
  });

  it('bends at a point clicked inside the face, which both halves then share', () => {
    const plane = createPlane(2);
    const { nearLeft, nearRight, farRight, farLeft } = planeCorners(plane);
    const face = onlyFace(plane);

    const result = knifeCut(plane, [
      [
        onEdge(plane, farLeft, nearLeft),
        inFace(face, vec3(0, 0, 0.5)),
        onEdge(plane, nearRight, farRight),
      ],
    ]);

    expect(result.splits).toBe(1);
    expect(result.verts).toHaveLength(3);
    expect(plane.faces.size).toBe(2);

    const bend = vertAt(plane, 0, 0, 0.5);
    expect(plane.vertFaces(bend)).toHaveLength(2);
    for (const half of plane.faces.values()) expect(corners(plane, half)).toBe(5);
    expect(plane.validate()).toEqual([]);
  });

  it('keeps the face winding on both halves', () => {
    const plane = createPlane(2);
    const { nearLeft, farRight } = planeCorners(plane);

    knifeCut(plane, [[atVert(nearLeft), atVert(farRight)]]);

    for (const face of plane.faces.values()) expect(face.normal.y).toBeCloseTo(1);
  });

  it('crosses every face along the line, and the mesh stays closed', () => {
    const grid = createGrid(2, 2);
    const left = onEdge(grid, vertAt(grid, -1, 0, -1), vertAt(grid, -1, 0, 0));
    const middle = onEdge(grid, vertAt(grid, 0, 0, -1), vertAt(grid, 0, 0, 0));
    const right = onEdge(grid, vertAt(grid, 1, 0, -1), vertAt(grid, 1, 0, 0));

    const result = knifeCut(grid, [[left, middle, right]]);

    expect(result.splits).toBe(2);
    expect(result.verts).toHaveLength(3);
    expect(grid.faces.size).toBe(6);
    expect(grid.validate()).toEqual([]);
  });

  it('cuts round the corner of a box, leaving it closed', () => {
    const box = createBox(2);
    const back = onEdge(box, vertAt(box, -1, 1, -1), vertAt(box, 1, 1, -1));
    const rim = onEdge(box, vertAt(box, -1, 1, 1), vertAt(box, 1, 1, 1));
    const foot = onEdge(box, vertAt(box, -1, -1, 1), vertAt(box, 1, -1, 1));

    const result = knifeCut(box, [[back, rim, foot]]);

    expect(result.splits).toBe(2);
    expect(box.faces.size).toBe(8);
    expect(eulerCharacteristic(box)).toBe(2);
    for (const edge of box.edges.values()) expect(edge.loops).toHaveLength(2);
    expect(box.validate()).toEqual([]);
  });

  it('leaves a line that stops inside a face loose, dividing nothing', () => {
    const plane = createPlane(2);
    const { nearLeft, farLeft } = planeCorners(plane);
    const face = onlyFace(plane);

    const result = knifeCut(plane, [
      [onEdge(plane, farLeft, nearLeft), inFace(face, vec3(0, 0, 0))],
    ]);

    expect(result.splits).toBe(0);
    expect(result.loose).toBe(1);
    expect(plane.faces.size).toBe(1);

    const end = vertAt(plane, 0, 0, 0);
    expect(end.edges).toHaveLength(1);
    expect(end.edges[0].loops).toHaveLength(0);
    expect(plane.validate()).toEqual([]);
  });

  it('closes a run that comes back to where it began without doubling the cut', () => {
    const plane = createPlane(2);
    const { nearLeft, nearRight, farRight, farLeft } = planeCorners(plane);
    const start = onEdge(plane, farLeft, nearLeft);

    const result = knifeCut(plane, [[start, onEdge(plane, nearRight, farRight), { ...start }]]);

    expect(result.splits).toBe(1);
    expect(result.verts).toHaveLength(2);
    expect(plane.faces.size).toBe(2);
    expect(plane.validate()).toEqual([]);
  });

  it('divides both faces where two runs cross at a shared point', () => {
    const plane = createPlane(2);
    const { nearLeft, nearRight, farRight, farLeft } = planeCorners(plane);
    const face = onlyFace(plane);
    const centre = inFace(face, vec3(0, 0, 0));

    const result = knifeCut(plane, [
      [onEdge(plane, farLeft, nearLeft), centre, onEdge(plane, nearRight, farRight)],
      [onEdge(plane, nearLeft, nearRight), { ...centre }, onEdge(plane, farRight, farLeft)],
    ]);

    expect(result.splits).toBe(3);
    expect(result.verts).toHaveLength(5);
    expect(plane.faces.size).toBe(4);
    for (const quarter of plane.faces.values()) expect(corners(plane, quarter)).toBe(4);
    expect(plane.vertFaces(vertAt(plane, 0, 0, 0))).toHaveLength(4);
    expect(plane.validate()).toEqual([]);
  });

  it('finds where two runs cross inside a face and divides both there', () => {
    const plane = createPlane(2);
    const { nearLeft, nearRight, farRight, farLeft } = planeCorners(plane);
    const across = [onEdge(plane, farLeft, nearLeft), onEdge(plane, nearRight, farRight)];
    const down = [onEdge(plane, nearLeft, nearRight), onEdge(plane, farRight, farLeft)];

    const result = knifeCut(plane, [across, down]);

    expect(result.splits).toBe(3);
    expect(plane.faces.size).toBe(4);
    for (const quarter of plane.faces.values()) expect(corners(plane, quarter)).toBe(4);
    expect(plane.vertFaces(vertAt(plane, 0, 0, 0))).toHaveLength(4);
    expect(plane.validate()).toEqual([]);
  });

  it('divides a face along a run that ends on another one', () => {
    const plane = createPlane(2);
    const { nearLeft, nearRight, farRight, farLeft } = planeCorners(plane);
    const face = onlyFace(plane);

    const result = knifeCut(plane, [
      [onEdge(plane, farLeft, nearLeft), onEdge(plane, nearRight, farRight)],
      [onEdge(plane, nearLeft, nearRight), inFace(face, vec3(0, 0, 0))],
    ]);

    expect(result.splits).toBe(2);
    expect(result.loose).toBe(0);
    expect(plane.faces.size).toBe(3);
    expect(plane.validate()).toEqual([]);
  });

  it('cuts the same whichever order the lines come in', () => {
    const cutInOrder = (reverse: boolean) => {
      const plane = createPlane(2);
      const { nearLeft, nearRight, farRight, farLeft } = planeCorners(plane);
      const face = onlyFace(plane);
      const runs = [
        [onEdge(plane, farLeft, nearLeft), inFace(face, vec3(-0.2, 0, 0.1))],
        [inFace(face, vec3(-0.2, 0, 0.1)), onEdge(plane, nearRight, farRight)],
        [onEdge(plane, nearLeft, nearRight, 0.3), onEdge(plane, farRight, farLeft, 0.7)],
      ];
      knifeCut(plane, reverse ? [...runs].reverse() : runs);
      return { faces: plane.faces.size, verts: plane.verts.size, problems: plane.validate() };
    };

    expect(cutInOrder(false)).toEqual(cutInOrder(true));
    expect(cutInOrder(false).faces).toBe(4);
  });

  it('adds nothing for a run along an edge already there', () => {
    const plane = createPlane(2);
    const { nearLeft, nearRight } = planeCorners(plane);

    const result = knifeCut(plane, [[atVert(nearLeft), atVert(nearRight)]]);

    expect(result.verts).toHaveLength(0);
    expect(result.splits).toBe(0);
    expect(result.loose).toBe(0);
    expect(result.edges).toEqual([plane.findEdge(nearLeft, nearRight)]);
    expect(plane.faces.size).toBe(1);
  });

  it('cuts nothing for a run of one point, not even the edge it is on', () => {
    const plane = createPlane(2);
    const { nearLeft, farLeft } = planeCorners(plane);

    const result = knifeCut(plane, [[onEdge(plane, farLeft, nearLeft)]]);

    expect(result.verts).toHaveLength(0);
    expect(plane.verts.size).toBe(4);
    expect(plane.edges.size).toBe(4);
  });

  it('skips points naming geometry the mesh no longer has', () => {
    const plane = createPlane(2);
    const { nearLeft, farRight } = planeCorners(plane);

    const result = knifeCut(plane, [
      [
        atVert(nearLeft),
        { kind: 'vert', vert: 999 },
        { kind: 'edge', edge: 999, t: 0.5 },
        atVert(farRight),
      ],
    ]);

    expect(result.splits).toBe(1);
    expect(plane.validate()).toEqual([]);
  });

  it('takes a point at the very end of an edge as the vertex there', () => {
    const plane = createPlane(2);
    const { nearLeft, farLeft, farRight } = planeCorners(plane);

    const result = knifeCut(plane, [[onEdge(plane, farLeft, nearLeft, 1), atVert(farRight)]]);

    expect(result.verts).toHaveLength(0);
    expect(plane.findEdge(nearLeft, farRight)).not.toBeNull();
  });

  it('carries the UVs of an image plane through the cut', () => {
    const image = createImagePlane(2, 2);
    const face = onlyFace(image);
    const bottomLeft = vertAt(image, -1, -1, 0);
    const topLeft = vertAt(image, -1, 1, 0);
    const bottomRight = vertAt(image, 1, -1, 0);
    const topRight = vertAt(image, 1, 1, 0);

    knifeCut(image, [
      [
        onEdge(image, bottomLeft, topLeft, 0.25),
        inFace(face, vec3(0.2, 0.3, 0)),
        onEdge(image, bottomRight, topRight, 0.75),
      ],
    ]);

    // The picture is laid on flat, so every corner's UV is its position mapped
    // straight across from the plane onto the unit square.
    for (const cut of image.faces.values()) {
      for (const loop of image.faceLoops(cut)) {
        expect(loop.uv.u).toBeCloseTo((loop.vert.co.x + 1) / 2);
        expect(loop.uv.v).toBeCloseTo((loop.vert.co.y + 1) / 2);
      }
    }
  });

  it('keeps a sharp edge sharp on both sides of the cut', () => {
    const plane = createPlane(2);
    const { nearLeft, nearRight, farRight, farLeft } = planeCorners(plane);
    const border = plane.findEdge(farLeft, nearLeft);
    if (!border) throw new Error('no border edge');
    border.sharp = true;

    knifeCut(plane, [[onEdge(plane, farLeft, nearLeft), onEdge(plane, nearRight, farRight)]]);

    const middle = vertAt(plane, -1, 0, 0);
    expect(plane.findEdge(farLeft, middle)?.sharp).toBe(true);
    expect(plane.findEdge(middle, nearLeft)?.sharp).toBe(true);
    expect(plane.findEdge(middle, vertAt(plane, 1, 0, 0))?.sharp).toBe(false);
  });
});

describe('knifeSegmentFace', () => {
  /** An L in the ground plane: a 2 x 1 bar with a 1 x 1 block standing on its left half. */
  function lShape(): BMesh {
    const mesh = new BMesh();
    const points = [
      vec3(0, 0, 0),
      vec3(2, 0, 0),
      vec3(2, 0, -1),
      vec3(1, 0, -1),
      vec3(1, 0, -2),
      vec3(0, 0, -2),
    ];
    mesh.addFace(points.map((point) => mesh.addVert(point)));
    return mesh;
  }

  it('names the face a piece runs across', () => {
    const plane = createPlane(2);
    const { nearLeft, farRight } = planeCorners(plane);

    expect(knifeSegmentFace(plane, atVert(nearLeft), atVert(farRight))).toBe(onlyFace(plane));
  });

  it('names none for a piece cutting across the outside of a face that bends back', () => {
    const mesh = lShape();
    const tip = onEdge(mesh, vertAt(mesh, 2, 0, 0), vertAt(mesh, 2, 0, -1), 0.9);
    const top = onEdge(mesh, vertAt(mesh, 1, 0, -1), vertAt(mesh, 1, 0, -2), 0.9);
    const corner = atVert(vertAt(mesh, 0, 0, 0));

    // From the end of the bar to the top of the block runs over the notch.
    expect(knifeSegmentFace(mesh, tip, top)).toBeNull();
    expect(knifeSegmentFace(mesh, tip, corner)).toBe(onlyFace(mesh));
  });

  it('names none for points on one edge', () => {
    const plane = createPlane(2);
    const { nearLeft, nearRight } = planeCorners(plane);

    expect(
      knifeSegmentFace(plane, onEdge(plane, nearLeft, nearRight, 0.2), atVert(nearRight)),
    ).toBeNull();
  });
});

describe('the knife operator', () => {
  const context = (mesh: BMesh) => ({ mesh, selectMode: 'edge' as const, cursor: vec3() });

  it('cuts, and leaves the cut selected with nothing else', () => {
    const plane = createPlane(2);
    const { nearLeft, nearRight, farRight, farLeft } = planeCorners(plane);
    plane.selectAll();

    const result = execOperator(context(plane), 'knife', {
      cuts: [[onEdge(plane, farLeft, nearLeft), onEdge(plane, nearRight, farRight)]],
    });

    expect(result.refused).toBeUndefined();
    expect(result.status).toBe('Knife cut 1 face(s), adding 2 vertex(es)');
    expect(result.createdVerts).toHaveLength(2);

    const selected = plane.selectedEdges();
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(plane.findEdge(vertAt(plane, -1, 0, 0), vertAt(plane, 1, 0, 0)));
    expect(plane.selectedFaces()).toHaveLength(0);
  });

  it('says when part of the cut is left loose', () => {
    const plane = createPlane(2);
    const { nearLeft, farLeft } = planeCorners(plane);

    const result = execOperator(context(plane), 'knife', {
      cuts: [[onEdge(plane, farLeft, nearLeft), inFace(onlyFace(plane), vec3(0, 0, 0))]],
    });

    expect(result.status).toBe(
      'Knife cut 0 face(s), adding 2 vertex(es); 1 edge(s) stop inside a face and are left loose',
    );
  });

  it('refuses a cut of one point', () => {
    const plane = createPlane(2);
    const { nearLeft } = planeCorners(plane);

    const result = execOperator(context(plane), 'knife', { cuts: [[atVert(nearLeft)]] });

    expect(result.refused).toBe(true);
    expect(plane.faces.size).toBe(1);
  });

  it('refuses a cut that only follows an edge', () => {
    const plane = createPlane(2);
    const { nearLeft, nearRight } = planeCorners(plane);

    const result = execOperator(context(plane), 'knife', {
      cuts: [[atVert(nearLeft), atVert(nearRight)]],
    });

    expect(result.refused).toBe(true);
  });

  it('drops malformed points and runs instead of throwing', () => {
    const plane = createPlane(2);
    const { nearLeft, farRight } = planeCorners(plane);

    const result = execOperator(context(plane), 'knife', {
      cuts: [
        'nonsense',
        [atVert(nearLeft), { kind: 'edge', edge: 'one' }, null, { kind: 'face' }, atVert(farRight)],
      ],
    });

    expect(result.refused).toBeUndefined();
    expect(plane.faces.size).toBe(2);
    expect(execOperator(context(plane), 'knife', { cuts: 'everything' }).refused).toBe(true);
  });

  it('points every half of a cut box face the way the face pointed', () => {
    const box = createBox(2);
    const top = [...box.faces.values()].find((face) => face.normal.y > 0.99);
    if (!top) throw new Error('no top face');
    const up = { ...top.normal };

    execOperator(context(box), 'knife', {
      cuts: [
        [
          atVert(vertAt(box, -1, 1, -1)),
          inFace(top, vec3(0.2, 1, 0.1)),
          atVert(vertAt(box, 1, 1, 1)),
        ],
      ],
    });

    const halves = [...box.faces.values()].filter((face) => face.normal.y > 0.5);
    expect(halves).toHaveLength(2);
    for (const half of halves) expect(dot(half.normal, up)).toBeGreaterThan(0.99);
    expect(eulerCharacteristic(box)).toBe(2);
  });
});
