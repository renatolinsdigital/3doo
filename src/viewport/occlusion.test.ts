import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { type ObjectView, buildMeshBuffers } from '@bridge/index';
import { BMesh, type Vert, createBox } from '@kernel/index';

import {
  type FacingElements,
  type SurfaceDepth,
  aimRay,
  circleRegion,
  facingElements,
  pickElement,
  pickInRegion,
  pickRect,
  rectangleRegion,
  surfaceDepth,
} from './picking';

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

/** The facing set, for the views the filter has something to say about. */
function facingOf(mesh: BMesh, matrix: THREE.Matrix4, camera: THREE.Camera): FacingElements {
  const facing = facingElements(mesh, matrix, camera);
  if (!facing) throw new Error('expected the far side of the mesh to be hidden');
  return facing;
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
    const facing = facingOf(mesh, new THREE.Matrix4(), orthographic());

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
    const facing = facingOf(mesh, new THREE.Matrix4(), perspective());

    expect(facing.faces.size).toBe(1);
    expect(facing.verts.size).toBe(4);
  });

  it('follows the object transform', () => {
    const mesh = createBox(2);
    // Turned half a revolution, the face that was towards the camera is the one
    // now hidden: the test runs in object space, so the matrix has to be read.
    const matrix = new THREE.Matrix4().makeRotationY(Math.PI);
    const facing = facingOf(mesh, matrix, orthographic());

    for (const id of facing.verts) {
      expect(mesh.verts.get(id)?.co.z).toBeLessThan(0);
    }
  });

  it('keeps a loose vertex, which has no face to turn away', () => {
    const mesh = createBox(2);
    const loose = mesh.addVert({ x: 5, y: 0, z: -5 });

    const facing = facingOf(mesh, new THREE.Matrix4(), orthographic());

    expect(facing.verts.has(loose.id)).toBe(true);
  });

  it('filters nothing on an open mesh, where the camera sees the inside of it', () => {
    const mesh = createBox(2);
    const [face] = [...mesh.faces.values()];
    mesh.removeFace(face);

    // The faces on show through the hole are all turned away, so holding the
    // pick to the front ones takes everything the user is aiming at.
    expect(facingElements(mesh, new THREE.Matrix4(), orthographic())).toBeNull();
  });

  it('filters nothing with the camera inside the mesh', () => {
    // Every wall of a room is turned away from someone standing in it.
    const mesh = createBox(40);

    expect(facingElements(mesh, new THREE.Matrix4(), orthographic())).toBeNull();
  });

  it('keeps a silhouette vertex, which borders a front face and a back one', () => {
    const mesh = createBox(2);
    // Turned an eighth, two faces of the cube face the camera and the corner
    // between them is on the silhouette: visible from either side.
    const matrix = new THREE.Matrix4().makeRotationY(Math.PI / 4);
    const facing = facingOf(mesh, matrix, orthographic());

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
      facingOf(mesh, view.group.matrix, camera),
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
      facingOf(mesh, view.group.matrix, camera),
    );

    // The drag covers the whole cube on screen, so without the filter it sweeps
    // up the four corners behind it as well.
    expect(new Set(through).size).toBe(8);
    expect(new Set(visible).size).toBe(4);
    for (const id of visible) expect(mesh.verts.get(id)?.co.z).toBeGreaterThan(0);
  });
});

describe('aiming through a zoomed-in orthographic camera', () => {
  // The camera stands a unit off the target and draws from a near plane far in
  // front of itself, the way the viewport's does, so a square five units
  // towards the viewer is on screen in front of one five units behind.
  function zoomedIn(): THREE.OrthographicCamera {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
    camera.position.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    return camera;
  }

  function square(name: string, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    mesh.name = name;
    mesh.position.z = z;
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  const squares = [square('front', 5), square('back', -5)];
  const centre = new THREE.Vector2(0, 0);

  it('passes through what is in front of the camera when three aims the ray', () => {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(centre, zoomedIn());

    expect(raycaster.intersectObjects(squares)[0]?.object.name).toBe('back');
  });

  it('lands on the nearest thing drawn once the ray starts on the near plane', () => {
    const raycaster = new THREE.Raycaster();
    aimRay(raycaster, centre, zoomedIn());

    expect(raycaster.intersectObjects(squares)[0]?.object.name).toBe('front');
  });
});

describe('holding a pick behind the surfaces drawn over it', () => {
  /** World (x, y) lands at pixel (100 + 50x, 100 - 50y). */
  function close(): THREE.Camera {
    const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    return camera;
  }

  function near(): THREE.Camera {
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    return camera;
  }

  function pixelOf(camera: THREE.Camera, x: number, y: number, z: number): THREE.Vector2 {
    const ndc = new THREE.Vector3(x, y, z).project(camera);
    return new THREE.Vector2(((ndc.x + 1) / 2) * SIZE.width, ((1 - ndc.y) / 2) * SIZE.height);
  }

  /** The mesh as the viewport draws it, which is also what it picks faces from. */
  function solidOf(mesh: BMesh): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(buildMeshBuffers(mesh).solid.positions, 3),
    );
    const solid = new THREE.Mesh(geometry);
    solid.updateMatrixWorld(true);
    return solid;
  }

  function fullView(mesh: BMesh): ObjectView {
    return Object.assign(viewOf(mesh, [...mesh.verts.values()]), {
      pickTarget: solidOf(mesh),
      triangleFaceIds: buildMeshBuffers(mesh).solid.triangleFaceIds,
    });
  }

  /** A square facing the camera, three units out, over the right of the cube. */
  function panel(width = 1, height = 1): THREE.Mesh {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height));
    plane.position.set(1, 0, 3);
    plane.updateMatrixWorld(true);
    return plane;
  }

  function edgeAlong(mesh: BMesh, x: number, z: number): number {
    const found = [...mesh.edges.values()].find(
      (edge) =>
        Math.sign(edge.v0.co.x) === x &&
        Math.sign(edge.v1.co.x) === x &&
        Math.sign(edge.v0.co.z) === z &&
        Math.sign(edge.v1.co.z) === z,
    );
    if (!found) throw new Error(`no edge along ${x},${z}`);
    return found.id;
  }

  for (const [name, camera] of [
    ['an orthographic', close()],
    ['a perspective', near()],
  ] as const) {
    it(`leaves an edge behind another object unpicked under ${name} camera`, () => {
      const mesh = createBox(2);
      const view = fullView(mesh);
      const pointer = pixelOf(camera, 1, 0, 1);
      const facing = facingOf(mesh, view.group.matrix, camera);
      const pick = (depth: SurfaceDepth | null) =>
        pickElement(
          view,
          mesh,
          'edge',
          pointer,
          camera,
          SIZE,
          new THREE.Raycaster(),
          facing,
          depth,
        );

      expect(pick(null)?.elementId).toBe(edgeAlong(mesh, 1, 1));
      const depth = surfaceDepth([panel(), solidOf(mesh)], camera, SIZE, pickRect(pointer), false);
      expect(pick(depth)).toBeNull();
    });
  }

  it('leaves a vertex behind another object unpicked', () => {
    const camera = close();
    const mesh = createBox(2);
    const view = fullView(mesh);
    const pointer = pixelOf(camera, 1, 1, 1);
    const depth = surfaceDepth(
      [panel(1, 3), solidOf(mesh)],
      camera,
      SIZE,
      pickRect(pointer),
      false,
    );

    const pick = pickElement(
      view,
      mesh,
      'vertex',
      pointer,
      camera,
      SIZE,
      new THREE.Raycaster(),
      facingOf(mesh, view.group.matrix, camera),
      depth,
    );
    expect(pick).toBeNull();
  });

  it('still picks an edge along a valley, which every pixel round it is nearer than', () => {
    const mesh = new BMesh();
    const left = [mesh.addVert({ x: -1, y: -1, z: 1 }), mesh.addVert({ x: -1, y: 1, z: 1 })];
    const valley = [mesh.addVert({ x: 0, y: -1, z: 0 }), mesh.addVert({ x: 0, y: 1, z: 0 })];
    const right = [mesh.addVert({ x: 1, y: -1, z: 1 }), mesh.addVert({ x: 1, y: 1, z: 1 })];
    mesh.addFace([left[0], valley[0], valley[1], left[1]]);
    mesh.addFace([valley[0], right[0], right[1], valley[1]]);
    const floor = [...mesh.edges.values()].find((edge) => edge.v0.co.x === 0 && edge.v1.co.x === 0);

    for (const camera of [close(), near()]) {
      // Off the pixel centres, so no centre lies on the valley itself.
      const pointer = pixelOf(camera, 0, 0.1, 0).add(new THREE.Vector2(0.3, 0.2));
      const depth = surfaceDepth([solidOf(mesh)], camera, SIZE, pickRect(pointer), false);
      const pick = pickElement(
        fullView(mesh),
        mesh,
        'edge',
        pointer,
        camera,
        SIZE,
        new THREE.Raycaster(),
        null,
        depth,
      );
      expect(pick?.elementId).toBe(floor?.id);
    }
  });

  it('leaves a region drag the part of an edge that shows, and nothing of one that does not', () => {
    const camera = close();
    const mesh = createBox(2);
    const view = fullView(mesh);
    const facing = facingOf(mesh, view.group.matrix, camera);
    const rect = { minX: 20, minY: 20, maxX: 180, maxY: 180 };
    const depth = surfaceDepth([panel(1, 3), solidOf(mesh)], camera, SIZE, rect, false);

    const hits = pickInRegion(
      view,
      'edge',
      rectangleRegion(rect),
      camera,
      SIZE,
      mesh,
      facing,
      depth,
    );

    // The panel covers the whole right edge, and the right half of the top
    // and bottom ones, which still show on the left.
    expect(hits).toHaveLength(3);
    expect(hits).not.toContain(edgeAlong(mesh, 1, 1));
  });

  it('takes a face partly in view, and leaves one wholly covered', () => {
    const camera = close();
    const mesh = createBox(2);
    const view = fullView(mesh);
    const facing = facingOf(mesh, view.group.matrix, camera);
    const rect = { minX: 20, minY: 20, maxX: 180, maxY: 180 };
    const region = rectangleRegion(rect);
    const pick = (cover: THREE.Mesh) =>
      pickInRegion(
        view,
        'face',
        region,
        camera,
        SIZE,
        mesh,
        facing,
        surfaceDepth([cover, solidOf(mesh)], camera, SIZE, rect, false),
      );

    expect(pick(panel(1, 3))).toHaveLength(1);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(3, 3));
    wall.position.set(0, 0, 3);
    wall.updateMatrixWorld(true);
    expect(pick(wall)).toHaveLength(0);
  });

  it('lets the back of a surface hide only when back faces are drawn', () => {
    const camera = close();
    const mesh = createBox(2);
    const view = fullView(mesh);
    const pointer = pixelOf(camera, 1, 0, 1);
    const turned = panel();
    turned.rotation.y = Math.PI;
    turned.updateMatrixWorld(true);
    const pick = (cull: boolean) =>
      pickElement(
        view,
        mesh,
        'edge',
        pointer,
        camera,
        SIZE,
        new THREE.Raycaster(),
        null,
        surfaceDepth([turned], camera, SIZE, pickRect(pointer), cull),
      );

    expect(pick(false)).toBeNull();
    expect(pick(true)).not.toBeNull();
  });
});
