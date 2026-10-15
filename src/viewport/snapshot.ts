import * as THREE from 'three';

import { ObjectView, imageTexture } from '@bridge/index';
import { type StraightView, VIEW_AXES } from '@kernel/index';
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
 * A camera anywhere round the model, in degrees: `yaw` turns from the front
 * toward the right, so 90 is the right view, and `pitch` rises from level, so
 * 90 looks straight down. The opening view is yaw 45, pitch 30.
 */
export interface SnapshotAngle {
  yaw: number;
  pitch: number;
  /** How tall a slice of the scene the picture takes in, in degrees. Default 50. */
  fov?: number;
}

/**
 * A straight-on view framed on an exact rectangle of the world rather than on
 * the model, so the picture lines up pixel for pixel with another of the same
 * rectangle: a reference picture, measured in metres.
 */
export interface SnapshotFrame {
  view: StraightView;
  /** The world point in the middle of the picture. */
  center: { x: number; y: number; z: number };
  /** Half the picture's width and height, in metres. */
  halfWidth: number;
  halfHeight: number;
}

export type SnapshotShot = SnapshotView | SnapshotAngle | SnapshotFrame;

/**
 * How the picture is projected. `auto` draws the opening view and any angle in
 * perspective and the straight-on views flat, which is what a set of views of
 * a model is read as: the straight-on ones are for measuring against each other.
 */
export type SnapshotProjection = 'auto' | 'perspective' | 'orthographic';

/**
 * The viewport's own shadings, and `silhouette`: the model in black on white,
 * which shows whether its shape reads before anything else about it, and is
 * what a reference is compared against.
 */
export type SnapshotShading = ShadingMode | 'silhouette';

export interface SnapshotOptions {
  width: number;
  height: number;
  shading: SnapshotShading;
  projection: SnapshotProjection;
  /** The ground grid and its two centre lines, as the viewport draws them. */
  grid: boolean;
  /** Draw only the objects with these ids. Default: every visible object. */
  objects?: ReadonlySet<string>;
}

export interface Snapshot {
  /** The view's name, or the angle it was taken from, such as `yaw 30 pitch 10`. */
  view: string;
  /** A PNG, as a `data:` URL. */
  dataUrl: string;
}

const isAngle = (shot: SnapshotShot): shot is SnapshotAngle =>
  typeof shot === 'object' && 'yaw' in shot;

const isFrame = (shot: SnapshotShot): shot is SnapshotFrame =>
  typeof shot === 'object' && 'halfWidth' in shot;

/** What a picture from `shot` is called. */
export function shotLabel(shot: SnapshotShot): string {
  if (isFrame(shot)) return shot.view;
  if (!isAngle(shot)) return shot;
  const fov = shot.fov === undefined ? '' : ` fov ${shot.fov}`;
  return `yaw ${shot.yaw} pitch ${shot.pitch}${fov}`;
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

/** Where the poles are kept from, as the editor's orbit keeps them. */
const POLE_MARGIN = 0.001;

/** Where the camera stands for a view, as the editor's orbit would put it. */
export function snapshotAngles(view: SnapshotView | SnapshotAngle): ViewAngles {
  if (isAngle(view)) {
    const phi = Math.PI / 2 - THREE.MathUtils.degToRad(view.pitch);
    return {
      phi: Math.min(Math.PI - POLE_MARGIN, Math.max(POLE_MARGIN, phi)),
      theta: THREE.MathUtils.degToRad(view.yaw),
    };
  }
  if (view === 'perspective') return OPENING_VIEW;
  const [axis, negative] = AXIS_OF_VIEW[view];
  return axisViewAngles(axis, negative);
}

function isFlat(view: SnapshotView | SnapshotAngle, projection: SnapshotProjection): boolean {
  if (projection === 'auto') return !isAngle(view) && view !== 'perspective';
  return projection === 'orthographic';
}

/**
 * An orthographic camera on exactly the rectangle `frame` names, looking along
 * its view, with depth enough for everything in `box`.
 */
export function framedCamera(
  frame: SnapshotFrame,
  box: THREE.Box3,
): { camera: THREE.OrthographicCamera; distance: number } {
  const { up, toward } = VIEW_AXES[frame.view];
  const center = new THREE.Vector3(frame.center.x, frame.center.y, frame.center.z);
  const back = new THREE.Vector3(toward.x, toward.y, toward.z);

  let reach = 1;
  if (!box.isEmpty()) {
    for (let index = 0; index < 8; index++) {
      const corner = new THREE.Vector3(
        index & 1 ? box.max.x : box.min.x,
        index & 2 ? box.max.y : box.min.y,
        index & 4 ? box.max.z : box.min.z,
      );
      reach = Math.max(reach, Math.abs(corner.sub(center).dot(back)));
    }
  }

  const { halfWidth, halfHeight } = frame;
  const camera = new THREE.OrthographicCamera(
    -halfWidth,
    halfWidth,
    halfHeight,
    -halfHeight,
    0.01,
    reach * 2 + 2,
  );
  camera.position.copy(center).addScaledVector(back, reach + 1);
  camera.up.set(up.x, up.y, up.z);
  camera.lookAt(center);
  camera.updateMatrixWorld();
  return { camera, distance: halfHeight / 0.6 };
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
  view: SnapshotView | SnapshotAngle,
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

  const fov = isAngle(view) && view.fov !== undefined ? view.fov : FOV;
  const halfV = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
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
  const camera = new THREE.PerspectiveCamera(fov, aspect, near, distance * 20 + radius * 4);
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
  shots: readonly SnapshotShot[],
  options: SnapshotOptions,
): Promise<Snapshot[]> {
  const state = useEditorStore.getState();
  const { width, height } = options;
  const silhouette = options.shading === 'silhouette';
  const showGrid = options.grid && !silhouette;

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
  scene.background = new THREE.Color(silhouette ? 0xffffff : state.viewportBackground);
  addViewportLights(scene);
  // Both sides, so a plane seen from behind is in the silhouette too.
  const ink = silhouette
    ? new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide })
    : null;
  scene.overrideMaterial = ink;

  const grid = new ViewportGrid({
    scale: state.gridScale,
    subdivisions: state.gridSubdivisions,
    color: state.gridColor,
    opacity: state.gridOpacity,
    majorColor: state.gridMajorColor,
    majorOpacity: state.gridMajorOpacity,
  });
  grid.setVisibility(showGrid, showGrid);
  scene.add(grid.group);

  const settings: ViewportSettings = {
    shading: options.shading === 'silhouette' ? 'solid' : options.shading,
    overlays: {
      ...state.overlays,
      origins: false,
      normals: false,
      faceOrientation: false,
      nonPlanar: false,
    },
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
      if (options.objects && !options.objects.has(object.id)) continue;
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

    const pictures: Snapshot[] = [];
    for (const shot of shots) {
      const { camera, distance } = isFrame(shot)
        ? framedCamera(shot, box)
        : snapshotCamera(shot, box, width / height, options.projection);
      grid.update(distance);
      const eye = camera.position;
      for (const objectView of objectViews) {
        objectView.refreshForCamera({ x: eye.x, y: eye.y, z: eye.z });
      }
      renderer.render(scene, camera);
      pictures.push({ view: shotLabel(shot), dataUrl: canvas.toDataURL('image/png') });
    }
    return pictures;
  } finally {
    for (const view of objectViews) view.dispose();
    ink?.dispose();
    grid.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
