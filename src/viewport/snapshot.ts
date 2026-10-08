import * as THREE from 'three';

import { ObjectView, imageTexture } from '@bridge/index';
import { evaluatedMesh, useEditorStore } from '@store/index';
import type { ShadingMode, ViewportSettings } from '@store/types';

import { type ViewAngles, OPENING_VIEW, axisViewAngles, upSign } from './CameraController';
import { addViewportLights } from './Viewport';
import { ViewportGrid } from './grid';

/**
 * The views a snapshot can be taken from: the one a fresh tab opens on, and
 * the six straight-on views that Shift+1, 3 and 7 and Ctrl+Shift+1, 3 and 7
 * give in the editor.
 */
export const SNAPSHOT_VIEWS = [
  'perspective',
  'front',
  'back',
  'right',
  'left',
  'top',
  'bottom',
] as const;

export type SnapshotView = (typeof SNAPSHOT_VIEWS)[number];

/**
 * How the picture is projected. `auto` draws the opening view in perspective
 * and the straight-on views flat, which is what a set of views of a model is
 * read as: the straight-on ones are for measuring against each other.
 */
export type SnapshotProjection = 'auto' | 'perspective' | 'orthographic';

export interface SnapshotOptions {
  width: number;
  height: number;
  shading: ShadingMode;
  projection: SnapshotProjection;
  /** The ground grid and its two centre lines, as the viewport draws them. */
  grid: boolean;
}

export interface Snapshot {
  view: SnapshotView;
  /** A PNG, as a `data:` URL. */
  dataUrl: string;
}

const AXIS_OF_VIEW: Record<Exclude<SnapshotView, 'perspective'>, ['x' | 'y' | 'z', boolean]> = {
  front: ['z', false],
  back: ['z', true],
  right: ['x', false],
  left: ['x', true],
  top: ['y', false],
  bottom: ['y', true],
};

/** The viewport's own field of view, which the opening view is seen through. */
const FOV = 50;

/** Room left round the model, as a share of its size on screen. */
const MARGIN = 1.12;

/** Where the camera stands for a view, as the editor's orbit would put it. */
export function snapshotAngles(view: SnapshotView): ViewAngles {
  if (view === 'perspective') return OPENING_VIEW;
  const [axis, negative] = AXIS_OF_VIEW[view];
  return axisViewAngles(axis, negative);
}

function isFlat(view: SnapshotView, projection: SnapshotProjection): boolean {
  if (projection === 'auto') return view !== 'perspective';
  return projection === 'orthographic';
}

/**
 * A camera that frames `box` from `view`.
 *
 * Tighter than Frame All in the editor, which leaves room to work round the
 * model: a picture wants the model to fill it. The box is measured in the
 * camera's own axes rather than through its bounding sphere, so a long thin
 * part seen end on does not leave the frame mostly empty.
 */
export function snapshotCamera(
  view: SnapshotView,
  box: THREE.Box3,
  aspect: number,
  projection: SnapshotProjection,
): { camera: THREE.PerspectiveCamera | THREE.OrthographicCamera; distance: number } {
  const framed = box.isEmpty()
    ? new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1))
    : box;
  const center = framed.getCenter(new THREE.Vector3());
  const radius = Math.max(framed.getSize(new THREE.Vector3()).length() / 2, 0.01);

  const { phi, theta } = snapshotAngles(view);
  const toEye = new THREE.Vector3().setFromSpherical(new THREE.Spherical(1, phi, theta));
  const up = new THREE.Vector3(0, upSign(phi), 0);

  // The camera's right and up, from a matrix aimed the way the camera will be.
  const basis = new THREE.Matrix4().lookAt(toEye, new THREE.Vector3(), up);
  const right = new THREE.Vector3().setFromMatrixColumn(basis, 0);
  const screenUp = new THREE.Vector3().setFromMatrixColumn(basis, 1);

  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((index) =>
    new THREE.Vector3(
      index & 1 ? framed.max.x : framed.min.x,
      index & 2 ? framed.max.y : framed.min.y,
      index & 4 ? framed.max.z : framed.min.z,
    ).sub(center),
  );

  if (isFlat(view, projection)) {
    let halfWidth = 0;
    let halfHeight = 0;
    for (const corner of corners) {
      halfWidth = Math.max(halfWidth, Math.abs(corner.dot(right)));
      halfHeight = Math.max(halfHeight, Math.abs(corner.dot(screenUp)));
    }
    const half = Math.max(halfHeight, halfWidth / aspect, 0.01) * MARGIN;
    const distance = radius * 4 + 1;
    const camera = new THREE.OrthographicCamera(
      -half * aspect,
      half * aspect,
      half,
      -half,
      0.01,
      distance + radius * 4,
    );
    camera.position.copy(center).addScaledVector(toEye, distance);
    camera.up.copy(up);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    // The orbit radius the editor would show this frame at, which is what the
    // grid sizes its cells by: an ortho frame is 0.6 of the radius high.
    return { camera, distance: half / 0.6 };
  }

  const halfV = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
  const halfH = halfV * aspect;
  let distance = 0;
  for (const corner of corners) {
    const depth = corner.dot(toEye);
    distance = Math.max(
      distance,
      depth + (Math.abs(corner.dot(screenUp)) * MARGIN) / halfV,
      depth + (Math.abs(corner.dot(right)) * MARGIN) / halfH,
    );
  }

  const near = Math.max(distance * 0.01, distance - radius * 1.5);
  const camera = new THREE.PerspectiveCamera(FOV, aspect, near, distance * 20 + radius * 4);
  camera.position.copy(center).addScaledVector(toEye, distance);
  camera.up.copy(up);
  camera.lookAt(center);
  camera.updateMatrixWorld();
  return { camera, distance };
}

/** Waits for the pictures on image planes to decode, so they are in the shot. */
async function texturesLoaded(textures: readonly THREE.Texture[], timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (textures.some((texture) => !texture.image) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Pictures of the scene from each of `views`, drawn offscreen.
 *
 * Built from the bridge's own object views, lights and grid, so a snapshot
 * shades and wires the model the way the viewport does. Nothing is selected in
 * it and no editing overlay is drawn: the cursor, the origins and the gizmo
 * belong to working on a model, not to a picture of it. Needs WebGL, so it runs
 * in a browser, which for an assistant is the headless one the MCP server
 * drives.
 */
export async function renderSnapshots(
  views: readonly SnapshotView[],
  options: SnapshotOptions,
): Promise<Snapshot[]> {
  const state = useEditorStore.getState();
  const { width, height } = options;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    stencil: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(state.viewportBackground);
  addViewportLights(scene);

  const grid = new ViewportGrid({
    scale: state.gridScale,
    subdivisions: state.gridSubdivisions,
    color: state.gridColor,
    opacity: state.gridOpacity,
    majorColor: state.gridMajorColor,
    majorOpacity: state.gridMajorOpacity,
  });
  grid.setVisibility(options.grid, options.grid);
  scene.add(grid.group);

  const settings: ViewportSettings = {
    shading: options.shading,
    overlays: { ...state.overlays, origins: false, normals: false, faceOrientation: false },
    backfaceCulling: state.backfaceCulling,
    orthographic: options.projection === 'orthographic',
    focalLength: state.focalLength,
    clipStart: state.clipStart,
    clipEnd: state.clipEnd,
    navigation: state.navigation,
  };

  const objectViews: ObjectView[] = [];
  const textures: THREE.Texture[] = [];
  const box = new THREE.Box3();
  try {
    for (const object of state.objects) {
      if (!object.visible || object.lattice) continue;
      const asset = object.image ? state.assets[object.image.assetId] : undefined;
      const texture = asset ? imageTexture(asset) : null;
      if (texture) textures.push(texture);

      const view = new ObjectView(object.id);
      view.setResolution(width, height, 1);
      view.update(object, evaluatedMesh(object, state.cursor, state.meshVersion, state.objects), {
        texture,
        mode: 'object',
        selectMode: state.selectMode,
        isActive: false,
        isSelected: false,
        eye: { x: 0, y: 0, z: 0 },
        selectionLine: { color: state.selectionLineColor, width: state.selectionLineWidth },
        meshVersion: state.meshVersion,
        settings,
      });
      scene.add(view.group);
      objectViews.push(view);
      box.expandByObject(view.group);
    }
    await texturesLoaded(textures);

    const shots: Snapshot[] = [];
    for (const view of views) {
      const { camera, distance } = snapshotCamera(view, box, width / height, options.projection);
      grid.update(distance);
      const eye = camera.position;
      for (const objectView of objectViews) {
        objectView.refreshForCamera({ x: eye.x, y: eye.y, z: eye.z });
      }
      renderer.render(scene, camera);
      shots.push({ view, dataUrl: canvas.toDataURL('image/png') });
    }
    return shots;
  } finally {
    for (const view of objectViews) view.dispose();
    grid.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
