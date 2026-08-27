import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

import { AXIS_COLORS, ObjectView, VIEWPORT_COLORS } from '@bridge/index';
import {
  type PivotTool,
  type SelectMode,
  type Transform,
  type Vec3,
  axisVector,
  centroid,
  faceLoopAtClick,
  inverseTransformDirection,
  inverseTransformPoint,
  medianPoint,
  mulVec,
  pivotPosition,
  rotateVerts,
  scaleVerts,
  selectEdgeLoop,
  translateVerts,
  vec3,
} from '@kernel/index';
import { displayCenter, evaluatedMesh, useEditorStore } from '@store/index';
import type { CursorSnapTargets, SceneObject } from '@store/types';

import { CameraController, MAX_ORBIT_DISTANCE } from './CameraController';
import { ViewportGrid } from './grid';
import { type MarqueeLayer, createMarqueeLayer, drawMarquee, hideMarquee } from './marquee';
import {
  type Marquee,
  type Region,
  marqueeBounds,
  marqueeShape,
  pickElement,
  pickInRegion,
  pickObjectsInRegion,
  regionForShape,
} from './picking';

/** Beyond this multiple of the max zoom, the scene reads as empty rather than distant. */
const VIEW_LOST_DISTANCE = MAX_ORBIT_DISTANCE * 0.45;

/** Minimum gap between recorded lasso points, in pixels. */
const LASSO_POINT_SPACING = 6;

/** How long freshly created vertices stay flagged in the viewport. */
const RECENT_VERTS_MS = 1600;

/** Screen radius of the 3D cursor's ring, in pixels. It holds this at any zoom. */
const CURSOR_RADIUS_PX = 9;

/**
 * Softens a scale drag that starts close to the pivot.
 *
 * The factor is a ratio of two pointer distances, so a drag begun a few pixels
 * out would multiply the object by tens on the very next move. Added to both
 * ends it keeps the response continuous and still exactly 1 at the start.
 */
const SCALE_REFERENCE_PX = 60;

/** What a single scale drag is allowed to multiply by, in either direction. */
const MIN_SCALE_RATIO = 0.01;
const MAX_SCALE_RATIO = 100;

/** What one wheel notch multiplies the proportional falloff radius by. */
const PROPORTIONAL_WHEEL_STEP = 1.1;
const MIN_PROPORTIONAL_RADIUS = 0.01;
const MAX_PROPORTIONAL_RADIUS = 1000;

/** How much of the shorter viewport side the ring may reach across when it appears, as a radius. */
const PROPORTIONAL_MAX_SPAN = 0.45;
/** How small the ring may appear at before it is grown enough to be seen. */
const PROPORTIONAL_MIN_PX = 32;

/**
 * The factor a scale drag has reached, from pointer distances **on screen**.
 *
 * Measuring on screen rather than in the scene is what makes a scale drag feel
 * the same at every zoom. Three's own ratio comes off the drag plane in world
 * units, so zoomed out — where a few pixels cover metres — the object jumps
 * between far too small and far too big, and it negates itself the moment the
 * pointer crosses the pivot (`pointEnd.dot(pointStart) < 0`), mirroring the
 * model inside out. Pixels have neither problem: the distance never collapses
 * with zoom and cannot go negative.
 */
export function gizmoScaleRatio(pointerPx: number, referencePx: number): number {
  const ratio = (pointerPx + SCALE_REFERENCE_PX) / (Math.max(referencePx, 0) + SCALE_REFERENCE_PX);
  if (!Number.isFinite(ratio) || ratio <= 0) return MIN_SCALE_RATIO;
  return Math.min(MAX_SCALE_RATIO, Math.max(MIN_SCALE_RATIO, ratio));
}

/**
 * The falloff radius one wheel notch lands on.
 *
 * Multiplicative, so a notch changes the ring by the same proportion whether it
 * is covering a millimetre or half the scene — and rounded to the three decimals
 * the radius field shows, so the panel and the ring never disagree about the
 * number the wheel just landed on.
 */
export function proportionalRadiusStep(radius: number, deltaY: number): number {
  const factor = deltaY < 0 ? PROPORTIONAL_WHEEL_STEP : 1 / PROPORTIONAL_WHEEL_STEP;
  const next = THREE.MathUtils.clamp(
    radius * factor,
    MIN_PROPORTIONAL_RADIUS,
    MAX_PROPORTIONAL_RADIUS,
  );
  return Number(next.toFixed(3));
}

/**
 * The falloff radius the ring appears at.
 *
 * The ring is the only thing saying how far the falloff reaches, so coming up
 * at a radius left over from another zoom — wider than the canvas, or a
 * sub-pixel dot — starts the edit blind. `radiusPerPixel` is how much radius
 * one screen pixel is worth at the ring's centre, `span` the shorter viewport
 * side.
 *
 * Fitted the once, as it appears. After that the radius is the user's: a zoom
 * or an orbit is a look at the model, not an instruction to resize the falloff.
 */
export function fitProportionalRadius(
  radius: number,
  radiusPerPixel: number,
  span: number,
): number {
  if (!(radiusPerPixel > 0) || !(span > 0)) return radius;

  const max = span * PROPORTIONAL_MAX_SPAN * radiusPerPixel;
  const min = Math.min(PROPORTIONAL_MIN_PX * radiusPerPixel, max);
  const fitted = THREE.MathUtils.clamp(radius, min, max);
  if (fitted === radius) return radius;

  return Number(
    THREE.MathUtils.clamp(fitted, MIN_PROPORTIONAL_RADIUS, MAX_PROPORTIONAL_RADIUS).toFixed(3),
  );
}

/**
 * An angle difference brought into (-pi, pi].
 *
 * Bearings come out of `atan2` wrapped, so the step across the wrap point
 * reads as almost a full turn backwards unless it is folded like this.
 */
export function shortestAngle(delta: number): number {
  const wrapped = (((delta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return wrapped - Math.PI;
}

interface GizmoBaseline {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

/**
 * Three.js owns everything in here: the renderer, camera, gizmo, picking and
 * overlays. It is created once against a canvas ref and never re-rendered by
 * React; it reads the store through `subscribeWithSelector` and pushes
 * selection changes back through store actions.
 */
export class Viewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private perspectiveCamera: THREE.PerspectiveCamera;
  private orthographicCamera: THREE.OrthographicCamera;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;

  private readonly controls: CameraController;
  private readonly gizmo: TransformControls;
  private readonly gizmoHelper: THREE.Object3D;
  private readonly gizmoProxy = new THREE.Object3D();
  private readonly grid = new ViewportGrid();
  private readonly cursor: THREE.Object3D;
  /** Blender's dashed line: pivot to pointer, drawn only during a modal scale or rotate. */
  private readonly modalLine: THREE.Line;
  /** Blender's proportional-edit circle: how far the falloff reaches from the selection. */
  private readonly proportionalRing: THREE.LineLoop;
  /** World-space centre of that circle, refreshed whenever the selection moves. */
  private proportionalAnchor: THREE.Vector3 | null = null;
  /** Object-to-world scale for the radius, which is an object-space distance. */
  private proportionalScale = 1;
  /** Whether the falloff ring was drawn last frame; a first showing is fitted to the view. */
  private proportionalShown = false;
  private pointerPixels = new THREE.Vector2();
  /** Where the camera stood when the selection outlines were last traced. */
  private readonly outlineEye = new THREE.Vector3(Number.NaN, 0, 0);
  /** Canvas size in CSS pixels; the outline material sizes its line against it. */
  private readonly outlineResolution = new THREE.Vector2(1, 1);
  private scaleDrag: {
    pivot: THREE.Vector3;
    pivotPixels: THREE.Vector2;
    /** Pointer distance from the pivot when the drag started, in pixels. */
    reference: number;
    /** Which axes are being scaled: 'X', 'XY', 'XYZ', … */
    axis: string;
    /** Per axis, the factor already applied — edit mode scales by the step. */
    applied: Vec3;
    /** Set for a keyboard-started scale, which can be cancelled; null for a handle drag. */
    modal: { restore: () => void; seeded: boolean } | null;
  } | null = null;
  /**
   * A rotation running off the bare pointer, the way Blender's R does.
   *
   * Kept beside `scaleDrag` rather than folded into it: the two read the
   * pointer differently — a scale off its distance from the pivot, a rotation
   * off its bearing around it — and merging them would put a branch in every
   * line of the most delicate code here.
   */
  private rotateDrag: {
    pivot: THREE.Vector3;
    pivotPixels: THREE.Vector2;
    /** Pointer bearing last seen, so a turn past half a circle still reads as one step. */
    bearing: number;
    /** Total angle turned so far. Object mode re-applies it whole, never compounding. */
    applied: number;
    /** World axis the turn is pinned to, or null for the axis facing the camera. */
    axis: 'x' | 'y' | 'z' | null;
    modal: { restore: () => void; seeded: boolean } | null;
  } | null = null;

  private readonly raycaster = new THREE.Raycaster();

  private readonly views = new Map<string, ObjectView>();
  /**
   * Where each object's displayed mesh is centred in the world, cached from the
   * last scene sync so seating the gizmo does not re-run the modifier stack.
   */
  private readonly displayCenters = new Map<string, Vec3>();
  private readonly unsubscribers: (() => void)[] = [];
  private frameHandle = 0;
  private disposed = false;

  private dragStart: THREE.Vector2 | null = null;
  private dragCurrent: THREE.Vector2 | null = null;
  /** Every point a lasso drag has passed through, in canvas pixels. */
  private dragPath: THREE.Vector2[] = [];
  /** The overlay's SVG shapes, built on first use. */
  private shapeLayer: MarqueeLayer | null = null;
  private gizmoBaseline: GizmoBaseline | null = null;
  /** Ids of the selected, unlocked objects a group gizmo drag in object mode applies to. */
  private transformGroup: string[] = [];
  private readonly objectBaselines = new Map<string, Transform>();
  private gizmoDragging = false;
  private viewLostReported = false;
  /** Last cursor written to the canvas; the render loop would otherwise set it every frame. */
  private appliedCursor = '';
  private recentVerts: { objectId: string; ids: Set<number>; expiresAt: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly overlay: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(VIEWPORT_COLORS.ash);

    const { clientWidth, clientHeight } = canvas;
    const aspect = clientHeight > 0 ? clientWidth / clientHeight : 1;

    this.perspectiveCamera = new THREE.PerspectiveCamera(50, aspect, 0.05, 2000);
    this.orthographicCamera = new THREE.OrthographicCamera(-5 * aspect, 5 * aspect, 5, -5, -1000, 2000);
    this.camera = this.perspectiveCamera;

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(4, 8, 6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffe7d0, 0.5);
    fill.position.set(-6, 2, -4);
    this.scene.add(fill);

    this.scene.add(this.grid.group);
    this.cursor = this.createCursor();
    this.scene.add(this.cursor);
    this.modalLine = this.createScaleLine();
    this.scene.add(this.modalLine);
    this.proportionalRing = this.createProportionalRing();
    this.scene.add(this.proportionalRing);
    this.scene.add(this.gizmoProxy);

    this.controls = new CameraController(this.camera, canvas);
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmoHelper = resolveGizmoHelper(this.gizmo);
    paintGizmoAxes(this.gizmoHelper, this.gizmo);
    trimGizmoGuides(this.gizmoHelper, this.gizmo);
    this.scene.add(this.gizmoHelper);
    this.gizmo.enabled = false;
    this.gizmoHelper.visible = false;

    this.bindEvents();
    this.subscribeToStore();
    this.syncScene();
    this.resize();
    this.renderLoop();
  }

  // ------------------------------------------------------------------ setup

  /**
   * The 3D cursor, built the way Blender draws its own: a ring of alternating
   * red and white dashes with four crosshair ticks just outside it. The two
   * colours are what keep it legible over both the dark background and a lit
   * surface, and the empty middle is what lets you see the point it marks.
   *
   * Unit radius; `updateCursor` scales it to a fixed pixel size every frame.
   */
  private createCursor(): THREE.Object3D {
    const dashes = 8;
    const stepsPerDash = 5;
    const arc = Math.PI / dashes;
    const red: number[] = [];
    const bone: number[] = [];

    for (let dash = 0; dash < dashes * 2; dash += 1) {
      const points = dash % 2 === 0 ? red : bone;
      for (let step = 0; step < stepsPerDash; step += 1) {
        const from = (dash + step / stepsPerDash) * arc;
        const to = (dash + (step + 1) / stepsPerDash) * arc;
        points.push(Math.cos(from), Math.sin(from), 0, Math.cos(to), Math.sin(to), 0);
      }
    }

    const inner = 1.5;
    const middle = 2.05;
    const outer = 2.7;
    for (const [x, y] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      red.push(x * inner, y * inner, 0, x * middle, y * middle, 0);
      bone.push(x * middle, y * middle, 0, x * outer, y * outer, 0);
    }

    const group = new THREE.Group();
    for (const [color, points] of [
      [VIEWPORT_COLORS.red, red],
      [VIEWPORT_COLORS.bone, bone],
    ] as const) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      const lines = new THREE.LineSegments(
        geometry,
        // Slightly translucent, so the cursor reads as an overlay over whatever
        // it is sitting on rather than as an object in the scene.
        new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 }),
      );
      // Depth testing is off, so the cursor is only reliably on top if it also
      // draws after the geometry: renderOrder has to sit on the lines
      // themselves, since a group's is never inherited by its children.
      lines.renderOrder = 10;
      group.add(lines);
    }

    group.renderOrder = 10;
    return group;
  }

  /**
   * Keeps the cursor facing the camera at a constant size on screen.
   *
   * A fixed world size is a speck when zoomed out and swallows the model when
   * zoomed in — the cursor is a screen-space marker, not a piece of the scene,
   * so it is billboarded and rescaled per frame like Blender's.
   */
  private updateCursor(): void {
    if (!this.cursor.visible) return;

    const worldPerPixel = this.worldPerPixel(this.cursor.position);
    if (worldPerPixel === 0) return;

    this.cursor.quaternion.copy(this.camera.quaternion);
    this.cursor.scale.setScalar(CURSOR_RADIUS_PX * worldPerPixel);
  }

  /**
   * What one screen pixel covers in world units at a point.
   *
   * Every billboarded overlay — the cursor, the falloff ring — is sized through
   * this, so they all answer to the same zoom. Zero when the canvas has no
   * height and there is nothing to measure against.
   */
  private worldPerPixel(point: THREE.Vector3): number {
    const height = this.canvas.clientHeight;
    if (height === 0) return 0;

    if (this.camera instanceof THREE.OrthographicCamera) {
      return (this.camera.top - this.camera.bottom) / height;
    }

    return (
      (2 *
        Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) *
        this.camera.position.distanceTo(point)) /
      height
    );
  }

  /**
   * The line a scale drag hangs off, from the pivot out to the pointer.
   *
   * Dashes are re-sized to the line's own length every frame: at a fixed world
   * size they would collapse into one long dash zoomed out, and into a blur
   * zoomed in.
   */
  private createScaleLine(): THREE.Line {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));

    const line = new THREE.Line(
      geometry,
      new THREE.LineDashedMaterial({
        color: VIEWPORT_COLORS.bone,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      }),
    );
    line.visible = false;
    line.renderOrder = 11;
    line.frustumCulled = false;
    return line;
  }

  /**
   * The circle marking how far proportional editing reaches.
   *
   * Unit radius, in the XY plane; `updateProportionalRing` turns it to face the
   * camera and scales it to the falloff radius every frame.
   */
  private createProportionalRing(): THREE.LineLoop {
    const segments = 96;
    const points: number[] = [];
    for (let step = 0; step < segments; step += 1) {
      const angle = (step / segments) * Math.PI * 2;
      points.push(Math.cos(angle), Math.sin(angle), 0);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));

    const ring = new THREE.LineLoop(
      geometry,
      new THREE.LineBasicMaterial({
        color: VIEWPORT_COLORS.bone,
        depthTest: false,
        transparent: true,
        opacity: 0.7,
      }),
    );
    ring.visible = false;
    ring.renderOrder = 11;
    ring.frustumCulled = false;
    return ring;
  }

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.handleContextMenu);
    this.canvas.addEventListener('lostpointercapture', this.handleLostPointerCapture);

    this.gizmo.addEventListener('dragging-changed', this.handleGizmoDragging);
    this.gizmo.addEventListener('objectChange', this.handleGizmoChange);
  }

  private subscribeToStore(): void {
    const store = useEditorStore;

    this.unsubscribers.push(
      store.subscribe(
        (state) => state.meshVersion,
        () => this.syncScene(),
      ),
      store.subscribe(
        (state) => [state.mode, state.activeObjectId, state.selectedObjectIds] as const,
        () => this.syncScene(),
        { equalityFn: shallowArrayEqual },
      ),
      store.subscribe(
        (state) =>
          [
            state.shading,
            state.backfaceCulling,
            state.overlays.normals,
            state.overlays.faceOrientation,
          ] as const,
        () => this.syncScene(),
        { equalityFn: shallowArrayEqual },
      ),
      store.subscribe(
        (state) => [state.selectionLineWidth, state.selectionLineColor] as const,
        () => this.syncScene(),
        { equalityFn: shallowArrayEqual },
      ),
      store.subscribe(
        (state) => state.viewportBackground,
        (color) => (this.scene.background as THREE.Color).set(color),
        { fireImmediately: true },
      ),
      store.subscribe(
        (state) => [state.overlays.grid, state.overlays.axes] as const,
        ([grid, axes]) => this.grid.setVisibility(grid, axes),
        { equalityFn: shallowArrayEqual, fireImmediately: true },
      ),
      store.subscribe(
        (state) =>
          [
            state.gridScale,
            state.gridSubdivisions,
            state.gridColor,
            state.gridOpacity,
            state.gridMajorColor,
            state.gridMajorOpacity,
          ] as const,
        ([scale, subdivisions, color, opacity, majorColor, majorOpacity]) =>
          this.grid.setGrid({ scale, subdivisions, color, opacity, majorColor, majorOpacity }),
        { equalityFn: shallowArrayEqual, fireImmediately: true },
      ),
      store.subscribe(
        (state) => state.overlays.cursor,
        (visible) => {
          this.cursor.visible = visible;
        },
        { fireImmediately: true },
      ),
      // The pivot decides where the gizmo sits, so moving the cursor has to
      // re-seat it — but only while the cursor is what it is anchored to.
      store.subscribe(
        (state) => state.pivot,
        () => this.updateGizmo(),
      ),
      store.subscribe(
        (state) => state.cursor,
        (cursor) => {
          this.cursor.position.set(cursor.x, cursor.y, cursor.z);
          // A mirror anchored to the cursor changes shape when it moves, so the
          // whole scene is rebuilt rather than just the crosshair.
          this.syncScene();
        },
        { fireImmediately: true },
      ),
      store.subscribe(
        (state) => state.navigation,
        (preset) => {
          this.controls.preset = preset;
        },
        { fireImmediately: true },
      ),
      store.subscribe(
        (state) =>
          [state.orthographic, state.focalLength, state.clipStart, state.clipEnd] as const,
        () => this.applyCameraSettings(),
        { equalityFn: shallowArrayEqual, fireImmediately: true },
      ),
      store.subscribe(
        (state) => state.activeTool,
        () => this.updateGizmo(),
      ),
      store.subscribe(
        (state) => state.modal,
        (modal) => {
          if (modal?.kind === 'scale') this.beginModalScale();
          else if (modal?.kind === 'rotate') this.beginModalRotate();
          // Cleared from somewhere else — a mode change, a reset — while a
          // modal scale is still live: put everything back.
          else if (!modal && this.scaleDrag?.modal) this.finishModalScale(true);
          else if (!modal && this.rotateDrag?.modal) this.finishModalRotate(true);
        },
      ),
      // An operator reporting new vertices flags them for a moment. The expiry
      // is checked in the render loop rather than by a timer, so the flash
      // cannot outlive the viewport or fire after it is disposed.
      store.subscribe(
        (state) => state.recentVerts,
        (recent) => {
          this.recentVerts = recent
            ? {
                objectId: recent.objectId,
                ids: new Set(recent.vertIds),
                expiresAt: performance.now() + RECENT_VERTS_MS,
              }
            : null;
          this.syncScene();
        },
      ),
      // Locking is neither a geometry nor a selection change, so none of the
      // subscriptions above would re-run — yet a locked object has to lose its
      // gizmo, since dragging it is refused anyway.
      store.subscribe(
        (state) => state.objects.map((object) => object.locked),
        () => this.updateGizmo(),
        { equalityFn: shallowArrayEqual },
      ),
      store.subscribe(
        (state) => state.frameRequest,
        (request) => {
          if (request) this.frame(request.target);
        },
      ),
      store.subscribe(
        (state) => state.axisViewRequest,
        (request) => {
          if (request) this.controls.setAxisView(request.axis, request.negative);
        },
      ),
    );
  }

  // ------------------------------------------------------------ scene sync

  /** Rebuilds every object's GPU buffers from the kernel meshes. */
  syncScene(): void {
    const state = useEditorStore.getState();
    const settings = {
      shading: state.shading,
      overlays: state.overlays,
      backfaceCulling: state.backfaceCulling,
      orthographic: state.orthographic,
      focalLength: state.focalLength,
      clipStart: state.clipStart,
      clipEnd: state.clipEnd,
      navigation: state.navigation,
    };

    const alive = new Set<string>();
    for (const object of state.objects) {
      alive.add(object.id);
      let view = this.views.get(object.id);
      if (!view) {
        view = new ObjectView(object.id);
        view.setResolution(this.outlineResolution.x, this.outlineResolution.y);
        this.views.set(object.id, view);
        this.scene.add(view.group);
      }

      const display = evaluatedMesh(object, state.cursor);
      view.update(object, display, {
        mode: state.mode,
        selectMode: state.selectMode,
        recentVerts: this.recentVerts?.objectId === object.id ? this.recentVerts.ids : undefined,
        isActive: object.id === state.activeObjectId,
        isSelected: state.selectedObjectIds.includes(object.id),
        eye: vec3(this.camera.position.x, this.camera.position.y, this.camera.position.z),
        selectionLine: { color: state.selectionLineColor, width: state.selectionLineWidth },
        settings,
      });

      this.displayCenters.set(object.id, displayCenter(object, display));
    }

    for (const [id, view] of this.views) {
      if (alive.has(id)) continue;
      view.dispose();
      this.views.delete(id);
      this.displayCenters.delete(id);
    }

    this.updateProportionalAnchor(state);
    this.updateGizmo();
  }

  /**
   * Re-centres the proportional falloff ring on the selection.
   *
   * The median rather than the transform pivot: influence is measured from
   * whichever selected vertex is nearest, so a ring drawn around the 3D cursor
   * sitting off to one side would describe an area nothing falls off from.
   *
   * The radius is an object-space distance, so the ring carries the object's
   * own scale. Under a non-uniform one the true reach is an ellipsoid and the
   * circle can only average it — as Blender's does.
   */
  private updateProportionalAnchor(state: ReturnType<typeof useEditorStore.getState>): void {
    this.proportionalAnchor = null;
    if (state.mode !== 'edit') return;

    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    if (!object) return;

    const selected = object.mesh.selectedVerts();
    if (selected.length === 0) return;

    const median = medianPoint(selected);
    this.proportionalAnchor = new THREE.Vector3(median.x, median.y, median.z).applyMatrix4(
      this.views.get(object.id)?.group.matrix ?? new THREE.Matrix4(),
    );

    const { scale } = object.transform;
    this.proportionalScale = (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3;
  }

  /**
   * Faces the falloff ring at the camera and sizes it to the current radius.
   *
   * Billboarded like the 3D cursor: the falloff is a sphere, and a circle only
   * reads as its silhouette while it faces the viewer.
   */
  private updateProportionalRing(): void {
    const state = useEditorStore.getState();
    const anchor = this.proportionalAnchor;
    const visible =
      anchor !== null &&
      state.proportional.enabled &&
      state.proportional.radius * this.proportionalScale > 0;

    this.proportionalRing.visible = visible;
    if (!visible || !anchor) {
      this.proportionalShown = false;
      return;
    }

    let radius = state.proportional.radius;
    if (!this.proportionalShown) {
      this.proportionalShown = true;
      radius = this.fitRadiusToView(radius);
      if (radius !== state.proportional.radius) state.setProportional({ radius });
    }

    this.proportionalRing.position.copy(anchor);
    this.proportionalRing.quaternion.copy(this.camera.quaternion);
    this.proportionalRing.scale.setScalar(radius * this.proportionalScale);
  }

  /**
   * The falloff radius fitted to what the viewport can show.
   *
   * The radius is a stored setting rather than a display one — the ring has to
   * describe the reach the transform will really use — so the fit has to be
   * written back to it, not drawn as a circle narrower than the falloff.
   */
  private fitRadiusToView(radius: number): number {
    const anchor = this.proportionalAnchor;
    if (!anchor || this.proportionalScale === 0) return radius;

    const worldPerPixel = this.worldPerPixel(anchor);
    if (worldPerPixel === 0) return radius;

    return fitProportionalRadius(
      radius,
      worldPerPixel / this.proportionalScale,
      Math.min(this.canvas.clientWidth, this.canvas.clientHeight),
    );
  }

  /** Drops the just-created-vertex flash once its moment has passed. */
  private expireRecentVerts(): void {
    if (!this.recentVerts || performance.now() < this.recentVerts.expiresAt) return;
    this.recentVerts = null;
    useEditorStore.getState().clearRecentVerts();
    this.syncScene();
  }

  private applyCameraSettings(): void {
    const state = useEditorStore.getState();
    const aspect = this.canvas.clientHeight > 0 ? this.canvas.clientWidth / this.canvas.clientHeight : 1;

    this.perspectiveCamera.fov = focalLengthToFov(state.focalLength);
    this.perspectiveCamera.near = state.clipStart;
    this.perspectiveCamera.far = state.clipEnd;
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();

    this.orthographicCamera.near = -state.clipEnd;
    this.orthographicCamera.far = state.clipEnd;
    this.orthographicCamera.updateProjectionMatrix();

    const next = state.orthographic ? this.orthographicCamera : this.perspectiveCamera;
    if (next !== this.camera) {
      this.camera = next;
      this.controls.setCamera(next);
      this.gizmo.camera = next;
    }
  }

  // -------------------------------------------------------------- gizmo

  /**
   * Re-seats the gizmo on the current selection.
   *
   * Never mid-drag: from pointer-down to pointer-up the proxy belongs to
   * TransformControls, which drives it as `transform-at-drag-start + total
   * pointer offset`. `syncScene()` calls this on every store change — including
   * the ones a drag itself emits — so re-seating the proxy here would reset the
   * baseline each tick and turn every absolute drag delta into a corrupted
   * incremental one, leaving the dragged objects stuttering between two
   * positions instead of following the pointer.
   */
  private updateGizmo(): void {
    if (this.gizmoDragging) return;

    const state = useEditorStore.getState();
    const modeMap = { move: 'translate', rotate: 'rotate', scale: 'scale' } as const;
    const gizmoMode = modeMap[state.activeTool as keyof typeof modeMap];

    if (!gizmoMode) {
      this.detachGizmo();
      return;
    }

    if (state.mode === 'object') {
      this.updateObjectGizmo(state, gizmoMode);
      return;
    }

    this.updateEditGizmo(state, gizmoMode);
  }

  /**
   * Stands the handles down for a scale that draws its own line.
   *
   * Hiding the helper is not enough on its own: three raycasts its picker
   * meshes whether or not they are drawn, so a handle nobody can see would
   * still highlight and still take a drag. Disabling the controls is what puts
   * the whole gizmo out of reach until the scale ends.
   */
  private standDownGizmo(): void {
    this.gizmo.enabled = false;
    this.gizmoHelper.visible = false;
  }

  private detachGizmo(): void {
    this.gizmo.detach();
    this.gizmo.enabled = false;
    this.gizmoHelper.visible = false;
    this.transformGroup = [];
  }

  /**
   * World-space anchor for one object's gizmo: the centre of the mesh actually
   * on screen, not the object origin.
   *
   * A modifier that pushes geometry away from the origin — an array most
   * obviously — takes the gizmo with it, so the handles sit on what the user
   * sees rather than off beside the first copy.
   */
  private objectGizmoAnchor(object: SceneObject): Vec3 {
    return this.displayCenters.get(object.id) ?? object.transform.position;
  }

  /**
   * Positions the gizmo for object mode.
   *
   * With one object selected it sits at that object's displayed centre,
   * oriented to the object. With several selected it sits at the median of
   * those centres with a neutral (world-aligned) orientation, and the
   * resulting drag is applied to every one of them — Blender's median-point,
   * global pivot default for multi-object transforms.
   *
   * The anchor doubles as the transform pivot, so a rotate or scale drag
   * orbits the displayed centre. That point is fixed in the object's own
   * frame, which is what keeps the gizmo from creeping across a drag.
   */
  private updateObjectGizmo(state: ReturnType<typeof useEditorStore.getState>, gizmoMode: 'translate' | 'rotate' | 'scale'): void {
    const selected = state.objects.filter((object) => state.selectedObjectIds.includes(object.id));
    const transformable = selected.filter((object) => !object.locked);

    if (transformable.length === 0) {
      this.detachGizmo();
      return;
    }

    this.gizmo.setMode(gizmoMode);
    this.gizmo.enabled = !this.modalLine.visible;
    this.gizmoHelper.visible = !this.modalLine.visible;
    this.transformGroup = transformable.map((object) => object.id);

    if (state.pivot === 'cursor') {
      // World-aligned on purpose: orbiting a point outside the object around
      // the object's own axes is not what "about the cursor" means.
      const { cursor } = state;
      this.gizmoProxy.position.set(cursor.x, cursor.y, cursor.z);
      this.gizmoProxy.rotation.set(0, 0, 0);
      this.gizmoProxy.scale.set(1, 1, 1);
    } else if (transformable.length === 1) {
      const { rotation, scale } = transformable[0].transform;
      const anchor = this.objectGizmoAnchor(transformable[0]);
      this.gizmoProxy.position.set(anchor.x, anchor.y, anchor.z);
      this.gizmoProxy.rotation.set(rotation.x, rotation.y, rotation.z);
      this.gizmoProxy.scale.set(scale.x, scale.y, scale.z);
    } else {
      const pivot = centroid(transformable.map((object) => this.objectGizmoAnchor(object)));
      this.gizmoProxy.position.set(pivot.x, pivot.y, pivot.z);
      this.gizmoProxy.rotation.set(0, 0, 0);
      this.gizmoProxy.scale.set(1, 1, 1);
    }

    this.captureGizmoBaseline();
    this.gizmo.attach(this.gizmoProxy);
  }

  /** In edit mode the gizmo drives the selection's median point on the one active object. */
  private updateEditGizmo(state: ReturnType<typeof useEditorStore.getState>, gizmoMode: 'translate' | 'rotate' | 'scale'): void {
    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    if (!object || object.locked) {
      this.detachGizmo();
      return;
    }

    const selected = object.mesh.selectedVerts();
    if (selected.length === 0) {
      this.detachGizmo();
      return;
    }

    this.gizmo.setMode(gizmoMode);
    this.gizmo.enabled = !this.modalLine.visible;
    this.gizmoHelper.visible = !this.modalLine.visible;
    this.transformGroup = [];

    const median = medianPoint(selected);
    const anchor =
      state.pivot === 'cursor'
        ? new THREE.Vector3(state.cursor.x, state.cursor.y, state.cursor.z)
        : new THREE.Vector3(median.x, median.y, median.z).applyMatrix4(
            this.views.get(object.id)?.group.matrix ?? new THREE.Matrix4(),
          );
    this.gizmoProxy.position.copy(anchor);
    this.gizmoProxy.rotation.set(0, 0, 0);
    this.gizmoProxy.scale.set(1, 1, 1);

    this.captureGizmoBaseline();
    this.gizmo.attach(this.gizmoProxy);
  }

  private captureGizmoBaseline(): void {
    this.gizmoBaseline = {
      position: this.gizmoProxy.position.clone(),
      quaternion: this.gizmoProxy.quaternion.clone(),
      scale: this.gizmoProxy.scale.clone(),
    };
  }

  private handleGizmoDragging = (event: { value: unknown }): void => {
    const dragging = event.value === true;
    this.gizmoDragging = dragging;
    const state = useEditorStore.getState();

    if (dragging) {
      this.captureGizmoBaseline();
      this.objectBaselines.clear();
      for (const object of state.objects) {
        if (!this.transformGroup.includes(object.id)) continue;
        this.objectBaselines.set(object.id, structuredClone(object.transform));
      }
      const tool = state.activeTool === 'select' ? 'move' : state.activeTool;
      state.recordHistory(
        state.mode === 'object' ? 'Transform object' : `${tool} selection`.toUpperCase(),
      );
      // Vertices are about to move, which takes the mesh away from what the
      // primitive's parameters describe: left live, a later tweak of one would
      // regenerate the shape straight over this edit. Cleared once here rather
      // than on every drag tick — moving the object itself changes nothing
      // about the mesh, so object mode keeps its parameters.
      if (state.mode === 'edit') {
        state.patchActiveObject({ primitive: null }, { touchGeometry: false });
      }
      if (state.activeTool === 'scale') this.beginScaleDrag();
      return;
    }

    this.endScaleDrag();

    // `gizmoDragging` is already false, so this resync is the one that re-seats
    // the gizmo on where the selection actually landed.
    state.touchMesh();
  };

  /** Where a world point lands on the canvas, in the same pixels as the pointer. */
  private projectToPixels(point: THREE.Vector3): THREE.Vector2 {
    const ndc = point.clone().project(this.camera);
    return new THREE.Vector2(
      ((ndc.x + 1) / 2) * this.canvas.clientWidth,
      ((1 - ndc.y) / 2) * this.canvas.clientHeight,
    );
  }

  private beginScaleDrag(): void {
    // Whichever handle was grabbed decides which axes the one factor lands on:
    // the centre handle reports 'XYZ', a plane handle 'XY', and so on.
    this.startScaleDrag(this.gizmo.axis ?? 'XYZ', null);
  }

  private startScaleDrag(
    axis: string,
    modal: { restore: () => void; seeded: boolean } | null,
  ): void {
    const pivotPixels = this.projectToPixels(this.gizmoProxy.position);
    this.scaleDrag = {
      pivot: this.gizmoProxy.position.clone(),
      pivotPixels,
      reference: this.pointerPixels.distanceTo(pivotPixels),
      axis,
      applied: vec3(1, 1, 1),
      modal,
    };

    // The line belongs to a scale that has no direction of its own — the
    // keyboard's, or the centre handle's. Along a single axis or in a plane the
    // handle already shows where the drag is going, and a line out to the
    // pointer only crosses the model.
    this.modalLine.visible = modal !== null || axis === 'XYZ';

    // With the line up the handles say nothing the line does not, and they sit
    // over the very geometry being scaled. They come back through updateGizmo
    // when the scale ends.
    if (this.modalLine.visible) this.standDownGizmo();

    this.updateModalLine();
  }

  private endScaleDrag(): void {
    this.scaleDrag = null;
    this.modalLine.visible = false;
  }

  /**
   * Starts a scale that runs off the bare pointer, the way Blender's S does.
   *
   * No button is held, so it ends on a click, Enter or Escape instead of on
   * pointerup — and because it can be cancelled, it captures how to put
   * everything back before it touches anything.
   */
  /** Pointer bearing around a screen point, counter-clockwise from the +X axis. */
  private pointerBearing(origin: THREE.Vector2): number {
    // Canvas y grows downward, so it is negated here: that puts the bearing in
    // the same handedness as a turn about an axis pointing out of the screen,
    // and a counter-clockwise drag then reads as a positive angle.
    return Math.atan2(-(this.pointerPixels.y - origin.y), this.pointerPixels.x - origin.x);
  }

  /**
   * The axis a free rotation turns about: the one pointing back at the camera.
   *
   * Blender's R with no constraint spins the object in the plane of the screen,
   * which is a turn about the view normal — not about any world axis.
   */
  private viewAxis(): Vec3 {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.negate();
    return vec3(forward.x, forward.y, forward.z);
  }

  private startRotateDrag(modal: { restore: () => void; seeded: boolean }): void {
    const pivotPixels = this.projectToPixels(this.gizmoProxy.position);
    this.rotateDrag = {
      pivot: this.gizmoProxy.position.clone(),
      pivotPixels,
      bearing: this.pointerBearing(pivotPixels),
      applied: 0,
      axis: null,
      modal,
    };

    this.modalLine.visible = true;
    // With the line up the handles say nothing it does not, and they sit over
    // the very geometry being turned. `updateGizmo` brings them back at the end.
    this.standDownGizmo();
    this.updateModalLine();
  }

  private endRotateDrag(): void {
    this.rotateDrag = null;
    this.modalLine.visible = false;
  }

  /**
   * Starts a rotation that runs off the bare pointer, the way Blender's R does.
   *
   * The same shape as `beginModalScale`: no button is held, so it ends on a
   * click, Enter or Escape, and the history entry goes in before anything moves
   * so a cancel can put everything back before it has touched anything.
   */
  private beginModalRotate(): void {
    if (this.rotateDrag || this.scaleDrag) return;

    const state = useEditorStore.getState();
    const editing = state.mode === 'edit';
    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    const selected = editing && object ? object.mesh.selectedVerts() : [];

    if (editing ? selected.length === 0 : this.transformGroup.length === 0) {
      state.endModal();
      return;
    }

    state.recordHistory(editing ? 'ROTATE selection' : 'Transform object');
    if (editing) state.patchActiveObject({ primitive: null }, { touchGeometry: false });

    this.captureGizmoBaseline();
    this.objectBaselines.clear();
    for (const candidate of state.objects) {
      if (!this.transformGroup.includes(candidate.id)) continue;
      this.objectBaselines.set(candidate.id, structuredClone(candidate.transform));
    }

    const restorePoints = selected.map((vert) => ({ vert, co: { ...vert.co } }));
    const restore = editing
      ? () => {
          for (const point of restorePoints) point.vert.co = point.co;
          object?.mesh.computeNormals();
          useEditorStore.getState().touchMesh();
        }
      : () => {
          useEditorStore
            .getState()
            .setObjectTransforms(
              [...this.objectBaselines].map(([id, transform]) => ({ id, transform })),
            );
        };

    this.startRotateDrag({ restore, seeded: false });
    window.addEventListener('keydown', this.handleModalKey, true);
    window.addEventListener('pointerdown', this.handleModalPointer, true);
    window.addEventListener('contextmenu', this.handleModalContextMenu, true);
  }

  private finishModalRotate(cancelled: boolean): void {
    const drag = this.rotateDrag;
    if (!drag?.modal) return;

    window.removeEventListener('keydown', this.handleModalKey, true);
    window.removeEventListener('pointerdown', this.handleModalPointer, true);
    window.removeEventListener('contextmenu', this.handleModalContextMenu, true);

    const state = useEditorStore.getState();
    if (cancelled) {
      drag.modal.restore();
      // The entry was recorded before anything moved, so with everything back
      // where it was it would undo to the state the scene is already in.
      state.discardHistory();
    }

    this.endRotateDrag();
    state.endModal();
    state.touchMesh();
  }

  /**
   * Turns the selection to wherever the pointer has swung round the pivot.
   *
   * The bearing is tracked step by step rather than measured from the start, so
   * a drag carried past half a circle keeps turning the same way instead of
   * snapping back: `atan2` wraps at π, a running total does not.
   */
  private applyRotateDrag(): void {
    const drag = this.rotateDrag;
    if (!drag) return;

    // A keypress carries no pointer position, so the bearing it started from is
    // only known once the pointer first moves. Seeding it here is what keeps the
    // object from jumping on the first move of a modal rotate.
    if (drag.modal && !drag.modal.seeded) {
      drag.bearing = this.pointerBearing(drag.pivotPixels);
      drag.modal.seeded = true;
      this.updateModalLine();
      return;
    }

    this.updateModalLine();

    const bearing = this.pointerBearing(drag.pivotPixels);
    const step = shortestAngle(bearing - drag.bearing);
    drag.bearing = bearing;
    if (Math.abs(step) < 1e-6) return;

    const previous = drag.applied;
    drag.applied += step;

    const state = useEditorStore.getState();
    state.updateModal({ value: vec3(THREE.MathUtils.radToDeg(drag.applied), 0, 0) });

    const baseline = this.gizmoBaseline;
    if (!baseline) return;

    const axis = drag.axis ? axisVector(drag.axis) : this.viewAxis();
    const turn = (angle: number) =>
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(axis.x, axis.y, axis.z), angle);

    if (state.mode === 'object') {
      // Re-applied whole against the drag-start baseline, so pinning an axis
      // part-way through re-reads the same total turn about the new one rather
      // than stacking it on what the old one had already done.
      this.gizmoProxy.quaternion.copy(turn(drag.applied).multiply(baseline.quaternion));
      this.applyObjectGroupTransform(state);
      return;
    }

    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    if (!object) return;

    // Edit mode has no per-vertex baseline to re-apply against, so it turns by
    // the step since the last move and `applyEditTransform` re-seats the
    // baseline behind it.
    this.gizmoProxy.quaternion.copy(turn(drag.applied - previous).multiply(baseline.quaternion));
    this.applyEditTransform(state, object);
  }

  private beginModalScale(): void {
    if (this.scaleDrag) return;

    const state = useEditorStore.getState();
    const editing = state.mode === 'edit';
    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    const selected = editing && object ? object.mesh.selectedVerts() : [];

    if (editing ? selected.length === 0 : this.transformGroup.length === 0) {
      state.endModal();
      return;
    }

    state.recordHistory(editing ? 'SCALE selection' : 'Transform object');
    if (editing) state.patchActiveObject({ primitive: null }, { touchGeometry: false });

    this.captureGizmoBaseline();
    this.objectBaselines.clear();
    for (const candidate of state.objects) {
      if (!this.transformGroup.includes(candidate.id)) continue;
      this.objectBaselines.set(candidate.id, structuredClone(candidate.transform));
    }

    const restorePoints = selected.map((vert) => ({ vert, co: { ...vert.co } }));
    const restore = editing
      ? () => {
          for (const point of restorePoints) point.vert.co = point.co;
          object?.mesh.computeNormals();
          useEditorStore.getState().touchMesh();
        }
      : () => {
          useEditorStore.getState().setObjectTransforms(
            [...this.objectBaselines].map(([id, transform]) => ({ id, transform })),
          );
        };

    this.startScaleDrag('XYZ', { restore, seeded: false });
    window.addEventListener('keydown', this.handleModalKey, true);
    window.addEventListener('pointerdown', this.handleModalPointer, true);
    window.addEventListener('contextmenu', this.handleModalContextMenu, true);
  }

  private finishModalScale(cancelled: boolean): void {
    const drag = this.scaleDrag;
    if (!drag?.modal) return;

    window.removeEventListener('keydown', this.handleModalKey, true);
    window.removeEventListener('pointerdown', this.handleModalPointer, true);
    window.removeEventListener('contextmenu', this.handleModalContextMenu, true);

    const state = useEditorStore.getState();
    if (cancelled) {
      drag.modal.restore();
      // The entry was recorded before anything moved, so with everything back
      // where it was it would undo to the state the scene is already in.
      state.discardHistory();
    }

    // Cleared before the store is told, so the modal subscription sees nothing
    // left to cancel.
    this.endScaleDrag();
    state.endModal();
    state.touchMesh();
  }

  /** Whichever modal transform is running off the bare pointer, if either is. */
  private activeModal(): 'scale' | 'rotate' | null {
    if (this.scaleDrag?.modal) return 'scale';
    if (this.rotateDrag?.modal) return 'rotate';
    return null;
  }

  private finishModal(cancelled: boolean): void {
    if (this.scaleDrag?.modal) this.finishModalScale(cancelled);
    else if (this.rotateDrag?.modal) this.finishModalRotate(cancelled);
  }

  private handleModalKey = (event: KeyboardEvent): void => {
    const kind = this.activeModal();
    if (!kind) return;

    const key = event.key.toLowerCase();
    if (key !== 'escape' && key !== 'enter' && key !== 'x' && key !== 'y' && key !== 'z') return;

    event.preventDefault();
    event.stopPropagation();

    if (key === 'escape') return this.finishModal(true);
    if (key === 'enter') return this.finishModal(false);

    // Pressing the same axis again lifts the constraint, as it does in Blender.
    if (kind === 'rotate') {
      const rotating = this.rotateDrag;
      if (!rotating) return;
      rotating.axis = rotating.axis === key ? null : (key as 'x' | 'y' | 'z');
      useEditorStore.getState().updateModal({ axis: rotating.axis });
      // Re-read the turn about the axis that just changed. The step is zero at
      // this instant, so nudge the running total back and let it re-apply.
      rotating.applied = 0;
      rotating.bearing = this.pointerBearing(rotating.pivotPixels);
      this.applyRotateDrag();
      return;
    }

    const drag = this.scaleDrag;
    if (!drag) return;
    const axis = key.toUpperCase();
    drag.axis = drag.axis === axis ? 'XYZ' : axis;
    useEditorStore.getState().updateModal({ axis: drag.axis === 'XYZ' ? null : key });
    this.applyScaleDrag();
  };

  private handleModalPointer = (event: PointerEvent): void => {
    if (!this.activeModal()) return;
    event.preventDefault();
    event.stopPropagation();
    this.finishModal(event.button === 2);
  };

  /** Right-click cancels, so the menu it would otherwise open is swallowed. */
  private handleModalContextMenu = (event: Event): void => {
    if (!this.activeModal()) return;
    event.preventDefault();
    event.stopPropagation();
  };

  /**
   * Scales the selection to wherever the pointer has been dragged.
   *
   * Object mode applies the factor against each object's transform at drag
   * start, so the drag never compounds; edit mode has no such baseline to
   * measure against, so it applies the step since the last move instead.
   */
  private applyScaleDrag(): void {
    const drag = this.scaleDrag;
    if (!drag) return;

    // A keypress carries no pointer position, so the distance it started from
    // is only known once the pointer first moves. Seeding it here is what keeps
    // the object from jumping on the first move of a modal scale.
    if (drag.modal && !drag.modal.seeded) {
      drag.reference = this.pointerPixels.distanceTo(drag.pivotPixels);
      drag.modal.seeded = true;
      this.updateModalLine();
      return;
    }

    this.updateModalLine();

    const factor = gizmoScaleRatio(this.pointerPixels.distanceTo(drag.pivotPixels), drag.reference);
    const state = useEditorStore.getState();
    const along = (axis: string) => (drag.axis.includes(axis) ? factor : 1);
    const target = vec3(along('X'), along('Y'), along('Z'));

    if (drag.modal) state.updateModal({ value: target });

    if (state.mode === 'object') {
      this.applyObjectGroupTransform(state, target);
      drag.applied = target;
      return;
    }

    // Edit mode has no baseline to re-apply against, so it scales by the step
    // since the last move. Kept per axis so lifting an axis constraint mid-drag
    // takes the other two back to where they were rather than stranding them.
    const step = vec3(
      target.x / drag.applied.x,
      target.y / drag.applied.y,
      target.z / drag.applied.z,
    );
    if (Math.abs(step.x - 1) + Math.abs(step.y - 1) + Math.abs(step.z - 1) < 1e-6) return;

    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    if (!object) return;

    drag.applied = target;
    this.applyEditTransform(state, object, step);
  }

  /** Redraws the dashed line from the pivot out to the pointer. */
  private updateModalLine(): void {
    const drag = this.scaleDrag ?? this.rotateDrag;
    if (!drag || !this.modalLine.visible) return;

    // Unprojected at the pivot's own depth, so the line lands under the pointer
    // whatever the projection is doing.
    const depth = drag.pivot.clone().project(this.camera).z;
    const pointer = new THREE.Vector3(
      (this.pointerPixels.x / Math.max(this.canvas.clientWidth, 1)) * 2 - 1,
      -(this.pointerPixels.y / Math.max(this.canvas.clientHeight, 1)) * 2 + 1,
      depth,
    ).unproject(this.camera);

    const positions = this.modalLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(0, drag.pivot.x, drag.pivot.y, drag.pivot.z);
    positions.setXYZ(1, pointer.x, pointer.y, pointer.z);
    positions.needsUpdate = true;

    const material = this.modalLine.material as THREE.LineDashedMaterial;
    // Guarded: a zero dash size divides by zero in the dash shader, and the
    // line vanishes the moment the pointer sits on the pivot.
    const length = Math.max(drag.pivot.distanceTo(pointer), 1e-4);
    material.dashSize = length / 30;
    material.gapSize = length / 45;
    this.modalLine.computeLineDistances();
  }

  private handleGizmoChange = (): void => {
    const state = useEditorStore.getState();
    if (!this.gizmoBaseline) return;
    // Scale is driven by the pointer in `applyScaleDrag`, not by three's own
    // world-space ratio.
    if (this.scaleDrag) return;

    if (state.mode === 'object') {
      this.applyObjectGroupTransform(state);
      return;
    }

    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    if (!object) return;

    this.applyEditTransform(state, object);
  };

  /**
   * Applies a gizmo drag to the selected vertices of the object being edited.
   *
   * Rotate and scale turn about wherever the gizmo was seated — the selection's
   * median, or the 3D cursor when that is the pivot — which is why the pivot
   * comes back through the object's own frame rather than being read off the
   * mesh. Move ignores the pivot, because a translation is the same wherever
   * you measure it from.
   */
  private applyEditTransform(
    state: ReturnType<typeof useEditorStore.getState>,
    object: SceneObject,
    scaleStep?: Vec3,
  ): void {
    const baseline = this.gizmoBaseline;
    if (!baseline) return;

    const selected = object.mesh.selectedVerts();
    if (selected.length === 0) return;

    const tool = state.activeTool as PivotTool;
    const worldPivot = vec3(baseline.position.x, baseline.position.y, baseline.position.z);
    const pivot = inverseTransformPoint(object.transform, worldPivot);

    if (tool === 'rotate') {
      const deltaQuaternion = this.gizmoProxy.quaternion
        .clone()
        .multiply(baseline.quaternion.clone().invert());
      const { axis, angle } = quaternionToAxisAngle(deltaQuaternion);
      if (Math.abs(angle) < 1e-6) return;

      rotateVerts(
        object.mesh,
        selected,
        inverseTransformDirection(object.transform, axis),
        angle,
        pivot,
        state.proportional,
      );
      this.captureGizmoBaseline();
      state.touchMesh();
      return;
    }

    if (tool === 'scale') {
      if (!scaleStep) return;

      scaleVerts(object.mesh, selected, scaleStep, pivot, state.proportional);
      state.touchMesh();
      return;
    }

    const delta = this.gizmoProxy.position.clone().sub(baseline.position);
    if (delta.lengthSq() < 1e-12) return;

    // The gizmo drags in world space; the mesh edit is in object space, so undo
    // the object's scale before applying the delta to the vertices.
    const scale = object.transform.scale;
    translateVerts(
      object.mesh,
      selected,
      vec3(delta.x / (scale.x || 1), delta.y / (scale.y || 1), delta.z / (scale.z || 1)),
      state.proportional,
    );
    this.captureGizmoBaseline();
    state.touchMesh();
  }

  /**
   * Applies a group gizmo drag to every object in `transformGroup`.
   *
   * The delta between the gizmo's current transform and its transform at drag
   * start (not the previous tick) is what gets applied, computed against each
   * object's own transform at drag start. That avoids compounding rounding
   * error across many pointer-move ticks in a single drag.
   *
   * The pivot is wherever the gizmo was seated, which is the displayed centre
   * rather than the object origin — so an arrayed object rotates about the
   * middle of the array, and each object's origin is carried around that point
   * rather than staying put.
   */
  private applyObjectGroupTransform(
    state: ReturnType<typeof useEditorStore.getState>,
    scaleRatio: Vec3 = vec3(1, 1, 1),
  ): void {
    if (!this.gizmoBaseline || this.transformGroup.length === 0) return;

    const pivotProxy = this.gizmoBaseline.position;
    const pivot = vec3(pivotProxy.x, pivotProxy.y, pivotProxy.z);
    const tool = state.activeTool as PivotTool;

    const deltaPosition = this.gizmoProxy.position.clone().sub(pivotProxy);
    const translation = vec3(deltaPosition.x, deltaPosition.y, deltaPosition.z);

    const deltaQuaternion = this.gizmoProxy.quaternion
      .clone()
      .multiply(this.gizmoBaseline.quaternion.clone().invert());
    const { axis: rotationAxis, angle: rotationAngle } = quaternionToAxisAngle(deltaQuaternion);

    const patches = this.transformGroup.reduce<
      { id: string; transform: Partial<SceneObject['transform']> }[]
    >((accumulator, id) => {
      const baseline = this.objectBaselines.get(id);
      if (!baseline) return accumulator;

      // The pivot arithmetic (offset from pivot, rotate/scale, add pivot back)
      // is pure kernel math, unit tested in kernel/ops/pivotTransform.test.ts.
      const position = pivotPosition(baseline.position, pivot, tool, {
        translation,
        rotationAxis,
        rotationAngle,
        scaleRatio,
      });

      let rotation = baseline.rotation;
      let scale = baseline.scale;

      if (tool === 'rotate') {
        // The object's own orientation still needs a quaternion round-trip
        // (Euler decomposition is fragile to hand-roll but THREE's is solid),
        // so that part stays here rather than in the pure kernel function.
        const baselineQuaternion = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(baseline.rotation.x, baseline.rotation.y, baseline.rotation.z, 'XYZ'),
        );
        const newQuaternion = deltaQuaternion.clone().multiply(baselineQuaternion);
        const newEuler = new THREE.Euler().setFromQuaternion(newQuaternion, 'XYZ');
        rotation = vec3(newEuler.x, newEuler.y, newEuler.z);
      } else if (tool === 'scale') {
        scale = mulVec(baseline.scale, scaleRatio);
      }

      accumulator.push({ id, transform: { position, rotation, scale } });
      return accumulator;
    }, []);

    state.setObjectTransforms(patches);
  }

  // ------------------------------------------------------------- pointer

  private handlePointerDown = (event: PointerEvent): void => {
    this.pointerPixels = this.pointerPosition(event);
    if (this.gizmo.dragging) return;
    if (this.controls.onPointerDown(event)) return;
    if (event.button !== 0) return;

    this.dragStart = this.pointerPosition(event);
    this.dragCurrent = this.dragStart.clone();
    this.dragPath = [this.dragStart.clone()];
  };

  private handlePointerMove = (event: PointerEvent): void => {
    this.pointerPixels = this.pointerPosition(event);
    // A scale drag is measured from the pointer itself, so it is driven here
    // rather than from three's change event — that fires before this handler
    // for the same move, and would always be working off the previous position.
    if (this.scaleDrag) {
      this.applyScaleDrag();
      return;
    }
    if (this.rotateDrag) {
      this.applyRotateDrag();
      return;
    }
    if (this.controls.onPointerMove(event)) return;
    if (!this.dragStart) return;

    this.dragCurrent = this.pointerPosition(event);
    // Thinned as it is drawn: a pointer event per pixel would leave a lasso
    // thousands of points long, and every one of them is a segment the
    // crossing test walks for every element in the mesh.
    const last = this.dragPath[this.dragPath.length - 1];
    if (!last || last.distanceTo(this.dragCurrent) >= LASSO_POINT_SPACING) {
      this.dragPath.push(this.dragCurrent.clone());
    }
    this.drawSelectionShape();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const wasNavigating = this.controls.isNavigating;
    this.controls.onPointerUp(event);

    const start = this.dragStart;
    const end = this.dragCurrent;
    const path = this.dragPath;
    // Cleared before either way out below: a drag the camera took over halfway
    // through never reaches the selection, and used to leave its marquee on
    // screen until something else drew over it.
    this.dragStart = null;
    this.dragCurrent = null;
    this.dragPath = [];
    this.hideSelectionShape();

    if (wasNavigating || !start || !end) return;

    // Under a few pixels the drag is a click with a shaky hand, whatever shape
    // it drew: a lasso that small encloses nothing anyone aimed at.
    if (start.distanceTo(end) > 4) {
      // The release point closes the lasso: thinning may have dropped it, and
      // it is the one point the user was certainly looking at.
      const shape = useEditorStore.getState().selectShape;
      const points = [...path, end];
      const region = regionForShape(shape, start, end, points);

      if (useEditorStore.getState().mode === 'object') {
        this.objectRegionSelect(region, marqueeShape(shape, start, end, points), event.shiftKey);
      } else {
        this.regionSelect(region, event.shiftKey);
      }
      return;
    }

    this.clickSelect(end, event.shiftKey, event.altKey);
  };

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (this.resizeProportionalFalloff(event)) return;
    this.controls.onWheel(event);
  };

  /**
   * Blender's gesture: while a proportional transform runs, the wheel grows and
   * shrinks the falloff instead of zooming.
   *
   * Ctrl reaches the same radius whenever the ring is on screen, which is what
   * makes it usable here at all: G picks the move gizmo up rather than starting
   * a bare-pointer modal, so the most common proportional edit of the lot has
   * no free-handed moment to scroll during.
   */
  private resizeProportionalFalloff(event: WheelEvent): boolean {
    if (!this.proportionalRing.visible) return false;

    const transforming = this.gizmoDragging || this.scaleDrag !== null || this.rotateDrag !== null;
    if (!transforming && !event.ctrlKey) return false;

    const state = useEditorStore.getState();
    state.setProportional({
      radius: proportionalRadiusStep(state.proportional.radius, event.deltaY),
    });
    return true;
  }

  /**
   * Right-click opens the 3D cursor menu on whatever is under the pointer.
   *
   * The snap targets are resolved here rather than when a menu entry is picked:
   * by then the pointer has moved onto the menu itself, and the geometry it was
   * over is gone.
   */
  private handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    if (this.gizmo.dragging) return;

    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
    useEditorStore.getState().openCursorMenu({
      x: pointer.x,
      y: pointer.y,
      targets: this.resolveCursorTargets(pointer),
    });
  };

  /**
   * Finds everywhere the 3D cursor could land under the pointer.
   *
   * Every visible object is searched, not just the active one: placing the
   * cursor is a scene-level act, and in object mode there is no edit target at
   * all. The active object goes first so it wins ties.
   */
  private resolveCursorTargets(pointer: THREE.Vector2): CursorSnapTargets {
    const state = useEditorStore.getState();
    this.updateRaycaster(pointer);
    const size = { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
    const targets: CursorSnapTargets = { point: null, vertex: null, edge: null, face: null };

    const ordered = [...state.objects].sort(
      (a, b) => Number(b.id === state.activeObjectId) - Number(a.id === state.activeObjectId),
    );

    let nearestHit = Infinity;
    for (const object of ordered) {
      if (!object.visible) continue;
      const view = this.views.get(object.id);
      if (!view) continue;

      const mesh = evaluatedMesh(object, state.cursor);
      const matrix = view.group.matrix;
      const toWorld = (point: Vec3): Vec3 => {
        const world = new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrix);
        return vec3(world.x, world.y, world.z);
      };

      const hit = this.raycaster.intersectObject(view.pickTarget, false)[0];
      if (hit && hit.distance < nearestHit) {
        nearestHit = hit.distance;
        targets.point = vec3(hit.point.x, hit.point.y, hit.point.z);

        const faceId = hit.faceIndex == null ? undefined : view.triangleFaceIds[hit.faceIndex];
        const face = faceId === undefined ? undefined : mesh.faces.get(faceId);
        if (face) targets.face = toWorld(mesh.faceCenter(face));
      }

      if (!targets.vertex) {
        const pick = pickElement(view, mesh, 'vertex', pointer, this.camera, size, this.raycaster);
        const vert = pick ? mesh.verts.get(pick.elementId) : undefined;
        if (vert) targets.vertex = toWorld(vert.co);
      }

      if (!targets.edge) {
        const pick = pickElement(view, mesh, 'edge', pointer, this.camera, size, this.raycaster);
        const edge = pick ? mesh.edges.get(pick.elementId) : undefined;
        if (edge) targets.edge = toWorld(mesh.edgeCenter(edge));
      }
    }

    if (!targets.point) {
      // Nothing under the pointer: slide along the view plane the cursor is
      // already on, which is where Blender leaves it too.
      const normal = this.camera.getWorldDirection(new THREE.Vector3()).negate();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        normal,
        new THREE.Vector3(state.cursor.x, state.cursor.y, state.cursor.z),
      );
      const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (hit) targets.point = vec3(hit.x, hit.y, hit.z);
    }

    return targets;
  };

  /**
   * Ends a gizmo drag whose pointer went away without a pointerup.
   *
   * TransformControls clears `dragging` only in its pointerup handler, so a
   * capture dropped some other way — the pointer leaving the window, a release
   * the page never sees, a cancelled touch — leaves the gizmo latched: the
   * selection keeps following the bare cursor and viewport clicks are swallowed
   * because they look like part of the drag. Clearing the flags goes through
   * three's own `dragging-changed`, so the drag finishes on the normal path.
   * On an ordinary pointerup this has already run and is a no-op.
   */
  private handleLostPointerCapture = (): void => {
    if (!this.gizmoDragging) return;
    this.gizmo.axis = null;
    this.gizmo.dragging = false;
  };

  private pointerPosition(event: PointerEvent): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
  }

  private drawSelectionShape(): void {
    if (!this.dragStart || !this.dragCurrent) return;
    if (this.dragStart.distanceTo(this.dragCurrent) < 4) return;

    const shape = useEditorStore.getState().selectShape;
    this.shapeLayer ??= createMarqueeLayer(this.overlay);
    drawMarquee(
      this.overlay,
      this.shapeLayer,
      marqueeShape(shape, this.dragStart, this.dragCurrent, this.dragPath),
    );
  }

  private hideSelectionShape(): void {
    hideMarquee(this.overlay, this.shapeLayer);
  }

  private updateRaycaster(pointer: THREE.Vector2): void {
    const ndc = new THREE.Vector2(
      (pointer.x / this.canvas.clientWidth) * 2 - 1,
      -(pointer.y / this.canvas.clientHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  private clickSelect(pointer: THREE.Vector2, additive: boolean, loopSelect: boolean): void {
    const state = useEditorStore.getState();
    this.updateRaycaster(pointer);

    if (state.mode === 'object') {
      const targets = state.objects
        .filter((object) => object.visible)
        .map((object) => this.views.get(object.id)?.pickTarget)
        .filter((target): target is THREE.Mesh => target !== undefined);

      const hit = this.raycaster.intersectObjects(targets, false)[0];
      const objectId = hit?.object.userData.objectId;
      state.setActiveObject(typeof objectId === 'string' ? objectId : null, additive);
      return;
    }

    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    const view = object ? this.views.get(object.id) : undefined;
    if (!object || !view) return;

    const result = pickElement(
      view,
      object.mesh,
      state.selectMode,
      pointer,
      this.camera,
      { width: this.canvas.clientWidth, height: this.canvas.clientHeight },
      this.raycaster,
    );

    if (!result) {
      if (!additive) {
        object.mesh.deselectAll();
        state.stowTransformTool();
        state.touchMesh();
      }
      return;
    }

    applySelection(object, state.selectMode, [result.elementId], {
      additive,
      loopSelect,
      point: result.point,
    });
    object.mesh.flushSelection(state.selectMode);
    state.stowTransformTool();
    state.touchMesh();
  }

  /**
   * Objects a region drag touched, in object mode.
   *
   * Touching is the whole test: any part of an object inside the region takes
   * it, which is what `pickObjectsInRegion` reads off the geometry on screen.
   * The ray covers the one case that geometry cannot — a region small enough to
   * sit inside a single face, touching an object without reaching an edge of it.
   */
  private objectRegionSelect(region: Region, marquee: Marquee, additive: boolean): void {
    const state = useEditorStore.getState();
    const entries = state.objects
      .filter((object) => object.visible)
      .map((object) => ({ id: object.id, view: this.views.get(object.id) }))
      .filter((entry): entry is { id: string; view: ObjectView } => entry.view !== undefined);

    const size = { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
    const bounds = marqueeBounds(marquee);
    const hits = pickObjectsInRegion(entries, region, bounds, this.camera, size);

    const centre = new THREE.Vector2((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2);
    if (region.contains(centre)) {
      this.updateRaycaster(centre);
      const targets = entries.map((entry) => entry.view.pickTarget);
      const objectId = this.raycaster.intersectObjects(targets, false)[0]?.object.userData.objectId;
      if (typeof objectId === 'string' && !hits.includes(objectId)) hits.push(objectId);
    }

    state.selectObjects(hits, additive);
  }

  private regionSelect(region: Region, additive: boolean): void {
    const state = useEditorStore.getState();
    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    const view = object ? this.views.get(object.id) : undefined;
    if (state.mode !== 'edit' || !object || !view) return;

    const hits = pickInRegion(
      view,
      state.selectMode,
      region,
      this.camera,
      { width: this.canvas.clientWidth, height: this.canvas.clientHeight },
      object.mesh,
    );

    if (!additive) object.mesh.deselectAll();
    applySelection(object, state.selectMode, hits, { additive: true, loopSelect: false });
    object.mesh.flushSelection(state.selectMode);
    state.stowTransformTool();
    state.touchMesh();
  }

  // -------------------------------------------------------------- framing

  private frame(target: 'selected' | 'all'): void {
    const state = useEditorStore.getState();
    const box = new THREE.Box3();

    for (const object of state.objects) {
      if (!object.visible) continue;
      if (target === 'selected' && !state.selectedObjectIds.includes(object.id)) continue;
      const view = this.views.get(object.id);
      if (!view) continue;
      box.expandByObject(view.group);
    }

    if (box.isEmpty()) return;
    this.controls.frameBox(box);
  }

  // ------------------------------------------------------------- lifecycle

  resize(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;

    this.renderer.setSize(width, height, false);
    this.outlineResolution.set(width, height);
    for (const view of this.views.values()) view.setResolution(width, height);

    const aspect = width / height;
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();

    const halfHeight = (this.orthographicCamera.top - this.orthographicCamera.bottom) / 2;
    this.orthographicCamera.left = -halfHeight * aspect;
    this.orthographicCamera.right = halfHeight * aspect;
    this.orthographicCamera.updateProjectionMatrix();
  }

  private renderLoop = (): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.renderLoop);

    const distance = this.controls.distance;
    this.grid.update(distance);
    this.extendFarPlane(distance);
    this.updateViewLost(distance);
    this.updateCursor();
    this.updateProportionalRing();
    this.updatePointerCursor();
    this.updateSelectionOutlines();
    if (this.modalLine.visible) this.standDownGizmo();
    this.expireRecentVerts();
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Marks the pointer for whichever transform is under way.
   *
   * The sole writer of the canvas cursor: the drag starts used to set it
   * themselves, which left two of them able to overwrite each other and a
   * stale value behind whenever one ended without the other noticing.
   */
  private updatePointerCursor(): void {
    const axis = (this.gizmo as unknown as { axis: string | null }).axis;
    const rotating =
      this.rotateDrag !== null || (this.gizmo.mode === 'rotate' && axis === FREE_ROTATE_AXIS);

    // A crosshair reads as "measuring", which is what the scale line is doing —
    // the ordinary arrow gives no hint that dragging now changes size rather
    // than orbiting or picking something.
    const cursor = rotating ? ROTATE_CURSOR : this.modalLine.visible ? 'crosshair' : '';
    if (cursor === this.appliedCursor) return;

    this.appliedCursor = cursor;
    this.canvas.style.cursor = cursor;
  }

  /**
   * Re-traces the selection outlines when the camera has moved.
   *
   * Which edges are on a silhouette depends on where it is seen from, so an
   * orbit changes the outline even though nothing in the scene did. Views with
   * nothing outlined return immediately, so this costs nothing when there is no
   * selection.
   */
  private updateSelectionOutlines(): void {
    if (this.camera.position.distanceToSquared(this.outlineEye) < 1e-10) return;
    this.outlineEye.copy(this.camera.position);

    const eye = vec3(this.camera.position.x, this.camera.position.y, this.camera.position.z);
    for (const view of this.views.values()) view.refreshOutline(eye);
  }

  /**
   * Keeps the far clipping plane ahead of the current zoom.
   *
   * The far plane used to be a fixed 2000 units (from `clipEnd`'s default),
   * while the orbit can zoom out to `MAX_ORBIT_DISTANCE` (5000). Once the
   * camera-to-target distance passed the fixed far plane, the target — and
   * everything near it, grid included — fell outside the frustum and the
   * whole viewport went blank well short of the actual zoom limit. Tracking
   * the far plane against distance (with room to spare) means the grid keeps
   * rendering for the entire zoom range instead of vanishing partway through.
   * `clipEnd` still acts as a floor for users who raise it directly.
   */
  private extendFarPlane(distance: number): void {
    const required = distance * 2 + 200;
    const far = Math.max(useEditorStore.getState().clipEnd, required);

    if (Math.abs(this.perspectiveCamera.far - far) > 1) {
      this.perspectiveCamera.far = far;
      this.perspectiveCamera.updateProjectionMatrix();
    }
    if (Math.abs(this.orthographicCamera.far - far) > 1) {
      this.orthographicCamera.far = far;
      this.orthographicCamera.updateProjectionMatrix();
    }
  }

  /** Flags when the orbit has scrolled far enough out that Frame All should draw attention. */
  private updateViewLost(distance: number): void {
    const lost = useEditorStore.getState().objects.length > 0 && distance > VIEW_LOST_DISTANCE;
    if (lost === this.viewLostReported) return;
    this.viewLostReported = lost;
    useEditorStore.getState().setViewLost(lost);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);

    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
    this.canvas.removeEventListener('lostpointercapture', this.handleLostPointerCapture);

    for (const view of this.views.values()) view.dispose();
    this.views.clear();
    this.grid.dispose();
    this.disposeGizmo();
    this.renderer.dispose();
  }

  /**
   * Releases the gizmo without calling `TransformControls.dispose()`.
   *
   * In three r169 TransformControls extends Controls, which is an
   * EventDispatcher rather than an Object3D, but its dispose() still calls
   * this.traverse() and throws. Disconnecting the DOM listeners and releasing
   * the helper's GPU resources by hand does the same work safely.
   */
  private disposeGizmo(): void {
    this.gizmo.detach();

    const controls = this.gizmo as unknown as {
      disconnect?: () => void;
      dispose?: () => void;
    };
    if (typeof controls.disconnect === 'function') controls.disconnect();
    else controls.dispose?.();

    this.gizmoHelper.removeFromParent();
    this.gizmoHelper.traverse((child) => {
      const holder = child as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      holder.geometry?.dispose();
      if (holder.material) {
        if (Array.isArray(holder.material)) for (const item of holder.material) item.dispose();
        else holder.material.dispose();
      }
    });
  }
}

function applySelection(
  object: SceneObject,
  mode: SelectMode,
  ids: readonly number[],
  options: { additive: boolean; loopSelect: boolean; point?: Vec3 },
): void {
  const mesh = object.mesh;
  // Alt alone replaces the selection with the loop, Shift adds to it: Blender's
  // reading, and what keeps repeated Shift+Alt clicks stacking loops up.
  if (!options.additive) mesh.deselectAll();

  for (const id of ids) {
    if (mode === 'vertex') {
      const vert = mesh.verts.get(id);
      if (!vert) continue;
      if (options.additive && vert.selected) {
        vert.selected = false;
      } else {
        mesh.selectVert(vert);
      }
    } else if (mode === 'edge') {
      const edge = mesh.edges.get(id);
      if (!edge) continue;
      if (options.loopSelect) {
        for (const member of selectEdgeLoop(mesh, edge)) member.selected = true;
      } else {
        edge.selected = options.additive ? !edge.selected : true;
      }
    } else {
      const face = mesh.faces.get(id);
      if (!face) continue;
      const loop = options.loopSelect ? faceLoopAtClick(mesh, face, options.point) : [];
      // Empty at a triangle or an n-gon: nothing to run a loop along, so the
      // click falls back to picking the one face.
      if (loop.length > 0) {
        for (const member of loop) member.selected = true;
      } else {
        face.selected = options.additive ? !face.selected : true;
      }
    }
  }
}

/**
 * TransformControls stopped being an Object3D in newer three releases and now
 * exposes its visual through `getHelper()`. Supporting both keeps the viewport
 * working across the version range in package.json.
 */
function resolveGizmoHelper(controls: TransformControls): THREE.Object3D {
  const candidate = controls as unknown as { getHelper?: () => THREE.Object3D };
  if (typeof candidate.getHelper === 'function') return candidate.getHelper();
  return controls as unknown as THREE.Object3D;
}

type GizmoMaterial = THREE.Material & { color: THREE.Color; _color?: THREE.Color };

/** Three's own highlight for the handle under the pointer. Painted over, never shown. */
const GIZMO_HIGHLIGHT = 0xffff00;
/** How far a highlighted handle is lightened towards white in its place. */
const GIZMO_HIGHLIGHT_MIX = 0.4;
const WHITE = new THREE.Color(0xffffff);

/** The colour a drag on one axis is narrated in, or null where it spans more than one. */
function axisTint(axis: string | null): number | null {
  if (axis === 'X') return AXIS_COLORS.x;
  if (axis === 'Y') return AXIS_COLORS.y;
  if (axis === 'Z') return AXIS_COLORS.z;
  return null;
}

/**
 * Repaints the gizmo onto the app's axis colours, and keeps it there.
 *
 * Three colours the gizmo three ways, and only the first is set once. The base
 * handles are pure red, green and blue; each material's colour is cached as
 * `_color` the first time it updates so it can be restored after a highlight,
 * so the cache is written too and one pass at construction holds. Matched on
 * the colour rather than the handle name so the plane handles come along for
 * free: three shares each axis material with the plane facing it, so red covers
 * X and YZ, green covers Y and XZ, blue covers Z and XY.
 *
 * The other two are rewritten every frame, from inside three's own
 * `updateMatrixWorld`, which is why this hangs off it:
 *
 * - The handle under the pointer is painted **yellow**, a hue the viewport uses
 *   for nothing else and which says only "this one", not which axis it is.
 *   Lightening the axis's own colour says both, in a colour already being read.
 * - The guide lines — the track a drag is confined to, and the delta along it —
 *   are **white**. A line drawn along X is the same statement as the X handle,
 *   so it is tinted to match, as Blender's is. Only a drag spanning more than
 *   one axis keeps them neutral, having no single colour to claim.
 */
export function paintGizmoAxes(helper: THREE.Object3D, controls: TransformControls): void {
  const remap = new Map<number, number>([
    [0xff0000, AXIS_COLORS.x],
    [0x00ff00, AXIS_COLORS.y],
    [0x0000ff, AXIS_COLORS.z],
  ]);

  const handles: GizmoMaterial[] = [];
  const guides: { material: GizmoMaterial; base: THREE.Color }[] = [];

  helper.traverse((child) => {
    const material = (child as Partial<THREE.Mesh>).material as GizmoMaterial | undefined;
    if (!material?.color) return;

    if ((child as THREE.Object3D & { tag?: string }).tag === 'helper') {
      // Three shares one material across the delta markers and clones it per
      // axis line, so the same one turns up on several children.
      if (!guides.some((guide) => guide.material === material)) {
        guides.push({ material, base: material.color.clone() });
      }
      return;
    }

    const replacement = remap.get(material.color.getHex());
    if (replacement !== undefined) {
      material.color.setHex(replacement);
      material._color?.setHex(replacement);
    }
    if (!handles.includes(material)) handles.push(material);
  });

  const update = helper.updateMatrixWorld.bind(helper);
  helper.updateMatrixWorld = (force?: boolean) => {
    update(force);

    for (const material of handles) {
      if (material.color.getHex() !== GIZMO_HIGHLIGHT) continue;
      material.color.copy(material._color ?? material.color).lerp(WHITE, GIZMO_HIGHLIGHT_MIX);
    }

    const tint = axisTint((controls as unknown as { axis: string | null }).axis ?? null);
    for (const guide of guides) {
      if (tint === null) guide.material.color.copy(guide.base);
      else guide.material.color.setHex(tint);
    }
  };
}

/** Infinite lines along each axis the drag names: what it is locked to. */
const AXIS_GUIDES = ['X', 'Y', 'Z'];

/**
 * The line from where the object started to where it is now, and the marks on
 * its two ends. `TransformControls` gates these on nothing but `dragging`, so
 * they show on every drag whatever its axis.
 */
const DELTA_GUIDES = ['START', 'END', 'DELTA'];

/** The rotate helper's single infinite line, laid along whichever axis is live. */
const ROTATE_GUIDES = ['AXIS'];

/** The free-rotate handle: the object's centre, where every axis lights at once. */
const FREE_ROTATE_AXIS = 'XYZE';

/**
 * A circular arrow for the pointer while a free rotation is under way.
 *
 * Drawn twice — a heavy `--void` stroke under a thin `--bone` one — because a
 * cursor has to stay legible over the viewport's dark background and over a lit
 * surface both, and the palette has no single value that does. Encoded at
 * module load rather than written out by hand, so the data URI cannot be
 * malformed by an unescaped character.
 */
const ROTATE_CURSOR_SVG = [
  `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>`,
  `<g fill='none' stroke='#0b0b0b' stroke-width='4.5' stroke-linecap='round' stroke-linejoin='round'>`,
  `<path d='M18.5 12a6.5 6.5 0 1 1-1.9-4.6'/><path d='M18.5 3.5v4.6h-4.6'/></g>`,
  `<g fill='none' stroke='#f4f1ea' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>`,
  `<path d='M18.5 12a6.5 6.5 0 1 1-1.9-4.6'/><path d='M18.5 3.5v4.6h-4.6'/></g>`,
  `</svg>`,
].join('');

// Hotspot at the middle of the arc, so the turn reads as centred on the point
// the pointer is actually over. `crosshair` covers a browser that refuses SVG.
export const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  ROTATE_CURSOR_SVG,
)}") 12 12, crosshair`;

/**
 * Cuts the gizmo's drag narration back to the parts that mean something.
 *
 * The two kinds answer different questions, so they come and go on different
 * rules:
 *
 * - An axis line stands for a **constraint**, and only one axis is a constraint
 *   worth drawing. Two lines through the model, or three, say nothing about
 *   where the drag can go.
 * - The delta line answers **how far from where it started**, which is worth
 *   having on a free move off the centre handle, where nothing else reports it.
 *   The plane handle is the one case that wants neither.
 * - The rotate line belongs to the free rotation off the centre handle, which
 *   has no ring to read an angle from. Dragging a ring already draws its own
 *   circle, so a line through it is redundant — and the control would otherwise
 *   show one for a merely hovered ring, before any rotation has begun.
 *
 * Wrapped around `updateMatrixWorld` because that is where the control decides
 * this, and the renderer calls it on the way into every frame — visibility set
 * any earlier is recomputed before a pixel is drawn. Only ever hides, so
 * anything left alone keeps the control's own answer.
 */
export function trimGizmoGuides(helper: THREE.Object3D, controls: TransformControls): void {
  const axisGuides: THREE.Object3D[] = [];
  const deltaGuides: THREE.Object3D[] = [];
  const rotateGuides: THREE.Object3D[] = [];

  helper.traverse((child) => {
    const tagged = child as THREE.Object3D & { tag?: string };
    if (tagged.tag !== 'helper') return;
    if (AXIS_GUIDES.includes(child.name)) axisGuides.push(child);
    else if (DELTA_GUIDES.includes(child.name)) deltaGuides.push(child);
    else if (ROTATE_GUIDES.includes(child.name)) rotateGuides.push(child);
  });

  const update = helper.updateMatrixWorld.bind(helper);
  helper.updateMatrixWorld = (force?: boolean) => {
    update(force);

    const axis = (controls as unknown as { axis: string | null }).axis ?? '';
    // 'XYZX' and friends repeat a letter, so count the distinct ones.
    const spanned = new Set([...axis].filter((letter) => 'XYZ'.includes(letter))).size;

    if (spanned > 1) for (const guide of axisGuides) guide.visible = false;
    if (spanned === 2) for (const guide of deltaGuides) guide.visible = false;
    if (axis !== FREE_ROTATE_AXIS) for (const guide of rotateGuides) guide.visible = false;
  };
}

function focalLengthToFov(focalLength: number): number {
  // 35mm-equivalent sensor height, matching Blender's focal length readout.
  return 2 * THREE.MathUtils.radToDeg(Math.atan(12 / Math.max(focalLength, 1)));
}

function shallowArrayEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

/**
 * Standard quaternion → axis-angle conversion.
 *
 * Kept as a plain formula rather than reached for via a THREE helper: THREE's
 * `Quaternion` has no built-in "get axis and angle" accessor, only conversions
 * to/from Euler and rotation matrices. This is the few-line textbook version
 * (angle from `w`, axis from the normalised imaginary part), which the kernel's
 * `rotationMatrix(axis, angle)` then turns back into a rotation.
 */
function quaternionToAxisAngle(q: THREE.Quaternion): { axis: Vec3; angle: number } {
  const angle = 2 * Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));
  const s = Math.sqrt(1 - q.w * q.w);
  if (s < 1e-6) return { axis: vec3(0, 1, 0), angle: 0 };
  return { axis: vec3(q.x / s, q.y / s, q.z / s), angle };
}
