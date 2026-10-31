import * as THREE from 'three';
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOT_OCCLUSION, NO_OCCLUSION_MAP } from '@bridge/materials';
import { MIN_OBJECT_SIZE } from '@kernel/index';
import { useEditorStore } from '@store/index';

import { MAX_ORBIT_DISTANCE, MIN_ORBIT_DISTANCE } from './CameraController';
import { Viewport } from './Viewport';

// The one part of the viewport jsdom cannot build: there is no WebGL context to
// hand a real renderer. Everything else (the camera, the gizmo, the store
// subscriptions, the scene sync) is the real code, which is what lets these
// tests catch wiring that a pure function pulled out of it never could.
vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();

  class WebGLRenderer {
    readonly domElement: HTMLCanvasElement;
    constructor({ canvas }: { canvas: HTMLCanvasElement }) {
      this.domElement = canvas;
    }
    setPixelRatio() {}
    getPixelRatio() {
      return 1;
    }
    setSize() {}
    getClearColor(target: THREE.Color) {
      return target;
    }
    getClearAlpha() {
      return 1;
    }
    setClearColor() {}
    setRenderTarget() {}
    // What a real render does before drawing, and what the gizmo's pointer
    // handling reads back: the world matrices of everything in the scene.
    render(scene: THREE.Object3D, camera: THREE.Camera) {
      scene.updateMatrixWorld();
      if (!camera.parent) camera.updateMatrixWorld();
    }
    dispose() {}
  }

  return { ...three, WebGLRenderer };
});

const SIZE = 800;

function store() {
  return useEditorStore.getState();
}

let viewport: Viewport | null = null;

function mount() {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: SIZE });
  Object.defineProperty(canvas, 'clientHeight', { value: SIZE });
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: SIZE, bottom: SIZE, width: SIZE, height: SIZE }) as DOMRect;
  document.body.append(canvas);
  viewport = new Viewport(canvas, document.createElement('div'));
  return viewport;
}

type GizmoPointer = { x: number; y: number; button: number };

/** The viewport's own gizmo, and its pointer methods, which take view coordinates. */
function gizmoOf(view: Viewport) {
  const inside = view as unknown as { gizmo: TransformControls; gizmoHelper: THREE.Object3D };
  const gizmo = inside.gizmo as TransformControls & {
    pointerDown: (pointer: GizmoPointer) => void;
    pointerMove: (pointer: GizmoPointer) => void;
    pointerUp: (pointer: GizmoPointer) => void;
  };
  return { gizmo, helper: inside.gizmoHelper };
}

/** Runs the render loop once, which is where the viewport settles what a frame draws. */
function frame(view: Viewport) {
  (view as unknown as { renderLoop: () => void }).renderLoop();
}

/** The camera the viewport draws with, and whether a point is inside what it draws. */
function sees(view: Viewport, point: THREE.Vector3) {
  const camera = (view as unknown as { camera: THREE.PerspectiveCamera }).camera;
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  return frustum.containsPoint(point);
}

/** Stands the camera `radius` from the origin, looking down -Z when given no angles. */
function poseAt(radius: number, phi = Math.PI / 2, theta = 0) {
  useEditorStore.setState({ cameraPose: { target: { x: 0, y: 0, z: 0 }, radius, phi, theta } });
}

describe('Viewport', () => {
  beforeEach(() => {
    store().resetScene();
    useEditorStore.setState({ cameraPose: null });
  });

  afterEach(() => {
    viewport?.dispose();
    viewport = null;
  });

  it('leaves a readable stand-in in the occlusion map once its frame is drawn', () => {
    store().addPrimitive('cube');
    const view = mount();
    frame(view);
    // The map used to go back to null after the frame, so the next renderer to
    // draw these materials, the one that takes the MCP's pictures, bound a float
    // texture to their unsigned integer sampler and WebGL2 dropped every wire.
    expect(DOT_OCCLUSION.dotOcclusionMap.value).toBe(NO_OCCLUSION_MAP);
    expect(DOT_OCCLUSION.dotOcclusionActive.value).toBe(false);
  });

  it('carries a dragged object step for step with the pointer, through the store updates it causes', () => {
    store().addPrimitive('cube');
    // Square on to the view, so X runs flat across the screen and equal steps
    // of the pointer are equal steps along it.
    poseAt(10);
    const { gizmo } = gizmoOf(mount());
    const moved: number[] = [];

    // Above the cube, so the press is not held back for a click on what lies
    // behind the handle.
    gizmo.axis = 'X';
    gizmo.pointerDown({ x: 0.6, y: 0.6, button: 0 });
    expect(gizmo.dragging).toBe(true);
    for (const x of [0.65, 0.7, 0.75, 0.8]) {
      gizmo.pointerMove({ x, y: 0.6, button: -1 });
      moved.push(store().objects[0].transform.position.x);
    }
    gizmo.pointerUp({ x: 0.8, y: 0.6, button: 0 });

    // Every move writes the object to the store, and the store answers with a
    // resync. That resync used to seat the gizmo again mid-drag and take a new
    // baseline from it, so each step was measured from the last one instead of
    // from the press, and the object stuttered back and forth under a pointer
    // moving steadily one way. The handle went with it, so only the pointer
    // says where the object should be.
    expect(moved[0]).toBeGreaterThan(0);
    moved.forEach((x, step) => expect(x).toBeCloseTo(moved[0] * (step + 1), 6));
  });

  it('takes the gizmo off an object the moment it is locked', () => {
    store().addPrimitive('cube');
    const { gizmo, helper } = gizmoOf(mount());
    expect(gizmo.enabled).toBe(true);

    store().toggleObjectLock(store().objects[0].id);

    // A lock changes no geometry and no selection, so nothing else resyncs the
    // viewport, and the handles used to stay up on an object they could not
    // move.
    expect(gizmo.enabled).toBe(false);
    expect(helper.visible).toBe(false);
  });

  it('keeps the handles out of reach for the whole of a modal scale', () => {
    store().addPrimitive('cube');
    const view = mount();
    const { gizmo, helper } = gizmoOf(view);

    store().beginModal('scale');
    expect(gizmo.enabled).toBe(false);

    // A resync partway through, as every tick of the scale causes. It used to
    // bring the handles back enabled under the scale's own line: hidden or not,
    // three still lit them up under the pointer and let them take a drag.
    store().touchMesh();
    expect(gizmo.enabled).toBe(false);

    // Re-attaching shows the helper again, so whether it is drawn is settled
    // by the frame, before anything reaches the screen.
    frame(view);
    expect(helper.visible).toBe(false);
  });

  it('calls off a modal scale when it is disposed partway through', () => {
    store().addPrimitive('cube');
    const view = mount();
    store().beginModal('scale');

    view.dispose();
    viewport = null;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    window.dispatchEvent(enter);

    // Only a knife cut was called off. A scale, a turn, a slide or an offset
    // drag left the store holding the modal and its listeners on the window,
    // where they swallowed the next Enter, Esc or click for a viewport that
    // was gone, and the next viewport's gesture never heard its confirm.
    expect(store().modal).toBeNull();
    expect(enter.defaultPrevented).toBe(false);
  });

  it('puts a confirmed extrude drag up as a success toast', () => {
    store().addPrimitive('cube');
    poseAt(10);
    store().setMode('edit');
    store().setSelectMode('face');
    const mesh = store().objects[0].mesh;
    mesh.deselectAll();
    for (const face of mesh.faces.values()) face.selected = face.normal.y > 0.99;
    mesh.flushSelection('face');
    const view = mount();
    frame(view);
    useEditorStore.setState({ toasts: [] });
    const canvas = (view as unknown as { canvas: HTMLCanvasElement }).canvas;
    const move = (y: number) =>
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: SIZE / 2, clientY: y }));

    store().beginModal('extrude');
    move(SIZE / 2);
    move(SIZE / 2 - 100);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    // E runs the operator itself rather than through the store, so it said
    // what it did in the status bar alone while a button for the same extrude
    // raised a toast.
    expect(store().status).toMatch(/^Extruded 1 face/);
    expect(store().toasts.map(({ variant, message }) => [variant, message])).toEqual([
      ['success', store().status],
    ]);
  });

  it('drags an extrude along normals out with each face on its own normal', () => {
    store().addPrimitive('cube');
    poseAt(10);
    store().setMode('edit');
    store().setSelectMode('face');
    const mesh = store().objects[0].mesh;
    const back = Math.min(...[...mesh.verts.values()].map((vert) => vert.co.z));
    mesh.deselectAll();
    for (const face of mesh.faces.values()) {
      face.selected = face.normal.y > 0.99 || face.normal.z > 0.99;
    }
    mesh.flushSelection('face');
    const view = mount();
    frame(view);
    const canvas = (view as unknown as { canvas: HTMLCanvasElement }).canvas;
    const move = (y: number) =>
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: SIZE / 2, clientY: y }));

    store().beginOffset('extrudeAlongNormals');
    move(SIZE / 2);
    move(SIZE / 2 - 100);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    const params = store().lastOperator?.params;
    expect(params).toMatchObject({ alongNormals: true });
    expect(params?.offset).toBeGreaterThan(0);
    expect(store().historyUndo[0]).toBe('Extrude along normals');
    // The top rises straight up, so its back edge stays over the cube's back.
    // Taken along the two faces' average, it would have leant forward with them.
    const moved = store().objects[0].mesh.selectedVerts();
    expect(Math.min(...moved.map((vert) => vert.co.z))).toBeCloseTo(back);
  });

  it('keeps the target in view at the furthest the orbit zooms out', () => {
    store().addPrimitive('cube');
    poseAt(MAX_ORBIT_DISTANCE);

    // The far plane used to be a fixed 2000 while the orbit reached 5000, so
    // the target and everything round it fell out of the frustum and the
    // viewport went blank well short of the zoom limit.
    expect(sees(mount(), new THREE.Vector3(0, 0, 0))).toBe(true);
  });

  it('keeps the near side of the smallest object in view at the closest the orbit zooms in', () => {
    store().addPrimitive('cube');
    poseAt(MIN_ORBIT_DISTANCE);
    const view = mount();

    // The near plane used to be a fixed 0.05 m, so closing in on a small part
    // cut through it until it thinned to a wedge and vanished.
    const camera = (view as unknown as { camera: THREE.Camera }).camera;
    const towardCamera = camera.position.clone().normalize();
    expect(sees(view, towardCamera.multiplyScalar(MIN_OBJECT_SIZE / 2))).toBe(true);
  });
});
