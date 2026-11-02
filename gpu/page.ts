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
import type { BMesh } from '@kernel/index';
import type { CameraPose } from '@store/types';
import { useEditorStore, type EditorStore } from '@store/useEditorStore';
import { renderSnapshots } from '@viewport/snapshot';
import { Viewport } from '@viewport/Viewport';

/** The parts of an object view the check reads; all private to the app. */
interface ViewInternals {
  readonly group: THREE.Group;
  readonly solid: THREE.Mesh;
  readonly wire: THREE.Object3D;
  readonly points: THREE.Points;
  readonly vertPositions: Float32Array;
  readonly edgePositions: Float32Array;
}

interface ViewportInternals {
  readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  readonly views: Map<string, ViewInternals>;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: { setPose(pose: CameraPose): void };
  readonly frameHandle: number;
  renderLoop(): void;
  renderDotOcclusion(): boolean;
}

export type SceneName =
  | 'thin plate'
  | 'layered sheet'
  | 'folded sheet'
  | 'sphere'
  | 'cylinder'
  | 'behind another'
  | 'room'
  | 'twisted strips'
  | 'edge under an outline'
  | 'bent cap';

/** Where the marks are drawn: edit mode in one of two select modes, or object mode with the wire on. */
export type MarkMode = 'vertex' | 'edge' | 'object';

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
  wire: {
    checked: number;
    hidden: number;
    leaks: Finding[];
    missing: Finding[];
    /** Pixels of visible wire the occlusion pass took away, a whole line or part of its width. */
    thinned: Finding[];
  };
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
 * How far from a sample on the wire a pixel's centre may be and still lie on
 * the line: its half width, 0.7 of a pixel, and a little for the samples
 * standing a pixel apart along it.
 */
const WIRE_BODY_PX = 0.75;

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

/**
 * How many pixels the wire changes in a picture of a cube, taken the way the
 * MCP's `render_views` takes them: the same view in `solid` and in
 * `solidWire`, compared pixel by pixel. The wire is dark, so it is measured
 * over the light surface rather than against the dark background. Pictures
 * come from a renderer of their own, outside the viewport's frame.
 */
export async function pictureWire(): Promise<number> {
  const store = useEditorStore.getState();
  store.resetScene();
  store.addPrimitive('cube');
  const size = 320;
  const pixels = async (shading: 'solid' | 'solidWire') => {
    const [shot] = await renderSnapshots(['perspective'], {
      width: size,
      height: size,
      shading,
      projection: 'auto',
      grid: false,
    });
    const image = new Image();
    image.src = shot.dataUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D context to read the picture with');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, size, size).data;
  };
  const plain = await pixels('solid');
  const wired = await pixels('solidWire');
  let wire = 0;
  for (let i = 0; i < plain.length; i += 4) {
    const change =
      Math.abs(plain[i] - wired[i]) +
      Math.abs(plain[i + 1] - wired[i + 1]) +
      Math.abs(plain[i + 2] - wired[i + 2]);
    if (change > 30) wire++;
  }
  return wire;
}

/** Builds one of the scenes the leaks came back in, with its marks on show. */
export function build(name: SceneName, mode: MarkMode = 'vertex'): void {
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
  } else if (name === 'folded sheet') {
    active = add('plane', { size: 2 });
    foldSheet(store.getState().objects.find((object) => object.id === active)?.mesh);
  } else if (name === 'sphere') {
    active = add('uvSphere', { segments: 16, rings: 8 });
  } else if (name === 'cylinder') {
    active = add('cylinder', { segments: 16 });
  } else if (name === 'twisted strips') {
    active = add('plane', { size: 2 });
    twistStrips(store.getState().objects.find((object) => object.id === active)?.mesh);
  } else if (name === 'edge under an outline') {
    // A plate over the cube with its right edge a millimetre past the cube's,
    // a fraction of a pixel on screen: seen square on, the cube's right edges
    // run just inside the plate's outline, all of them hidden. Tested where
    // each fragment lay, the half of the line past the outline was drawn.
    active = add('cube');
    const plate = add('cube');
    place(plate, { position: { x: -0.7495, y: 0, z: 1.2 }, scale: { x: 2.501, y: 3, z: 0.02 } });
  } else if (name === 'bent cap') {
    // A cylinder's cap is one face of 24 corners, and here one of them stands
    // a centimetre proud, so the cap is not quite flat. The pass knows a face
    // only one triangle past each diagonal, and a triangle further across,
    // taken to go on to the rim, stood in front of the rim's own edges.
    active = add('cylinder', { segments: 24 });
    const mesh = store.getState().objects.find((object) => object.id === active)?.mesh;
    const top = [...(mesh?.verts.values() ?? [])].filter((vert) => vert.co.y > 0);
    if (!mesh || top.length === 0) throw new Error('The bent cap has no top to bend');
    top[0].co = { ...top[0].co, y: top[0].co.y + 0.01 };
    mesh.computeNormals();
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

  if (mode === 'object') {
    // Selected, it would carry the gizmo and the outline, both drawn over the
    // wire wherever they cross it.
    store.setState({ activeObjectId: active, selectedObjectIds: [], shading: 'solidWire' });
    store.getState().setMode('object');
  } else {
    store.setState({ activeObjectId: active, selectedObjectIds: [active], shading: 'solid' });
    store.getState().setMode('edit');
    store.getState().setSelectMode(mode);
  }
  const mesh = store.getState().objects.find((object) => object.id === active)?.mesh;
  mesh?.deselectAll();
  store.getState().touchMesh();
}

/**
 * An open sheet of long, narrow quads, each a little out of flat. A quad's
 * diagonal runs within a few degrees of its long edges, so beside each of them
 * lies the triangle across the diagonal for many pixels, and out of flat that
 * triangle's plane, carried to the edge, stands just in front of it or just
 * behind. Thin parts of a model are made of quads like these.
 */
function twistStrips(mesh: BMesh | undefined): void {
  if (!mesh) throw new Error('The twisted strips have no mesh to twist');
  mesh.clear();
  const across = [-1, 0, 1];
  const rows = Array.from({ length: 21 }, (_, j) => -1 + j * 0.1);
  const grid = rows.map((z, j) =>
    across.map((x, i) => mesh.addVert({ x, y: 0.01 * Math.sin(2.3 * i + 1.7 * j), z })),
  );
  for (let j = 0; j + 1 < rows.length; j += 1) {
    for (let i = 0; i + 1 < across.length; i += 1) {
      mesh.addFace([grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1]]);
    }
  }
  mesh.computeNormals();
}

/**
 * An open sheet folded back under itself, two degrees apart, the lower leaf's
 * rows fanning in under the upper leaf's. Every lower edge starts at a vertex
 * of the fold, level with the face over it, and the gap opens slowly: lifted
 * clear of its own faces, each came through the upper leaf as a tip running
 * out from the fold. Open, so the far-side cull never runs and depth alone
 * hides them.
 */
function foldSheet(mesh: BMesh | undefined): void {
  if (!mesh) throw new Error('The folded sheet has no mesh to fold');
  mesh.clear();
  const fold = (2 * Math.PI) / 180;
  const rows = [-1, -0.5, 0, 0.5, 1];
  const across = [0, 0.5, 1];
  const upper = across.map((d) => rows.map((z) => mesh.addVert({ x: -d, y: 0, z })));
  const lower = across.map((d, j) =>
    j === 0
      ? upper[0]
      : rows.map((z) =>
          mesh.addVert({ x: -d * Math.cos(fold), y: -d * Math.sin(fold), z: z * (1 - d / 2) }),
        ),
  );
  for (let j = 0; j + 1 < across.length; j += 1) {
    for (let i = 0; i + 1 < rows.length; i += 1) {
      mesh.addFace([upper[j][i], upper[j + 1][i], upper[j + 1][i + 1], upper[j][i + 1]]);
      mesh.addFace([lower[j][i], lower[j][i + 1], lower[j + 1][i + 1], lower[j + 1][i]]);
    }
  }
  mesh.computeNormals();
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

/**
 * The frame with `wire` drawn as if nothing stood in front of it: no occlusion
 * pass and no depth test, every line whole wherever it runs.
 */
function unhidden(wire: THREE.Mesh, others: THREE.Object3D[]): Uint8Array {
  const view = viewport() as Partial<Pick<ViewportInternals, 'renderDotOcclusion'>>;
  const material = wire.material as THREE.Material;
  const shown = others.map((other) => other.visible);
  for (const other of others) other.visible = false;
  view.renderDotOcclusion = () => false;
  material.depthTest = false;
  try {
    return draw();
  } finally {
    material.depthTest = true;
    delete view.renderDotOcclusion;
    others.forEach((other, index) => (other.visible = shown[index]));
  }
}

/** How much a pixel changes between two frames, read from the first word of it. */
function change(a: Uint8Array, b: Uint8Array, read: number): number {
  return (
    Math.abs(a[read] - b[read]) +
    Math.abs(a[read + 1] - b[read + 1]) +
    Math.abs(a[read + 2] - b[read + 2])
  );
}

/** Which pixels change when `mark` is switched off, top row first, and the two frames. */
function ink(
  mark: THREE.Object3D,
  others: THREE.Object3D[],
): { mask: Uint8Array; width: number; height: number; on: Uint8Array; off: Uint8Array } {
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
      mask[y * width + x] = change(on, off, ((height - 1 - y) * width + x) * 4) > INK ? 1 : 0;
    }
  }
  return { mask, width, height, on, off };
}

interface Occluder {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  oneSided: boolean;
}

/** Every surface that hides what is behind it, as world triangles. */
function occluders(): Occluder[] {
  const triangles: Occluder[] = [];
  for (const view of viewport().views.values()) {
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

  const at = (point: THREE.Vector3): Sample | null => {
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
    for (const { a, b, c, oneSided } of triangles) {
      if (!ray.intersectTriangle(a, b, c, oneSided, hit)) continue;
      nearest = Math.min(nearest, hit.distanceTo(ray.origin));
    }
    const gapPx = Math.max(0, distance - nearest) / pixel;
    return {
      x: ((ndc.x + 1) / 2) * width,
      y: ((1 - ndc.y) / 2) * height,
      state: gapPx < VISIBLE_PX ? 'visible' : gapPx > HIDDEN_PX ? 'hidden' : 'unsure',
      gapPx,
    };
  };

  return { at, covered };
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

/**
 * Visible wire the viewport took away, whatever took it: ink the line has when
 * nothing hides it (`unhidden`) that the frame lost more than half of, on a
 * visible stretch of wire and clear of any sample hidden or too close to call.
 * Half a line's width counts as much as a whole line, which `judge` would
 * never call left off.
 *
 * Only pixels whose centre is within the line itself count. One whose centre
 * lies past it is ink the antialiasing gave the line's edge, and a sample or
 * two of it changing is no line lost.
 */
function thinned(
  samples: Sample[],
  frames: { on: Uint8Array; off: Uint8Array; reference: Uint8Array },
  width: number,
  height: number,
): Finding[] {
  const onVisible = nearness(
    samples.filter((sample) => sample.state === 'visible'),
    WIRE_BODY_PX,
  );
  const nearOther = nearness(
    samples.filter((sample) => sample.state !== 'visible'),
    CLEARANCE_PX,
  );
  const findings: Finding[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const read = ((height - 1 - y) * width + x) * 4;
      const whole = change(frames.reference, frames.off, read);
      if (whole <= 2 * INK || change(frames.on, frames.reference, read) <= whole / 2) continue;
      if (onVisible(x + 0.5, y + 0.5) && !nearOther(x + 0.5, y + 0.5)) {
        findings.push({ x, y, gapPx: 0 });
      }
    }
  }
  return findings;
}

function aim(pose: Pose): void {
  const store = useEditorStore;
  if (store.getState().orthographic !== pose.orthographic) {
    store.setState({ orthographic: pose.orthographic });
  }
  viewport().controls.setPose(pose);
  draw();
}

/**
 * How many pixels switching the face orientation overlay on turns red from
 * `pose`, with the wire and the dots off. It is a setting rather than a mark of
 * its own, so the frames come from the store, and it is off again after.
 *
 * Red, not merely changed: with the overlay on the fill draws front faces only,
 * so a contour pixel where it used to draw the far side in grey changes shade
 * without a back face being painted there.
 */
export function orientationInk(pose: Pose): number {
  aim(pose);
  const marks = [...viewport().views.values()].flatMap((view) => [view.wire, view.points]);
  const shown = marks.map((mark) => mark.visible);
  const frame = (faceOrientation: boolean) => {
    useEditorStore.getState().setOverlay({ faceOrientation });
    useEditorStore.getState().touchMesh();
    for (const mark of marks) mark.visible = false;
    return draw();
  };

  const on = frame(true);
  const off = frame(false);
  marks.forEach((mark, index) => (mark.visible = shown[index]));

  let reddened = 0;
  for (let i = 0; i < on.length; i += 4) {
    const redness = (frame: Uint8Array) => frame[i] - Math.max(frame[i + 1], frame[i + 2]);
    if (redness(on) - redness(off) > INK) reddened += 1;
  }
  return reddened;
}

/** Looks at the active object's marks from `pose` and reports any on the wrong side of a surface. */
export function check(pose: Pose): PoseReport {
  const store = useEditorStore;
  aim(pose);
  const view = viewport();

  const marks = view.views.get(store.getState().activeObjectId as string);
  if (!marks) throw new Error('The active object has no view');
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
  const reference = unhidden(marks.wire as THREE.Mesh, [marks.points]);
  const wireSampler = sampler(wire.width, wire.height);
  const edgeSamples: Sample[] = [];
  const { camera } = view;
  for (let i = 0; i < marks.edgePositions.length; i += 6) {
    const a = new THREE.Vector3().fromArray(marks.edgePositions, i).applyMatrix4(toWorld);
    const b = new THREE.Vector3().fromArray(marks.edgePositions, i + 3).applyMatrix4(toWorld);
    const ends = [a.clone().project(camera), b.clone().project(camera)];
    const length = Math.hypot(
      ((ends[1].x - ends[0].x) / 2) * wire.width,
      ((ends[1].y - ends[0].y) / 2) * wire.height,
    );
    const steps = Math.max(2, Math.ceil(length / WIRE_STEP_PX));
    for (let step = 0; step < steps; step += 1) {
      const sample = wireSampler.at(a.clone().lerp(b, (step + 0.5) / steps));
      if (sample) edgeSamples.push(sample);
    }
  }

  return {
    dots: judge(vertSamples, dots.mask, dots.width, dots.height, 3, dotSampler.covered),
    wire: {
      ...judge(edgeSamples, wire.mask, wire.width, wire.height, 2, wireSampler.covered),
      thinned: thinned(edgeSamples, { ...wire, reference }, wire.width, wire.height),
    },
  };
}
