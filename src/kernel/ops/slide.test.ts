import { describe, expect, it } from 'vitest';

import { type Vec3, distance, dot, normalize, sub, vec3 } from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Vert } from '../mesh/types';
import { createGrid, createPlane } from '../primitives';

import { autoMergeVerts } from './merge';
import {
  type SlideAim,
  type SlideWay,
  applySlide,
  applySlideDistance,
  edgeSlideWays,
  planEdgeSlide,
  planVertexSlide,
  slideLandings,
  vertexSlideWays,
} from './slide';

/** Aiming by plain geometry, the way a caller with no camera to ask would. */
const aimedAlong =
  (along: Vec3): SlideAim =>
  (from, to) =>
    dot(normalize(sub(to, from)), normalize(along));

/** The grid vertex nearest `(x, z)`; the grid lies in the XZ plane. */
function vertAt(mesh: BMesh, x: number, z: number): Vert {
  let best: Vert | null = null;
  let found = Infinity;

  for (const vert of mesh.verts.values()) {
    const away = (vert.co.x - x) ** 2 + (vert.co.z - z) ** 2;
    if (away < found) {
      found = away;
      best = vert;
    }
  }

  return best as Vert;
}

/** The run of edges along the grid row at `z`: one edge loop across the sheet. */
function rowEdges(mesh: BMesh, z: number): Edge[] {
  return [...mesh.edges.values()].filter(
    (edge) => Math.abs(edge.v0.co.z - z) < 1e-9 && Math.abs(edge.v1.co.z - z) < 1e-9,
  );
}

describe('vertex slide', () => {
  it('lands the vertex exactly on a neighbour it already had', () => {
    const mesh = createGrid(1, 4);
    const vert = vertAt(mesh, 0, 0);
    const plan = planVertexSlide(mesh, [vert]);

    applySlide(mesh, plan, 1);
    expect(vert.co).toEqual(plan.rails[0].positive);

    applySlide(mesh, plan, -1);
    expect(vert.co).toEqual(plan.rails[0].negative);
  });

  it('takes the straightest pair of edges through the vertex when nothing aims it', () => {
    const mesh = createGrid(1, 4);
    const [rail] = planVertexSlide(mesh, [vertAt(mesh, 0, 0)]).rails;

    // Either grid line through the vertex will do, but its two ends have to be
    // opposite each other rather than at right angles: that is what makes the
    // slide read as travel along one line.
    expect(distance(rail.positive, rail.negative)).toBeCloseTo(0.5, 9);
  });

  it('follows the direction it is aimed in', () => {
    const mesh = createGrid(1, 4);
    const vert = vertAt(mesh, 0, 0);

    const alongX = planVertexSlide(mesh, [vert], aimedAlong(vec3(1, 0, 0))).rails[0];
    expect(alongX.positive).toEqual(vec3(0.25, 0, 0));
    expect(alongX.negative).toEqual(vec3(-0.25, 0, 0));

    const alongZ = planVertexSlide(mesh, [vert], aimedAlong(vec3(0, 0, -1))).rails[0];
    expect(alongZ.positive).toEqual(vec3(0, 0, -0.25));
    expect(alongZ.negative).toEqual(vec3(0, 0, 0.25));
  });

  it('takes the best scoring edge out and the worst one back', () => {
    const mesh = createGrid(1, 4);
    const vert = vertAt(mesh, 0, 0);

    // A score that has nothing to do with where the edges point: whatever the
    // aim ranks highest is the way out, which is what lets the viewport rank
    // them on screen rather than out in the scene.
    const towardsFarZ: SlideAim = (_from, to) => to.z;
    const [rail] = planVertexSlide(mesh, [vert], towardsFarZ).rails;

    expect(rail.positive).toEqual(vec3(0, 0, 0.25));
    expect(rail.negative).toEqual(vec3(0, 0, -0.25));
  });

  it('never travels past the edge it is running along', () => {
    const mesh = createGrid(1, 4);
    const vert = vertAt(mesh, 0, 0);
    const plan = planVertexSlide(mesh, [vert], aimedAlong(vec3(1, 0, 0)));

    applySlide(mesh, plan, 4);
    expect(vert.co).toEqual(vec3(0.25, 0, 0));
  });

  it('puts everything back at factor zero, wherever the drag has been', () => {
    const mesh = createGrid(1, 4);
    const vert = vertAt(mesh, 0, 0);
    const plan = planVertexSlide(mesh, [vert]);

    applySlide(mesh, plan, 0.8);
    applySlide(mesh, plan, -0.3);
    applySlide(mesh, plan, 0);

    expect(vert.co).toEqual(vec3(0, 0, 0));
  });
});

describe('edge slide', () => {
  it('slides the whole loop onto the loop next door', () => {
    const mesh = createGrid(1, 4);
    const plan = planEdgeSlide(mesh, rowEdges(mesh, 0));

    expect(plan.rails).toHaveLength(5);
    applySlide(mesh, plan, 1);

    for (const rail of plan.rails) {
      expect(Math.abs(rail.vert.co.z)).toBeCloseTo(0.25, 9);
      expect(rail.vert.co.x).toBeCloseTo(rail.origin.x, 9);
    }
  });

  it('carries one side across the whole loop rather than letting each vertex choose', () => {
    const mesh = createGrid(1, 4);
    const plan = planEdgeSlide(mesh, rowEdges(mesh, 0));

    // The rails are read off the faces either side of each edge, and the walk
    // that spreads the side is the only thing stopping half the loop sliding
    // one way and half the other.
    const sides = new Set(plan.rails.map((rail) => Math.sign(rail.positive.z - rail.origin.z)));
    expect(sides.size).toBe(1);
  });

  it('holds a vertex still where the mesh runs out on that side', () => {
    const mesh = createPlane(1);
    const [edge] = [...mesh.edges.values()];
    const plan = planEdgeSlide(mesh, [edge]);

    // A plane is one quad: every edge of it has a face on one side only, so a
    // slide has one way to go and the other way is closed.
    for (const rail of plan.rails) {
      expect(rail.negative).toEqual(rail.origin);
      expect(rail.positive).not.toEqual(rail.origin);
    }
  });

  it('leaves an unslid mesh alone', () => {
    const mesh = createGrid(1, 4);
    const before = [...mesh.verts.values()].map((vert) => ({ ...vert.co }));
    const plan = planEdgeSlide(mesh, rowEdges(mesh, 0));

    applySlide(mesh, plan, 0.6);
    applySlide(mesh, plan, 0);

    expect([...mesh.verts.values()].map((vert) => ({ ...vert.co }))).toEqual(before);
  });
});

/** The grid vertices along the row at `z`, ordered by x. */
function rowVerts(mesh: BMesh, z: number): Vert[] {
  return [...mesh.verts.values()]
    .filter((vert) => Math.abs(vert.co.z - z) < 1e-9)
    .sort((a, b) => a.co.x - b.co.x);
}

/** The way running along `direction`, which is how a test names one. */
function wayAlong(ways: readonly SlideWay[], direction: Vec3): SlideWay {
  const found = ways.find((way) => distance(way.direction, direction) < 1e-9);
  if (!found) throw new Error('no way runs that way');
  return found;
}

const UNIT = vec3(1, 1, 1);

describe('numbered slide directions', () => {
  it('offers one way per edge leaving the vertex, up to three', () => {
    const mesh = createGrid(1, 4);

    // Four edges leave a vertex inside the grid, and two leave a corner of it.
    // Three is as many as the panel numbers, so the fourth is not offered.
    expect(vertexSlideWays(mesh, [vertAt(mesh, 0, 0)], UNIT)).toHaveLength(3);
    expect(vertexSlideWays(mesh, [vertAt(mesh, -0.5, -0.5)], UNIT)).toHaveLength(2);
  });

  it('reaches exactly as far as the neighbour it is travelling toward', () => {
    const mesh = createGrid(1, 4);
    const ways = vertexSlideWays(mesh, [vertAt(mesh, 0, 0)], UNIT);

    for (const way of ways) expect(way.reach).toBeCloseTo(0.25, 9);
  });

  it('measures that reach out in the world, with the object scale applied', () => {
    const mesh = createGrid(1, 4);
    const ways = vertexSlideWays(mesh, [vertAt(mesh, 0, 0)], vec3(2, 1, 1));

    // The same quarter-metre grid step, stretched to half a metre along x and
    // left alone across it: what the field asks for is the size in the world.
    expect(wayAlong(ways, vec3(1, 0, 0)).reach).toBeCloseTo(0.5, 9);
    expect(wayAlong(ways, vec3(0, 0, -1)).reach).toBeCloseTo(0.25, 9);
  });

  it('carries a row of vertices along one way rather than each picking its own', () => {
    const mesh = createGrid(1, 4);
    const row = rowVerts(mesh, 0);
    const way = wayAlong(vertexSlideWays(mesh, row, UNIT), vec3(0, 0, 1));

    expect(way.rails).toHaveLength(row.length);
    for (const rail of way.rails) {
      expect(normalize(sub(rail.positive, rail.origin))).toEqual(vec3(0, 0, 1));
    }
  });

  it('gives an edge selection a way per side, and a border only the side it has', () => {
    const mesh = createGrid(1, 4);
    const [forward, back] = edgeSlideWays(mesh, rowEdges(mesh, 0), UNIT);

    expect(forward.direction).toEqual(vec3(0, 0, -back.direction.z));
    expect(forward.reach).toBeCloseTo(0.25, 9);

    // A plane is one quad: every edge of it has a face on one side only.
    const plane = createPlane(1);
    expect(edgeSlideWays(plane, [...plane.edges.values()].slice(0, 1), UNIT)).toHaveLength(1);
  });
});

describe('slide by distance', () => {
  it('travels the metres it is given, along the way that was picked', () => {
    const mesh = createGrid(1, 4);
    const vert = vertAt(mesh, 0, 0);
    const way = wayAlong(vertexSlideWays(mesh, [vert], UNIT), vec3(1, 0, 0));

    expect(applySlideDistance(mesh, way, 0.1, UNIT)).toBe(1);
    expect(vert.co.x).toBeCloseTo(0.1, 9);
    expect(vert.co.z).toBeCloseTo(0, 9);
  });

  it('stops on the neighbour however far it is asked to go', () => {
    const mesh = createGrid(1, 4);
    const vert = vertAt(mesh, 0, 0);
    const way = wayAlong(vertexSlideWays(mesh, [vert], UNIT), vec3(1, 0, 0));

    applySlideDistance(mesh, way, 40, UNIT);
    expect(vert.co).toEqual(vec3(0.25, 0, 0));
  });

  it('counts the metres in the world, so an object scale shortens the travel', () => {
    const mesh = createGrid(1, 4);
    const vert = vertAt(mesh, 0, 0);
    const scale = vec3(2, 1, 1);
    const way = wayAlong(vertexSlideWays(mesh, [vert], scale), vec3(1, 0, 0));

    // Half a metre out in the world is a quarter of one in a mesh drawn at
    // twice the size, which is where the neighbour sits.
    applySlideDistance(mesh, way, 0.5, scale);
    expect(vert.co.x).toBeCloseTo(0.25, 9);
  });

  it('slides a whole loop onto the one next door', () => {
    const mesh = createGrid(1, 4);
    const [way] = edgeSlideWays(mesh, rowEdges(mesh, 0), UNIT);

    expect(applySlideDistance(mesh, way, way.reach, UNIT)).toBe(5);
    for (const rail of way.rails) {
      expect(Math.abs(rail.vert.co.z)).toBeCloseTo(0.25, 9);
      expect(rail.vert.co.x).toBeCloseTo(rail.origin.x, 9);
    }
  });

  it('lands every vertex where the preview said it would', () => {
    const mesh = createGrid(1, 4);
    const [way] = edgeSlideWays(mesh, rowEdges(mesh, 0), UNIT);

    // Read before the mesh is touched, which is what the panel draws.
    const landings = slideLandings(way, 0.1, UNIT);
    applySlideDistance(mesh, way, 0.1, UNIT);

    expect(landings.size).toBe(5);
    for (const [id, co] of landings) expect(mesh.verts.get(id)?.co).toEqual(co);
  });

  it('leaves the mesh where it is when there is nowhere to travel', () => {
    const mesh = createGrid(1, 4);
    const before = [...mesh.verts.values()].map((vert) => ({ ...vert.co }));
    const [way] = edgeSlideWays(mesh, rowEdges(mesh, 0), UNIT);

    applySlideDistance(mesh, way, 0, UNIT);
    expect([...mesh.verts.values()].map((vert) => ({ ...vert.co }))).toEqual(before);
  });
});

describe('auto merge', () => {
  it('welds a loop slid all the way onto the one it landed on', () => {
    const mesh = createGrid(1, 4);
    const plan = planEdgeSlide(mesh, rowEdges(mesh, 0));
    const moved = plan.rails.map((rail) => rail.vert);

    applySlide(mesh, plan, 1);
    const { removed } = autoMergeVerts(mesh, moved, 1e-4);

    expect(removed).toBe(5);
    expect(mesh.verts.size).toBe(20);
    // The row of quads the loop was slid across has no width left, so it goes
    // with them; the rest of the sheet is untouched.
    expect(mesh.faces.size).toBe(12);
    expect(mesh.validate()).toEqual([]);
  });

  it('keeps the vertex that stayed put and drops the one that moved', () => {
    const mesh = createGrid(1, 4);
    const plan = planEdgeSlide(mesh, rowEdges(mesh, 0));
    const moved = plan.rails.map((rail) => rail.vert);
    const stillId = vertAt(mesh, 0, 0.25).id;

    applySlide(mesh, plan, 1);
    autoMergeVerts(mesh, moved, 1e-4);

    expect(mesh.verts.has(stillId)).toBe(true);
    expect(moved.every((vert) => !mesh.verts.has(vert.id))).toBe(true);
  });

  it('leaves vertices that were already this close to each other alone', () => {
    const mesh = createGrid(1, 4);
    const vert = vertAt(mesh, 0, 0);
    const plan = planVertexSlide(mesh, [vert], aimedAlong(vec3(1, 0, 0)));

    // A threshold far wider than the grid spacing, but only the one vertex
    // moved, so only it can be welded away.
    applySlide(mesh, plan, 0.1);
    const { removed } = autoMergeVerts(mesh, [vert], 0.5);

    expect(removed).toBe(1);
    expect(mesh.verts.size).toBe(24);
  });

  it('does nothing at all with a threshold of zero', () => {
    const mesh = createGrid(1, 4);
    const plan = planEdgeSlide(mesh, rowEdges(mesh, 0));
    const moved = plan.rails.map((rail) => rail.vert);

    applySlide(mesh, plan, 1);
    expect(autoMergeVerts(mesh, moved, 0).removed).toBe(0);
    expect(mesh.verts.size).toBe(25);
  });
});
