import { describe, expect, it } from 'vitest';

import { type Edge, createBox, createPlane, vec3, BMesh } from '@kernel/index';

import {
  buildEdgeCull,
  buildMeshBuffers,
  buildSilhouetteEdges,
  frontEdgeLines,
  frontSharpLines,
} from './meshBuffers';

/** Silhouette buffers are pairs of points, so two vertices per edge. */
function edgeCount(positions: Float32Array): number {
  return positions.length / 6;
}

describe('silhouette edges', () => {
  it('traces the four edges of a cube seen face on', () => {
    // Straight down +Z: three faces face away, three towards, and the outline
    // is the square where they meet.
    expect(edgeCount(buildSilhouetteEdges(createBox(1), vec3(0, 0, 10)))).toBe(4);
  });

  it('traces six edges of a cube seen from a corner', () => {
    // Three faces towards the camera, three away: the outline is the hexagon
    // around them, which is what a cube looks like from a corner.
    expect(edgeCount(buildSilhouetteEdges(createBox(1), vec3(10, 10, 10)))).toBe(6);
  });

  it('outlines a flat plane by its boundary, from either side', () => {
    const plane = createPlane(1);

    // A single quad has no second face to disagree with, so all four edges are
    // boundary: an open shape gets an outline where a hull would give none.
    expect(edgeCount(buildSilhouetteEdges(plane, vec3(0, 10, 0)))).toBe(4);
    expect(edgeCount(buildSilhouetteEdges(plane, vec3(0, -10, 0)))).toBe(4);
  });

  it('always includes a bare wire edge', () => {
    const mesh = new BMesh();
    mesh.addEdge(mesh.addVert(vec3(0, 0, 0)), mesh.addVert(vec3(1, 0, 0)));

    expect(edgeCount(buildSilhouetteEdges(mesh, vec3(0, 0, 5)))).toBe(1);
  });

  it('leaves out the interior edges the wireframe already draws', () => {
    const mesh = createBox(1);
    const all = mesh.edges.size;

    // Anything less than every edge is the point: an outline is not a
    // wireframe, and a cube has 12 edges however it is turned.
    expect(all).toBe(12);
    expect(edgeCount(buildSilhouetteEdges(mesh, vec3(3, 7, 11)))).toBeLessThan(all);
  });
});

describe('front edges', () => {
  const frontEdges = (mesh: BMesh, eye: ReturnType<typeof vec3>) =>
    edgeCount(frontEdgeLines(buildEdgeCull(mesh), eye).positions);

  it('leaves a cube seen face on with the square that is all anyone can see', () => {
    // Every other face is edge-on or behind, so the eight edges they own are
    // the ones the depth test was letting through beside the contour, as a
    // second line next to the near edge and as a stub off a corner.
    expect(frontEdges(createBox(1), vec3(0, 0, 10))).toBe(4);
  });

  it('keeps every edge of a cube seen from a corner but the three behind it', () => {
    expect(frontEdges(createBox(1), vec3(10, 10, 10))).toBe(9);
  });

  it('keeps a flat plane whole from either side, having no far side to be on', () => {
    const plane = createPlane(1);

    expect(frontEdges(plane, vec3(0, 10, 0))).toBe(4);
    expect(frontEdges(plane, vec3(0, -10, 0))).toBe(4);
  });

  it('always keeps a bare wire edge', () => {
    const mesh = new BMesh();
    mesh.addEdge(mesh.addVert(vec3(0, 0, 0)), mesh.addVert(vec3(1, 0, 0)));

    expect(frontEdges(mesh, vec3(0, 0, 5))).toBe(1);
  });

  it('keeps every edge of a box with a face taken out, from either side', () => {
    // What the user sees through the opening is the inside of the far walls,
    // and those faces are turned away: culling their edges left the cut with
    // no lines on the side you can look into.
    const mesh = createBox(1);
    mesh.removeFace([...mesh.faces.values()][0]);

    expect(frontEdges(mesh, vec3(0, 0, 10))).toBe(mesh.edges.size);
    expect(frontEdges(mesh, vec3(0, 0, -10))).toBe(mesh.edges.size);
  });

  it('keeps every edge of a closed box from a camera standing inside it', () => {
    // A room modelled as a cube. Every face is turned away from in here, so
    // the cull would have taken the wireframe off the walls being looked at.
    const mesh = createBox(4);

    expect(frontEdges(mesh, vec3(0, 0, 0))).toBe(mesh.edges.size);
  });

  it('reads the same tables from any camera, since only the mesh sets them', () => {
    // The tables are what make this cheap enough to run on a moving camera:
    // they are flattened once and then only read.
    const cull = buildEdgeCull(createBox(1));

    expect(edgeCount(frontEdgeLines(cull, vec3(0, 0, 10)).positions)).toBe(4);
    expect(edgeCount(frontEdgeLines(cull, vec3(0, 0, -10)).positions)).toBe(4);
    expect(edgeCount(frontEdgeLines(cull, vec3(10, 10, 10)).positions)).toBe(9);
  });
});

describe('edge sides', () => {
  /** The two normals written for edge `i`, as plain arrays. */
  const sidesOf = (sides: Float32Array, i: number) => [
    [...sides.slice(i * 6, i * 6 + 3)],
    [...sides.slice(i * 6 + 3, i * 6 + 6)],
  ];

  it('gives each edge of a box the normals of the two faces it joins', () => {
    // What the wire's lift is sized by: a box edge joins two faces at right
    // angles, so its two normals are two different axes.
    const { edges } = buildMeshBuffers(createBox(1));

    for (let i = 0; i < edges.positions.length / 6; i++) {
      const [a, b] = sidesOf(edges.sides, i);
      expect(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2])).toBeCloseTo(0);
    }
  });

  it('repeats the one face of a boundary edge and leaves a bare wire at zero', () => {
    const plane = createPlane(1);
    const loose = new BMesh();
    loose.addEdge(loose.addVert(vec3(0, 0, 0)), loose.addVert(vec3(1, 0, 0)));

    const [a, b] = sidesOf(buildMeshBuffers(plane).edges.sides, 0);
    expect(a).toEqual(b);
    expect(Math.hypot(a[0], a[1], a[2])).toBeCloseTo(1);
    expect([...buildMeshBuffers(loose).edges.sides]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('keeps the sides with their edges through the far-side cull', () => {
    // Seen face on down +Z, the four edges kept are the front face's, so each
    // has that face's normal on one side.
    const lines = frontEdgeLines(buildEdgeCull(createBox(1)), vec3(0, 0, 10));

    expect(lines.sides.length).toBe(lines.positions.length);
    for (let i = 0; i < lines.positions.length / 6; i++) {
      const [a, b] = sidesOf(lines.sides, i);
      expect(Math.max(a[2], b[2])).toBeCloseTo(1);
    }
  });
});

describe('vertex selection fade', () => {
  it('picks out the edges reaching away from a selected vertex', () => {
    const mesh = createPlane(1);
    const [corner] = [...mesh.verts.values()];
    mesh.selectVert(corner);
    mesh.flushSelection('vertex');

    const { edges } = buildMeshBuffers(mesh);

    // Two of the quad's four edges meet at the corner, and neither has both
    // ends selected, so nothing counts as a selected edge yet.
    expect(edges.selected.positions.length).toBe(0);
    expect(edges.partialPositions.length / 6).toBe(2);

    // One end full and one end nothing, whichever way round the edge was
    // stored: that difference is the gradient.
    for (let i = 0; i < edges.partialWeights.length; i += 2) {
      expect([edges.partialWeights[i], edges.partialWeights[i + 1]].sort()).toEqual([0, 1]);
    }
  });

  it('leaves out an edge with both ends selected', () => {
    const mesh = createPlane(1);
    const [v0, v1] = [...mesh.verts.values()];
    mesh.selectVert(v0);
    mesh.selectVert(v1);
    mesh.flushSelection('vertex');

    const { edges } = buildMeshBuffers(mesh);

    // The edge between the two is selected outright and drawn in flat red. The
    // fade is for the edges running off the selection, not inside it.
    expect(edges.selected.positions.length / 6).toBe(1);
    expect(edges.partialPositions.length / 6).toBe(2);
  });

  it('has nothing to fade when the whole mesh is selected', () => {
    const mesh = createBox(1);
    mesh.selectAll();

    expect(buildMeshBuffers(mesh).edges.partialPositions.length).toBe(0);
  });
});

describe('sharp edges', () => {
  /** A cube shaded smooth with the edges `pick` chooses marked sharp. */
  function sharpBox(pick: (edge: Edge) => boolean = () => true): BMesh {
    const mesh = createBox(1);
    for (const face of mesh.faces.values()) face.smooth = true;
    for (const edge of mesh.edges.values()) edge.sharp = pick(edge);
    return mesh;
  }

  /** Whether every component of every normal is one of `sizes`, of either sign. */
  const allAt = (normals: Float32Array, ...sizes: number[]) =>
    [...normals].every((value) => sizes.some((size) => Math.abs(Math.abs(value) - size) < 1e-6));

  it('lists the sharp edges, selected or not', () => {
    const mesh = sharpBox((edge) => edge.v0.co.y > 0 && edge.v1.co.y > 0);
    const [first] = mesh.edges.values();
    first.selected = true;

    expect(edgeCount(buildMeshBuffers(mesh).edges.sharp.positions)).toBe(4);
  });

  it('breaks the smooth shading along them', () => {
    const smooth = buildMeshBuffers(sharpBox(() => false)).solid.normals;
    const sharp = buildMeshBuffers(sharpBox()).solid.normals;

    // Smooth, a cube's corners lean out along the diagonals; cut along every
    // edge, each face shades flat on its own axis.
    expect(allAt(smooth, 1 / Math.sqrt(3))).toBe(true);
    expect(allAt(sharp, 0, 1)).toBe(true);
  });

  it('leaves out the sharp edges on the far side, like the wire', () => {
    const cull = buildEdgeCull(sharpBox());

    expect(edgeCount(frontSharpLines(cull, vec3(0, 0, 10)).positions)).toBe(4);
    expect(edgeCount(frontSharpLines(cull, vec3(10, 10, 10)).positions)).toBe(9);
  });

  it('draws none when every sharp edge is round the back', () => {
    const behind = (edge: Edge) => edge.v0.co.z < 0 && edge.v1.co.z < 0;

    expect(
      edgeCount(frontSharpLines(buildEdgeCull(sharpBox(behind)), vec3(0, 0, 10)).positions),
    ).toBe(0);
  });

  it('keeps them all where the cull does not hold', () => {
    const plane = createPlane(1);
    for (const edge of plane.edges.values()) edge.sharp = true;

    expect(edgeCount(frontSharpLines(buildEdgeCull(plane), vec3(0, 10, 0)).positions)).toBe(4);
  });
});
