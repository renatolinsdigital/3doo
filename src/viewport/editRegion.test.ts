import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { ObjectView } from '@bridge/index';
import { BMesh } from '@kernel/index';

import { pickInRegion, rectangleRegion } from './picking';

const SIZE = { width: 200, height: 200 };

/** World (x, y) lands at pixel (100 + 10x, 100 - 10y). */
function camera(): THREE.Camera {
  const view = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  view.position.set(0, 0, 10);
  view.lookAt(0, 0, 0);
  view.updateMatrixWorld(true);
  view.updateProjectionMatrix();
  return view;
}

/** One square face in the z = 0 plane, eight units across: pixels 60 to 140. */
function plane(): { mesh: BMesh; view: ObjectView } {
  const mesh = new BMesh();
  const corners = [
    mesh.addVert({ x: -4, y: -4, z: 0 }),
    mesh.addVert({ x: 4, y: -4, z: 0 }),
    mesh.addVert({ x: 4, y: 4, z: 0 }),
    mesh.addVert({ x: -4, y: 4, z: 0 }),
  ];
  mesh.addFace(corners);

  const view = {
    group: new THREE.Group(),
    vertIds: new Int32Array(corners.map((vert) => vert.id)),
    vertPositions: new Float32Array(corners.flatMap((vert) => [vert.co.x, vert.co.y, vert.co.z])),
  } as unknown as ObjectView;

  return { mesh, view };
}

const region = (minX: number, minY: number, maxX: number, maxY: number) =>
  rectangleRegion({ minX, minY, maxX, maxY });

const pick = (mode: 'vertex' | 'edge' | 'face', box: ReturnType<typeof region>) => {
  const { mesh, view } = plane();
  return pickInRegion(view, mode, box, camera(), SIZE, mesh, null);
};

describe('edit mode region select', () => {
  it('takes a face the region only clips a corner of', () => {
    // The top right corner of the face, nowhere near its centre at (100, 100).
    const hits = pick('face', region(130, 62, 160, 80));

    expect(hits).toHaveLength(1);
  });

  it('takes a face the region sits wholly inside', () => {
    const hits = pick('face', region(90, 90, 110, 110));

    expect(hits).toHaveLength(1);
  });

  it('leaves a face the region never reaches', () => {
    // Clear of the face on screen: pixel 150 is world x 5, past its edge at 4.
    const hits = pick('face', region(150, 62, 180, 80));

    expect(hits).toHaveLength(0);
  });

  it('takes an edge the region touches near one end, not only at its middle', () => {
    // The top edge runs from pixel 60 to 140 at y = 60, so its centre is at
    // (100, 60) and this box holds none of it.
    const hits = pick('edge', region(125, 55, 138, 65));

    expect(hits).toHaveLength(1);
  });

  it('takes an edge the region cuts across holding neither end', () => {
    // A band narrower than the edge, laid across its middle.
    const hits = pick('edge', region(95, 50, 105, 70));

    expect(hits).toHaveLength(1);
  });

  it('still asks a vertex the one question a point can answer', () => {
    const { mesh, view } = plane();

    const on = pickInRegion(view, 'vertex', region(130, 55, 145, 70), camera(), SIZE, mesh, null);
    const beside = pickInRegion(
      view,
      'vertex',
      region(90, 90, 110, 110),
      camera(),
      SIZE,
      mesh,
      null,
    );

    expect(on).toHaveLength(1);
    expect(beside).toHaveLength(0);
  });
});
