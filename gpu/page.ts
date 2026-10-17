/**
 * The page side of the GPU leak check, loaded into the running editor through
 * Vite so it shares the app's own `three`, store and viewport modules.
 *
 * It answers one question per camera pose: does the viewport draw a vertex dot
 * or a piece of wire that a surface stands in front of, or leave one off that
 * nothing hides? The answer comes from two sources that share no code with the
 * marks under test. What is hidden is a ray cast on the CPU from the eye to each
 * vertex and to points along each edge. What was drawn is the frame read back
 * with the marks on and off.
 */
import * as THREE from 'three';

import { OCCLUDER_LAYER } from '@bridge/materials';
import type { CameraPose } from '@store/types';
import { useEditorStore, type EditorStore } from '@store/useEditorStore';
import { Viewport } from '@viewport/Viewport';

/** The parts of an object view the check reads; all private to the app. */
interface ViewInternals {
  readonly group: THREE.Group;
  readonly solid: THREE.Mesh;
  readonly wire: THREE.Object3D;
  readonly points: THREE.Points;
  readonly vertPositions: Float32Array;
  readonly edgePositions: Float32Array;
  readonly edgeIds: Int32Array;
}

interface ViewportInternals {
  readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  readonly views: Map<string, ViewInternals>;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: { setPose(pose: CameraPose): void };
  readonly frameHandle: number;
  renderLoop(): void;
}

export type SceneName =
  'thin plate' | 'layered sheet' | 'sphere' | 'cylinder' | 'behind another' | 'room';

export interface Pose extends CameraPose {
  orthographic: boolean;
}

/** One mark the check found on the wrong side of the line, for the failure message. */
export interface Finding {
  x: number;
  y: number;
  gapPx: number;
}

export interface PoseReport {
  dots: { checked: number; hidden: number; leaks: Finding[]; missing: Finding[] };
  wire: { checked: number; hidden: number; leaks: Finding[]; missing: Finding[] };
}

/**
 * How far behind a surface a mark has to be to count as hidden, in pixels of
 * depth: the depth gap measured in world units the size of a pixel there.
 * Anything nearer than this, but further than `VISIBLE_PX`, is too close to
 * call either way and is left out.
 */
const HIDDEN_PX = 0.1;
const VISIBLE_PX = 0.01;
/** How much a pixel has to change between the two frames to count as ink. */
const INK = 24;
/**
 * Ink this close to a mark that should show could be that mark's own, so a
 * hidden one there is not judged. The price is that a far-side line running
 * right beside a near one goes unseen.
 */
const CLEARANCE_PX = 3.5;
/** Sample spacing along an edge, in pixels. */
const WIRE_STEP_PX = 1;

/**
 * What the design lets the wire through its own object's surface by. The wire
 * floats towards the camera by what the surface under it gains in depth across
 * half the line's width, so its own faces do not swallow it (see `liftWire` in
 * `src/bridge/materials.ts`), and only other objects' surfaces are tested
 * where it really lies. Layers of one mesh closer than that show through each
 * other by design. These are the design's numbers: half of the 1.4 px line,
 * and the 1 to 8 range its slope is held to.
 */
const WIRE_HALF_PX = 0.7;
const LIFT_SLOPE_MIN = 1;
const LIFT_SLOPE_MAX = 8;
/** Room for rasterising, over the lift itself. */
const LIFT_MARGIN = 1.5;
const LIFT_MARGIN_PX = 0.25;

let live: ViewportInternals | null = null;

function viewport(): ViewportInternals {
  if (!live) throw new Error('No viewport has synced since the check was installed');
  return live;
}

/** Catches the live viewport on its next scene sync, which a mesh touch forces. */
export function install(): void {
  const sync = Viewport.prototype.syncScene;
  Viewport.prototype.syncScene = function syncScene(this: Viewport) {
    live = this as unknown as ViewportInternals;
    sync.call(this);
  };
  useEditorStore.getState().touchMesh();
  viewport();
}

/** The GPU the frames come from, so a report says what it was measured on. */
export function gpuName(): string {
  const gl = viewport().renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
}

/** Builds one of the scenes the leaks came back in, with its marks on show. */
export function build(name: SceneName): void {
  const store = useEditorStore;
  store.getState().resetScene();
  // Both sit in the middle of the view and are drawn over everything, so the
  // marks under them would read as left off.
  store.getState().setOverlay({ cursor: false, origins: false });
  const add = (...args: Parameters<EditorStore['addPrimitive']>) => {
    store.getState().addPrimitive(...args);
    return store.getState().activeObjectId as string;
  };
  const place = (id: string, transform: Parameters<EditorStore['setObjectTransform']>[1]) =>
    store.getState().setObjectTransform(id, transform);

  let active: string;
  if (name === 'thin plate') {
    // A centimetre thick and seen nearly edge on, where the faces either side
    // of every edge are at their steepest and so is every mark's lift.
    active = add('cube');
    place(active, { scale: { x: 1, y: 0.005, z: 1 } });
  } else if (name === 'layered sheet') {
    // One mesh in two layers five millimetres apart, the lower one a fine
    // grid well clear of the upper one's corners. Zoomed out, a dot lifted for
    // the steepest face it could have came up through the layer above.
    active = add('plane', { size: 2 });
    const under = add('grid', { size: 1.6, segments: 8 });
    place(under, { position: { x: 0, y: -0.005, z: 0 } });
    store.setState({ activeObjectId: active, selectedObjectIds: [active, under] });
    store.getState().mergeSelected();
  } else if (name === 'sphere') {
    active = add('uvSphere', { segments: 16, rings: 8 });
  } else if (name === 'cylinder') {
    active = add('cylinder', { segments: 16 });
  } else if (name === 'behind another') {
    // A plate standing in front of the cube being edited, so what hides the
    // cube's marks is another object's surface, which they are tested against
    // apart from their own (see `liftWire` in `src/bridge/materials.ts`).
    active = add('cube');
    const plate = add('cube');
    place(plate, { position: { x: 0, y: 0, z: 1.07 }, scale: { x: 1.5, y: 1.5, z: 0.02 } });
  } else {
    // A room: from inside, every wall faces away from the eye, and the far-side
    // cull once took the whole wire off them. The crate in the middle hides
    // part of each wall, so the room has marks on both sides of the line.
    active = add('cube');
    place(active, { scale: { x: 5, y: 5, z: 5 } });
    const crate = add('cube');
    place(crate, { scale: { x: 0.4, y: 0.4, z: 0.4 } });
  }

  store.setState({ activeObjectId: active, selectedObjectIds: [active], shading: 'solid' });
  store.getState().setMode('edit');
  store.getState().setSelectMode('vertex');
  const mesh = store.getState().objects.find((object) => object.id === active)?.mesh;
  mesh?.deselectAll();
  store.getState().touchMesh();
}

/** Draws one frame now, in place of the next scheduled one, so the pixels can be read back. */
function draw(): Uint8Array {
  const view = viewport();
  cancelAnimationFrame(view.frameHandle);
  view.renderLoop();
  const gl = view.renderer.getContext();
  const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(
    0,
    0,
    gl.drawingBufferWidth,
    gl.drawingBufferHeight,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  );
  return pixels;
}

/** Which pixels change when `mark` is switched off, top row first. */
function ink(
  mark: THREE.Object3D,
  others: THREE.Object3D[],
): { mask: Uint8Array; width: number; height: number } {
  const gl = viewport().renderer.getContext();
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const shown = others.map((other) => other.visible);
  for (const other of others) other.visible = false;

  mark.visible = true;
  const on = draw();
  mark.visible = false;
  const off = draw();
  mark.visible = true;
  others.forEach((other, index) => (other.visible = shown[index]));

  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const read = ((height - 1 - y) * width + x) * 4;
      const change =
        Math.abs(on[read] - off[read]) +
        Math.abs(on[read + 1] - off[read + 1]) +
        Math.abs(on[read + 2] - off[read + 2]);
      mask[y * width + x] = change > INK ? 1 : 0;
    }
  }
  return { mask, width, height };
}

interface Occluder {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  oneSided: boolean;
  owner: string;
}

/** Every surface that hides what is behind it, as world triangles. */
function occluders(): Occluder[] {
  const triangles: Occluder[] = [];
  for (const [owner, view] of viewport().views) {
    const { solid } = view;
    if (!view.group.visible || !solid.visible || !solid.layers.isEnabled(OCCLUDER_LAYER)) continue;
    const material = Array.isArray(solid.material) ? solid.material[0] : solid.material;
    solid.updateMatrixWorld();
    const position = solid.geometry.getAttribute('position');
    const index = solid.geometry.index;
    const count = index ? index.count : position.count;
    const corner = (i: number) =>
      new THREE.Vector3()
        .fromBufferAttribute(position, index ? index.getX(i) : i)
        .applyMatrix4(solid.matrixWorld);
    for (let i = 0; i < count; i += 3) {
      triangles.push({
        a: corner(i),
        b: corner(i + 1),
        c: corner(i + 2),
        oneSided: material.side === THREE.FrontSide,
        owner,
      });
    }
  }
  return triangles;
}

interface Sample {
  x: number;
  y: number;
  state: 'visible' | 'hidden' | 'unsure';
  gapPx: number;
}

/**
 * Where a world point lands on screen and how far in front of it the nearest
 * surface stands, and whether a screen pixel has any surface under it at all.
 */
function sampler(width: number, height: number) {
  const { camera } = viewport();
  camera.updateMatrixWorld();
  const triangles = occluders();
  const toward = camera.getWorldDirection(new THREE.Vector3());
  const hit = new THREE.Vector3();
  const ray = new THREE.Ray();

  const covered = (x: number, y: number): boolean => {
    const ndc = new THREE.Vector3((x / width) * 2 - 1, 1 - (y / height) * 2, -1);
    ray.origin.copy(ndc).unproject(camera);
    if (camera instanceof THREE.PerspectiveCamera) {
      ray.direction.copy(ndc.setZ(1).unproject(camera)).sub(ray.origin).normalize();
    } else {
      ray.direction.copy(toward);
    }
    return triangles.some(({ a, b, c }) => ray.intersectTriangle(a, b, c, false, hit) !== null);
  };

  /**
   * `own` names the object the mark belongs to and how far behind that
   * object's own surface it may sit and still be drawn; behind any other
   * surface it is hidden past `HIDDEN_PX`.
   */
  const at = (point: THREE.Vector3, own?: { id: string; allowedPx: number }): Sample | null => {
    const ndc = point.clone().project(camera);
    if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || Math.abs(ndc.z) > 1) return null;

    let distance: number;
    let pixel: number;
    if (camera instanceof THREE.PerspectiveCamera) {
      ray.origin.copy(camera.position);
      distance = point.distanceTo(camera.position);
      pixel = (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / height;
    } else {
      // An orthographic view draws from its near plane, which stands behind
      // the camera's own position.
      distance = point.clone().sub(camera.position).dot(toward) - camera.near;
      ray.origin.copy(point).addScaledVector(toward, -distance);
      pixel = (camera.top - camera.bottom) / camera.zoom / height;
    }
    ray.direction.copy(point).sub(ray.origin).normalize();

    let nearest = Infinity;
    let by = '';
    for (const { a, b, c, oneSided, owner } of triangles) {
      if (!ray.intersectTriangle(a, b, c, oneSided, hit)) continue;
      const along = hit.distanceTo(ray.origin);
      if (along < nearest) {
        nearest = along;
        by = owner;
      }
    }
    const gapPx = Math.max(0, distance - nearest) / pixel;
    const hiddenPx = own && by === own.id ? Math.max(HIDDEN_PX, own.allowedPx) : HIDDEN_PX;
    return {
      x: ((ndc.x + 1) / 2) * width,
      y: ((1 - ndc.y) / 2) * height,
      state: gapPx < VISIBLE_PX ? 'visible' : gapPx > hiddenPx ? 'hidden' : 'unsure',
      gapPx,
    };
  };

  return { at, covered };
}

/**
 * How steeply the faces either side of an edge climb in depth across the
 * screen, seen along `ray`: the tangent of the angle each is turned from it,
 * the steeper of the two, held to the design's range. Back faces count the
 * same as front ones.
 */
function liftSlope(normals: THREE.Vector3[], ray: THREE.Vector3): number {
  let slope = LIFT_SLOPE_MIN;
  for (const normal of normals) {
    const facing = Math.abs(normal.dot(ray));
    const steepness = facing > 1e-6 ? Math.sqrt(1 - facing * facing) / facing : LIFT_SLOPE_MAX;
    slope = Math.max(slope, Math.min(steepness, LIFT_SLOPE_MAX));
  }
  return slope;
}

/** Inked pixels in the 3 by 3 block round a point. */
function inkAt(mask: Uint8Array, width: number, height: number, x: number, y: number): number {
  const cx = Math.round(x - 0.5);
  const cy = Math.round(y - 0.5);
  let count = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const px = cx + dx;
      const py = cy + dy;
      if (px >= 0 && py >= 0 && px < width && py < height) count += mask[py * width + px];
    }
  }
  return count;
}

/** Answers whether any of `points` lies within `radius` of a spot, bucketed so a dense mesh stays quick. */
function nearness(points: Sample[], radius: number) {
  const buckets = new Map<string, Sample[]>();
  const key = (x: number, y: number) => `${Math.floor(x / radius)},${Math.floor(y / radius)}`;
  for (const point of points) {
    const k = key(point.x, point.y);
    buckets.set(k, [...(buckets.get(k) ?? []), point]);
  }
  return (x: number, y: number) => {
    const bx = Math.floor(x / radius);
    const by = Math.floor(y / radius);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (const point of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
          if (Math.hypot(point.x - x, point.y - y) < radius) return true;
        }
      }
    }
    return false;
  };
}

function judge(
  samples: Sample[],
  mask: Uint8Array,
  width: number,
  height: number,
  minimumInk: number,
  covered: (x: number, y: number) => boolean,
) {
  const visible = samples.filter((sample) => sample.state === 'visible');
  // A mark too close to call is still allowed to show, so its ink is no leak.
  const nearVisible = nearness(
    samples.filter((sample) => sample.state !== 'hidden'),
    CLEARANCE_PX,
  );
  const finding = ({ x, y, gapPx }: Sample): Finding => ({
    x: Math.round(x),
    y: Math.round(y),
    gapPx: Number(gapPx.toFixed(2)),
  });
  const inside = ({ x, y }: Sample) => x > 2 && y > 2 && x < width - 2 && y < height - 2;

  const leaks = samples.filter(
    (sample) =>
      sample.state === 'hidden' &&
      inkAt(mask, width, height, sample.x, sample.y) >= minimumInk &&
      !nearVisible(sample.x, sample.y),
  );
  // Judged only with surface all round. Over the background a dark mark has
  // next to no contrast, so one left off cannot be told from one drawn there,
  // and on a silhouette half of every line lies over the background.
  const surrounded = ({ x, y }: Sample) =>
    covered(x - 2, y) && covered(x + 2, y) && covered(x, y - 2) && covered(x, y + 2);
  const missing = visible.filter(
    (sample) =>
      inside(sample) && inkAt(mask, width, height, sample.x, sample.y) === 0 && surrounded(sample),
  );
  return {
    checked: samples.length,
    hidden: samples.filter((sample) => sample.state === 'hidden').length,
    leaks: leaks.map(finding),
    missing: missing.map(finding),
  };
}

/** Looks at the active object's marks from `pose` and reports any on the wrong side of a surface. */
export function check(pose: Pose): PoseReport {
  const store = useEditorStore;
  if (store.getState().orthographic !== pose.orthographic) {
    store.setState({ orthographic: pose.orthographic });
  }
  const view = viewport();
  view.controls.setPose(pose);
  draw();

  const activeId = store.getState().activeObjectId as string;
  const marks = view.views.get(activeId);
  const mesh = store.getState().objects.find((object) => object.id === activeId)?.mesh;
  if (!marks || !mesh) throw new Error('The active object has no view');
  const toWorld = marks.group.matrixWorld;

  const dots = ink(marks.points, [marks.wire]);
  const dotSampler = sampler(dots.width, dots.height);
  const vertSamples: Sample[] = [];
  for (let i = 0; i < marks.vertPositions.length; i += 3) {
    const point = new THREE.Vector3().fromArray(marks.vertPositions, i).applyMatrix4(toWorld);
    const sample = dotSampler.at(point);
    if (sample) vertSamples.push(sample);
  }

  const wire = ink(marks.wire, [marks.points]);
  const wireSampler = sampler(wire.width, wire.height);
  const edgeSamples: Sample[] = [];
  const { camera } = view;
  const toward = camera.getWorldDirection(new THREE.Vector3());
  const normalToWorld = new THREE.Matrix3().getNormalMatrix(toWorld);
  for (let i = 0; i < marks.edgePositions.length; i += 6) {
    const a = new THREE.Vector3().fromArray(marks.edgePositions, i).applyMatrix4(toWorld);
    const b = new THREE.Vector3().fromArray(marks.edgePositions, i + 3).applyMatrix4(toWorld);
    const edge = mesh.edges.get(marks.edgeIds[i / 6]);
    const normals = (edge ? mesh.edgeFaces(edge) : []).map(({ normal }) =>
      new THREE.Vector3(normal.x, normal.y, normal.z).applyMatrix3(normalToWorld).normalize(),
    );
    const ends = [a.clone().project(camera), b.clone().project(camera)];
    const length = Math.hypot(
      ((ends[1].x - ends[0].x) / 2) * wire.width,
      ((ends[1].y - ends[0].y) / 2) * wire.height,
    );
    const steps = Math.max(2, Math.ceil(length / WIRE_STEP_PX));
    for (let step = 0; step < steps; step += 1) {
      const point = a.clone().lerp(b, (step + 0.5) / steps);
      const ray =
        camera instanceof THREE.PerspectiveCamera
          ? point.clone().sub(camera.position).normalize()
          : toward;
      const lift = WIRE_HALF_PX * liftSlope(normals, ray);
      const sample = wireSampler.at(point, {
        id: activeId,
        allowedPx: lift * LIFT_MARGIN + LIFT_MARGIN_PX,
      });
      if (sample) edgeSamples.push(sample);
    }
  }

  return {
    dots: judge(vertSamples, dots.mask, dots.width, dots.height, 3, dotSampler.covered),
    wire: judge(edgeSamples, wire.mask, wire.width, wire.height, 2, wireSampler.covered),
  };
}
