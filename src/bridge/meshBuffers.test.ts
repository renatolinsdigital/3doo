import { describe, expect, it } from 'vitest';

import { createBox, createPlane, vec3, BMesh } from '@kernel/index';

import { buildSilhouetteEdges } from './meshBuffers';

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
    // boundary — an open shape gets an outline where a hull would give none.
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
