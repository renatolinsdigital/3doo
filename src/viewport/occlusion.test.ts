import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { ObjectView } from '@bridge/index';
import { type BMesh, type Vert, createBox } from '@kernel/index';

import { circleRegion, facingElements, pickElement, pickInRegion } from './picking';

const SIZE = { width: 200, height: 200 };

/** World (x, y) lands at pixel (100 + 10x, 100 - 10y). */
function orthographic(): THREE.Camera {
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function perspective(): THREE.Camera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * As much of an ObjectView as the picker reads, with the vertices in the order
 * given, which is what decides a tie, and so what the tests turn on.
 */
function viewOf(mesh: BMesh, order: readonly Vert[]): ObjectView {
  const edges = [...mesh.edges.values()];
  return {
    group: new THREE.Group(),
    vertIds: new Int32Array(order.map((vert) => vert.id)),
    vertPositions: new Float32Array(order.flatMap((vert) => [vert.co.x, vert.co.y, vert.co.z])),
    edgeIds: new Int32Array(edges.map((edge) => edge.id)),
    edgePositions: new Float32Array(
      edges.flatMap((edge) => [
        edge.v0.co.x,
        edge.v0.co.y,
        edge.v0.co.z,
        edge.v1.co.x,
        edge.v1.co.y,
        edge.v1.co.z,
      ]),
    ),
  } as unknown as ObjectView;
}

function corner(mesh: BMesh, x: number, y: number, z: number): Vert {
  const found = [...mesh.verts.values()].find(
    (vert) =>
      Math.sign(vert.co.x) === x && Math.sign(vert.co.y) === y && Math.sign(vert.co.z) === z,
  );
  if (!found) throw new Error(`no corner at ${x},${y},${z}`);
  return found;
}

describe('facingElements', () => {
  it('keeps only the face turned towards the camera', () => {
    const mesh = createBox(2);
    const facing = facingElements(mesh, new THREE.Matrix4(), orthographic());

    // Looking straight down -Z at a cube: one face faces the camera, four are
    // edge-on and one is behind. Only the front four corners are reachable.
    expect(facing.faces.size).toBe(1);
    expect(facing.verts.size).toBe(4);
    for (const id of facing.verts) {
      const vert = mesh.verts.get(id);
      expect(vert?.co.z).toBeGreaterThan(0);
    }
  });

  it('answers the same for a perspective camera', () => {
    const mesh = createBox(2);
    const facing = facingElements(mesh, new THREE.Matrix4(), perspective());

    expect(facing.faces.size).toBe(1);
    expect(facing.verts.size).toBe(4);
  });

  it('follows the object transform', () => {
    const mesh = createBox(2);
    // Turned half a revolution, the face that was towards the camera is the one
    // now hidden: the test runs in object space, so the matrix has to be read.
    const matrix = new THREE.Matrix4().makeRotationY(Math.PI);
    const facing = facingElements(mesh, matrix, orthographic());

    for (const id of facing.verts) {
      expect(mesh.verts.get(id)?.co.z).toBeLessThan(0);
    }
  });

  it('keeps wire edges and loose vertices, which have no face to turn away', () => {
    const mesh = createBox(2);
    const loose = mesh.addVert({ x: 5, y: 0, z: -5 });
    const wireEnd = mesh.addVert({ x: 6, y: 0, z: -5 });
    const wire = mesh.addEdge(loose, wireEnd);

    const facing = facingElements(mesh, new THREE.Matrix4(), orthographic());

    expect(facing.verts.has(loose.id)).toBe(true);
    expect(facing.verts.has(wireEnd.id)).toBe(true);
    expect(facing.edges.has(wire.id)).toBe(true);
  });

  it('keeps a silhouette vertex, which borders a front face and a back one', () => {
    const mesh = createBox(2);
    // Turned an eighth, two faces of the cube face the camera and the corner
    // between them is on the silhouette: visible from either side.
    const matrix = new THREE.Matrix4().makeRotationY(Math.PI / 4);
    const facing = facingElements(mesh, matrix, orthographic());

    expect(facing.faces.size).toBe(2);
    expect(facing.verts.size).toBe(6);
  });
});

describe('picking through a dense mesh', () => {
  const mesh = createBox(2);
  const front = corner(mesh, 1, 1, 1);
  const back = corner(mesh, 1, 1, -1);
  // The far corner sits first, so a tie on screen distance goes to it, which
  // is exactly what a dense mesh does by accident.
  const view = viewOf(mesh, [back, front, ...[...mesh.verts.values()]]);
  const pointer = new THREE.Vector2(110, 90);

  it('picks the vertex behind the model when nothing filters the candidates', () => {
    const pick = pickElement(
      view,
      mesh,
      'vertex',
      pointer,
      orthographic(),
      SIZE,
      new THREE.Raycaster(),
      null,
    );

    expect(pick?.elementId).toBe(back.id);
  });

  it('picks the visible one once the candidates are held to what faces the camera', () => {
    const camera = orthographic();
    const pick = pickElement(
      view,
      mesh,
      'vertex',
      pointer,
      camera,
      SIZE,
      new THREE.Raycaster(),
      facingElements(mesh, view.group.matrix, camera),
    );

    expect(pick?.elementId).toBe(front.id);
  });

  it('leaves the far side out of a region drag too', () => {
    const camera = orthographic();
    const region = circleRegion(new THREE.Vector2(100, 100), 60);

    const through = pickInRegion(view, 'vertex', region, camera, SIZE, mesh, null);
    const visible = pickInRegion(
      view,
      'vertex',
      region,
      camera,
      SIZE,
      mesh,
      facingElements(mesh, view.group.matrix, camera),
    );

    // The drag covers the whole cube on screen, so without the filter it sweeps
    // up the four corners behind it as well.
    expect(new Set(through).size).toBe(8);
    expect(new Set(visible).size).toBe(4);
    for (const id of visible) expect(mesh.verts.get(id)?.co.z).toBeGreaterThan(0);
  });
});
