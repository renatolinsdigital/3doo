import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

import {
  AXIS_COLORS,
  ObjectView,
  VIEWPORT_COLORS,
  disposeMaterial,
  imageTexture,
  releaseTextures,
} from '@bridge/index';
import {
  type Axis,
  type BMesh,
  type FalloffCurve,
  type PivotTool,
  type ProportionalInfluence,
  type ProportionalOptions,
  type SelectMode,
  type SlideAim,
  type SlidePlan,
  type SlideRail,
  type Transform,
  type Vec3,
  type Vert,
  applySlide,
  autoMergeVerts,
  averageNormal,
  axisVector,
  centroid,
  cloneMesh,
  execOperator,
  faceLoopAtClick,
  inverseTransformDirection,
  inverseTransformOffset,
  inverseTransformPoint,
  medianPoint,
  mulVec,
  pivotPosition,
  planEdgeSlide,
  planVertexSlide,
  proportionalInfluence,
  rotateVerts,
  scaleVerts,
  selectEdgeLoop,
  translateVerts,
  vec3,
} from '@kernel/index';
import {
  type EditorStore,
  activeObject,
  displayCenter,
  evaluatedMesh,
  snapStepFor,
  useEditorStore,
} from '@store/index';
import type {
  CursorSnapKind,
  CursorSnapTargets,
  SceneObject,
  SelectIntent,
  ViewLostReason,
} from '@store/types';

import { CameraController, viewLostReason } from './CameraController';
import { type SnapAmounts, ViewportGrid, snapAmounts, snapTo } from './grid';
import { type MarqueeLayer, createMarqueeLayer, drawMarquee, hideMarquee } from './marquee';
import {
  type FacingElements,
  type Marquee,
  type PickResult,
  type Region,
  facingElements,
  marqueeBounds,
  marqueeShape,
  pickElement,
  pickInRegion,
  pickObjectsInRegion,
  regionForShape,
} from './picking';
import { pinnedAxes, publishViewAxes, resetViewAxes } from './viewAxes';

/** Minimum gap between recorded lasso points, in pixels. */
const LASSO_POINT_SPACING = 6;

/**
 * How far the pointer may travel and still count as a click.
 *
 * Under this a region drag encloses nothing anyone aimed at, and a gizmo grab
 * held back for the geometry behind it has not yet become a drag.
 */
const CLICK_SLOP_PIXELS = 4;

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

/**
 * How far out the pointer must be before a rotation reads a bearing from it.
 *
 * A turn is measured by the angle the pointer sweeps around the pivot, and
 * right on top of the pivot that angle is noise: a couple of pixels of travel
 * swing it half a circle. The free-rotate handle is grabbed exactly there, so
 * the drag holds still until the pointer is clear of this radius and takes its
 * first bearing from out here.
 */
const ROTATE_SEED_PX = 24;

/** What a single scale drag is allowed to multiply by, in either direction. */
const MIN_SCALE_RATIO = 0.01;
const MAX_SCALE_RATIO = 100;

/**
 * How large the transform gizmo is drawn, against `TransformControls`' own 1.
 *
 * Its handles are sized in screen space, so this is the whole of it: arrows,
 * rings, plane squares and their pickers all scale together.
 */
const GIZMO_SIZE = 2 / 3;

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
 * units, so zoomed out, where a few pixels cover metres, the object jumps
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
 * is covering a millimetre or half the scene, and rounded to the three decimals
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
 * at a radius left over from another zoom (wider than the canvas, or a
 * sub-pixel dot) starts the edit blind. `radiusPerPixel` is how much radius
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

/**
 * What TransformControls' pointer methods actually take: a point in normalised
 * device coordinates plus the button. Its types call this a PointerEvent.
 */
interface GizmoPointer {
  x: number;
  y: number;
  button: number;
}

/**
 * How far along its rail a slide has been dragged, from -1 to +1.
 *
 * Both ends are measured separately rather than as one signed axis: a rail can
 * bend at the vertex, so the way back is not simply the negative of the way
 * forward, and reading each side against its own end is what keeps the
 * geometry under the pointer either way.
 *
 * Everything is in canvas pixels, offsets from where the pointer was when the
 * slide began, which is what stops the selection jumping on the first move.
 */
export function slideFactor(
  travelled: THREE.Vector2,
  positive: THREE.Vector2,
  negative: THREE.Vector2,
): number {
  const along = travelled.dot(positive) / Math.max(positive.lengthSq(), 1e-6);
  if (along >= 0) return Math.min(along, 1);

  const back = travelled.dot(negative) / Math.max(negative.lengthSq(), 1e-6);
  return -Math.min(Math.max(back, 0), 1);
}

/**
 * Scores each edge leaving a vertex by how nearly it runs toward the pointer.
 *
 * Measured where the user is looking rather than out in the scene. An edge
 * running away from the camera is drawn short but still points at the cursor,
 * and a direction compared in three dimensions ranks it under an edge lying
 * flat across the view that aims nowhere near: what the user aimed at is what
 * they saw, so the ranking is done on screen, after the projection.
 *
 * `project` puts an object-space point where it is drawn, in canvas pixels, and
 * `asked` is the pixels from the selection out to the cursor. One direction for
 * the whole selection, so a row of vertices travels as one rather than each
 * turning toward the pointer from wherever it happens to sit.
 */
export function slideAim(project: (point: Vec3) => THREE.Vector2, asked: THREE.Vector2): SlideAim {
  const along = asked.clone().normalize();

  return (from, to) => {
    const travel = project(to).sub(project(from));
    // An edge seen end on is a point on screen, and a point aims nowhere. Zero
    // keeps it out of both ends of the rail while any edge with a direction is
    // there to take instead.
    if (travel.lengthSq() < 1e-6) return 0;
    return travel.normalize().dot(along);
  };
}

/** How far each way an extrude's axis line is drawn through the selection. */
const MODAL_AXIS_REACH_PX = 400;

/**
 * How far the pointer has to sit from the selection for "toward it" to mean
 * anything.
 *
 * The direction an inset opens along is read once, when the drag is seeded, and
 * holds for the whole of it. Reading it off a pointer already sitting on the
 * selection would pin the drag to a line picked out of a few pixels of noise.
 */
const MIN_INWARD_PX = 8;

/**
 * How big the dots of the panel's slide preview are drawn, in pixels.
 *
 * Twice the vertex dot: the landing spot has to read as its own mark where it
 * falls on top of one, and at the end of the travel it falls exactly on one.
 */
const SLIDE_PREVIEW_POINT_PX = 6;

/**
 * How wide a slide's rails are drawn, in CSS pixels.
 *
 * A hair over the wireframe: enough for the rail to read as its own line,
 * short of the bar a thicker one lays across the mesh. A plain line cannot be
 * widened at all, because WebGL ignores `linewidth`, which is why the rails go
 * through `LineMaterial`.
 */
const SLIDE_GUIDE_WIDTH_PX = 1.25;

/** What each pointer-driven operator's undo step is called. */
const OFFSET_LABELS: Record<OffsetDrag['kind'], string> = {
  bevel: 'Bevel',
  inset: 'Inset',
  extrude: 'Extrude',
};

/** The one parameter each of them spends its distance on. */
function offsetParams(kind: OffsetDrag['kind'], amount: number): Record<string, number> {
  if (kind === 'bevel') return { width: amount };
  if (kind === 'inset') return { thickness: amount };
  return { offset: amount };
}

/**
 * The way in: from the pointer toward the selection, as a unit vector on screen.
 *
 * The line an inset is measured along, because the border ring it cuts grows
 * into the face rather than out of it, and the gesture that opens it runs the
 * same way. Null when the pointer is already on the selection and there is no
 * way in to read, which leaves `axisAmount` to fall back to the vertical.
 */
export function inwardDirection(
  from: THREE.Vector2,
  pivotPixels: THREE.Vector2,
): THREE.Vector2 | null {
  const offset = pivotPixels.clone().sub(from);
  return offset.length() < MIN_INWARD_PX ? null : offset.normalize();
}

/**
 * How far along a line on screen the pointer has been dragged, in object units.
 *
 * What an extrude and an inset read: the region normal for one, the way in for
 * the other. Only travel along that line counts, so the pointer can wander off
 * it without dragging the shape with it, and it goes on reading past the far
 * end: pushing an inset on through the face and out the other side keeps
 * widening it rather than dead-ending halfway.
 */
export function axisAmount(
  travel: THREE.Vector2,
  screenAxis: THREE.Vector2 | null,
  unitsPerPixel: number,
): number {
  // No line to measure along: an extrude pointing back at the camera, or an
  // inset seeded on top of the selection. Pulling up is pulling out is the
  // reading left, and canvas y grows downward, hence the negation.
  const along = screenAxis ? travel.dot(screenAxis) : -travel.y;
  const amount = along * unitsPerPixel;
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * How far the guide line has been drawn out since the drag began, in object units.
 *
 * What a bevel reads, dragged the way a scale is: the dashed line runs from the
 * selection out to the pointer, and the length of that line is the cut. Draw it
 * out and the chamfer opens with it, whichever way round the selection the
 * pointer travels, and bring the pointer back in and it closes again. It closes
 * no further than nothing, a negative width being a chamfer cut backward.
 */
export function guideAmount(pointerPx: number, referencePx: number, unitsPerPixel: number): number {
  const amount = (pointerPx - referencePx) * unitsPerPixel;
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

/**
 * The travel an inset reads, on the side of zero it can use.
 *
 * The ring is cut into the face, so pushing the pointer in toward the selection
 * is what opens it. Coming back out past where the drag began closes it to
 * nothing rather than turning it inside out: a negative inset pushes the border
 * out through the face beside it. An extrude is the one with a shape on the
 * other side of zero, the region sinking into the surface rather than rising
 * off it.
 */
export function inwardAmount(
  travel: THREE.Vector2,
  screenAxis: THREE.Vector2 | null,
  unitsPerPixel: number,
): number {
  return Math.max(0, axisAmount(travel, screenAxis, unitsPerPixel));
}

/**
 * Whether a press is starting an offset drag rather than confirming one.
 *
 * The keyboard gesture leaves the pointer free, so a click is how it ends, but
 * every other tool here is grabbed and dragged, and that is what the hand
 * reaches for after E. The two only collide at the press: a distance still at
 * nothing has nothing worth confirming, so that press opens the drag and the
 * release ends it, while a press after the pointer has been moved out to a
 * distance means what it always did.
 */
export function startsOffsetHold(button: number, amount: number): boolean {
  return button === 0 && amount === 0;
}

/**
 * A bevel, an inset or an extrude taking its one distance from the pointer.
 *
 * None of the three nudges what is already there: each cuts fresh topology, so
 * a wider chamfer is not the last one moved outward but the original edges
 * bevelled again. That is why the mesh as it stood at the keypress is kept
 * whole here: every preview runs on a copy of it, and a cancel puts it back.
 */
interface OffsetDrag {
  kind: 'bevel' | 'inset' | 'extrude';
  original: BMesh;
  /** The selection's median, which the guide line is drawn from or through. */
  pivot: THREE.Vector3;
  pivotPixels: THREE.Vector2;
  /** Where the pointer sat when the drag was seeded: where an extrude and an inset read zero. */
  from: THREE.Vector2;
  /**
   * How long the guide line was at that same moment, in pixels.
   *
   * What a bevel is measured against: the line runs from the selection out to
   * the pointer, and the length it has gained since is the cut.
   */
  reference: number;
  /** Whether that has been read yet, which takes a pointer position. */
  seeded: boolean;
  /**
   * Whether the distance is being dragged with the button held down.
   *
   * Set by a press that lands while the distance is still nothing, which is a
   * drag about to start rather than a confirm of one. The release ends it.
   */
  held: boolean;
  /** Object-space units per pixel of travel, so the shape keeps up with the pointer. */
  unitsPerPixel: number;
  /** The world direction an extrude travels along. Null for the other two. */
  axis: THREE.Vector3 | null;
  /** The line on screen the travel is read along: that axis, or an inset's way in. */
  screenAxis: THREE.Vector2 | null;
  /** The distance the last preview ran with. */
  amount: number;
  /** What that preview reported, which is what the status bar says at the end. */
  status: string | null;
}

/** A slide running off the bare pointer: what moves, how far, and how to put it back. */
interface SlideDrag {
  mesh: BMesh;
  plan: SlidePlan;
  /** Canvas pixels at the keypress; the drag is measured from here. */
  from: THREE.Vector2;
  /** Screen offsets from the reference rail's origin out to each of its ends. */
  positive: THREE.Vector2;
  negative: THREE.Vector2;
  factor: number;
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
  /** Whether the pointer is over the canvas at all, which is what a hover needs. */
  private pointerInside = false;
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
    /** Per axis, the factor already applied: edit mode scales by the step. */
    applied: Vec3;
    /** Set for a keyboard-started scale, which can be cancelled; null for a handle drag. */
    modal: { restore: () => void; seeded: boolean } | null;
  } | null = null;
  /**
   * A rotation running off the bare pointer, the way Blender's R does.
   *
   * Kept beside `scaleDrag` rather than folded into it: the two read the
   * pointer differently (a scale off its distance from the pivot, a rotation
   * off its bearing around it), and merging them would put a branch in every
   * line of the most delicate code here.
   */
  private rotateDrag: {
    pivot: THREE.Vector3;
    pivotPixels: THREE.Vector2;
    /** Pointer bearing last seen, so a turn past half a circle still reads as one step. */
    bearing: number;
    /** Whether that bearing has been read yet from a pointer far enough out to mean one. */
    seeded: boolean;
    /** Total angle turned so far. Object mode re-applies it whole, never compounding. */
    applied: number;
    /** World axis the turn is pinned to, or null for the axis facing the camera. */
    axis: 'x' | 'y' | 'z' | null;
    /** Set for a keyboard-started turn, which can be cancelled; null for a handle drag. */
    modal: { restore: () => void } | null;
  } | null = null;

  private readonly raycaster = new THREE.Raycaster();

  private readonly views = new Map<string, ObjectView>();
  private readonly unsubscribers: (() => void)[] = [];
  private frameHandle = 0;
  private disposed = false;

  private dragStart: THREE.Vector2 | null = null;
  private dragCurrent: THREE.Vector2 | null = null;
  /** Every point a lasso drag has passed through, in canvas pixels. */
  private dragPath: THREE.Vector2[] = [];
  /** What the running gesture does with what it picks, from the keys held as it began. */
  private dragIntent: SelectIntent = 'replace';
  /** Whether Shift is down now, which is what holds a region drag's oval round. */
  private dragUniform = false;
  /** Shift, Ctrl and Alt as they stand, which is what the pointer is drawn from. */
  private readonly heldModifiers = { shift: false, ctrl: false, alt: false };
  /** What `selectedUnderPointer` last answered, and everything the answer rested on. */
  private hoverTarget: { key: unknown[]; selected: boolean } | null = null;
  /** The overlay's SVG shapes, built on first use. */
  private shapeLayer: MarqueeLayer | null = null;
  private slideDrag: SlideDrag | null = null;
  private offsetDrag: OffsetDrag | null = null;
  /** The rails a slide may travel along, drawn while one is running. */
  private readonly slideGuide: LineSegments2;
  /** The selection where the TOPOLOGY panel's numbered slide would leave it. */
  private readonly slidePreviewEdges: THREE.LineSegments;
  private readonly slidePreviewPoints: THREE.Points;
  /** Whether that preview has anything to draw, apart from the drag that hides it. */
  private slidePreviewUp = false;
  private gizmoBaseline: GizmoBaseline | null = null;
  /** What `proportionalSpread` last worked out, and what it was worked out from. */
  private dragSpread: {
    mesh: BMesh;
    count: number;
    radius: number;
    falloff: FalloffCurve;
    influence: ProportionalInfluence;
  } | null = null;
  /** Ids of the selected, unlocked objects a group gizmo drag in object mode applies to. */
  private transformGroup: string[] = [];
  private readonly objectBaselines = new Map<string, Transform>();
  private gizmoDragging = false;
  /** TransformControls' own pointer-down, kept aside by `deferGizmoGrab`. */
  private grabGizmo: ((pointer: GizmoPointer) => void) | null = null;
  /** Set while a handle grab is held back to see whether the gesture is a click. */
  private deferredGrab = false;
  private viewLostReported: ViewLostReason | null = null;
  /**
   * Everything the scene draws, as one box, rebuilt only when the scene is.
   *
   * Read every frame to tell whether the zoom still has anywhere to go, and
   * geometry does not move between syncs, so it is worked out once per change
   * rather than once per frame.
   */
  private sceneBoxCache: THREE.Box3 | null = null;
  /** Last cursor written to the canvas; the render loop would otherwise set it every frame. */
  private appliedCursor = '';
  private recentVerts: { objectId: string; ids: Set<number>; expiresAt: number } | null = null;
  /** Last frame handed to the corner axis widget, so an unchanged one is not resent. */
  private publishedViewAxes = '';

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly overlay: HTMLElement,
  ) {
    // `stencil` is off by default in three, and the selection outline is
    // masked by one: it draws only where the object's own fill did not.
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      stencil: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(VIEWPORT_COLORS.ash);

    const { clientWidth, clientHeight } = canvas;
    const aspect = clientHeight > 0 ? clientWidth / clientHeight : 1;

    this.perspectiveCamera = new THREE.PerspectiveCamera(50, aspect, 0.05, 2000);
    this.orthographicCamera = new THREE.OrthographicCamera(
      -5 * aspect,
      5 * aspect,
      5,
      -5,
      -1000,
      2000,
    );
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
    this.slideGuide = this.createSlideGuideLine();
    this.scene.add(this.slideGuide);
    this.slidePreviewEdges = this.createSlidePreviewEdges();
    this.slidePreviewPoints = this.createSlidePreviewPoints();
    this.scene.add(this.slidePreviewEdges, this.slidePreviewPoints);
    this.scene.add(this.gizmoProxy);

    this.controls = new CameraController(this.camera, canvas);
    // Switching module tears this viewport down and builds another, so the
    // camera picks up where the last one was left rather than at the default.
    const pose = useEditorStore.getState().cameraPose;
    if (pose) this.controls.setPose(pose);

    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.size = GIZMO_SIZE;
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
   * zoomed in: the cursor is a screen-space marker, not a piece of the scene,
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
   * Every billboarded overlay (the cursor, the falloff ring) is sized through
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
   * The rails a slide may travel along, one segment per moving vertex.
   *
   * Drawn through the geometry from one end of the travel to the other rather
   * than out to the cursor: what a slide needs to show is how far it can go and
   * where each vertex would land at the end of it. The scale and rotate lines
   * answer a different question and reach out to the pointer instead.
   */
  private createSlideGuideLine(): LineSegments2 {
    const line = new LineSegments2(
      new LineSegmentsGeometry(),
      new LineMaterial({
        color: VIEWPORT_COLORS.bone,
        linewidth: SLIDE_GUIDE_WIDTH_PX,
        depthTest: false,
        transparent: true,
      }),
    );
    line.visible = false;
    line.renderOrder = 12;
    line.frustumCulled = false;
    return line;
  }

  /**
   * The selected edges drawn where a slide picked in the TOPOLOGY panel would
   * land them.
   *
   * Cyan, the palette's blue: the geometry around it is bone and what is
   * selected is red, so a landing spot is neither of the two things already on
   * screen. Drawn over the mesh rather than through it, because a slide travels
   * across the faces beside the selection and half of where it lands is usually
   * behind them.
   */
  private createSlidePreviewEdges(): THREE.LineSegments {
    const edges = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: VIEWPORT_COLORS.cyan,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      }),
    );
    edges.visible = false;
    edges.renderOrder = 12;
    edges.frustumCulled = false;
    return edges;
  }

  /** The same preview's dots: one per vertex the slide would move. */
  private createSlidePreviewPoints(): THREE.Points {
    const points = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        size: SLIDE_PREVIEW_POINT_PX,
        sizeAttenuation: false,
        color: VIEWPORT_COLORS.cyan,
        depthTest: false,
        transparent: true,
      }),
    );
    points.visible = false;
    points.renderOrder = 13;
    points.frustumCulled = false;
    return points;
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
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.addEventListener('lostpointercapture', this.handleLostPointerCapture);
    window.addEventListener('keydown', this.handleModifierKey);
    window.addEventListener('keyup', this.handleModifierKey);
    window.addEventListener('blur', this.handleWindowBlur);

    this.gizmo.addEventListener('dragging-changed', this.handleGizmoDragging);
    this.gizmo.addEventListener('objectChange', this.handleGizmoChange);
    this.deferGizmoGrab();
  }

  /**
   * Lets a click reach the geometry a gizmo handle is drawn over.
   *
   * In edit mode the handles sit on the very mesh being edited, and the arms
   * reach out across the rest of it, so a vertex behind one used to be
   * unselectable until the view was orbited to move the handle off it. Object
   * mode is no different: the handles stand on the selected object's pivot,
   * which is exactly where a Shift+click to drop that object lands.
   *
   * TransformControls decides to drag in `pointerDown`, which is the one place
   * the decision can be held back. A press with something selectable under it
   * starts nothing: if the pointer then travels, `promoteDeferredGrab` hands the
   * grab over and the drag runs as usual, and if it does not, the press falls
   * through to `clickSelect` and picks what is behind the handle. Blender's
   * gizmos yield the same way, and it costs nothing when the handle is over
   * empty space, where there is nothing to yield to.
   */
  private deferGizmoGrab(): void {
    const controls = this.gizmo as unknown as { pointerDown: (pointer: GizmoPointer) => void };
    const grab = controls.pointerDown.bind(this.gizmo);
    this.grabGizmo = grab;

    controls.pointerDown = (pointer) => {
      // A null axis is not a grab at all, so there is nothing to weigh against
      // the geometry: three refuses the drag on its own. Written on every press
      // rather than only when it defers, so a press can never inherit the last
      // one's answer.
      this.deferredGrab =
        this.gizmo.axis !== null && this.selectedAt(this.pixelPosition(pointer)) !== null;
      if (this.deferredGrab) return;
      grab(pointer);
    };
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
            state.overlays.origins,
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
        (state) => [state.snapEnabled, state.snapMode, state.snapStep, state.gridScale] as const,
        () => this.syncGizmoSnap(),
        { equalityFn: shallowArrayEqual, fireImmediately: true },
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
      // re-seat it, but only while the cursor is what it is anchored to.
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
        (state) => state.lockVerticalOrbit,
        (locked) => {
          this.controls.lockVerticalOrbit = locked;
        },
        { fireImmediately: true },
      ),
      store.subscribe(
        (state) => [state.orthographic, state.focalLength, state.clipStart, state.clipEnd] as const,
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
          else if (modal?.kind === 'slide') this.beginModalSlide();
          else if (
            modal?.kind === 'bevel' ||
            modal?.kind === 'inset' ||
            modal?.kind === 'extrude'
          ) {
            this.beginOffsetDrag(modal.kind);
          }
          // Cleared from somewhere else (a mode change, a reset) while a
          // modal transform is still live: put everything back.
          else if (!modal && this.scaleDrag?.modal) this.finishModalScale(true);
          else if (!modal && this.rotateDrag?.modal) this.finishModalRotate(true);
          else if (!modal && this.slideDrag) this.finishModalSlide(true);
          else if (!modal && this.offsetDrag) this.finishOffsetDrag(true);
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
      // subscriptions above would re-run, yet a locked object has to lose its
      // gizmo, since dragging it is refused anyway.
      store.subscribe(
        (state) => state.objects.map((object) => object.locked),
        () => this.updateGizmo(),
        { equalityFn: shallowArrayEqual },
      ),
      store.subscribe(
        (state) => state.slidePreview,
        () => this.updateSlidePreview(useEditorStore.getState()),
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
      store.subscribe(
        (state) => state.orbitRequest,
        (request) => {
          if (!request) return;
          if (request.step === 'opposite') this.controls.orbitOpposite();
          else this.controls.orbitStep(request.step);
        },
      ),
      store.subscribe(
        (state) => state.cursorSnapRequest,
        (request) => {
          if (request) this.snapCursorUnderPointer(request.kind);
        },
      ),
      store.subscribe(
        (state) => state.deleteMenuRequest,
        (request) => {
          if (request) this.openDeleteMenu();
        },
      ),
    );
  }

  // ------------------------------------------------------------ scene sync

  /** Rebuilds every object's GPU buffers from the kernel meshes. */
  syncScene(): void {
    this.sceneBoxCache = null;
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
        view.setResolution(
          this.outlineResolution.x,
          this.outlineResolution.y,
          this.renderer.getPixelRatio(),
        );
        this.views.set(object.id, view);
        this.scene.add(view.group);
      }

      const display = evaluatedMesh(object, state.cursor, state.meshVersion);
      const asset = object.image ? state.assets[object.image.assetId] : undefined;
      view.update(object, display, {
        texture: asset ? imageTexture(asset) : null,
        mode: state.mode,
        selectMode: state.selectMode,
        recentVerts: this.recentVerts?.objectId === object.id ? this.recentVerts.ids : undefined,
        isActive: object.id === state.activeObjectId,
        isSelected: state.selectedObjectIds.includes(object.id),
        eye: vec3(this.camera.position.x, this.camera.position.y, this.camera.position.z),
        selectionLine: { color: state.selectionLineColor, width: state.selectionLineWidth },
        meshVersion: state.meshVersion,
        settings,
      });
    }

    for (const [id, view] of this.views) {
      if (alive.has(id)) continue;
      view.dispose();
      this.views.delete(id);
    }

    // Held by asset rather than by object, so a picture whose plane was deleted
    // and undone is still decoded, and one the scene has genuinely dropped is
    // freed on the next sync.
    releaseTextures(new Set(Object.keys(state.assets)));

    this.updateProportionalAnchor(state);
    this.updateSlidePreview(state);
    this.updateGizmo();
    // Every view has just rebuilt its buffers and dropped the mark with them,
    // and the geometry under a still pointer may be different geometry now.
    this.updateHoverVert();
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
   * circle can only average it, as Blender's does.
   */
  private updateProportionalAnchor(state: EditorStore): void {
    this.proportionalAnchor = null;
    if (state.mode !== 'edit') return;

    const object = activeObject(state);
    if (!object) return;

    const selected = object.mesh.selectedVerts();
    if (selected.length === 0) return;

    const median = medianPoint(selected);
    this.proportionalAnchor = new THREE.Vector3(median.x, median.y, median.z).applyMatrix4(
      this.views.get(object.id)?.group.matrix ?? new THREE.Matrix4(),
    );

    this.proportionalScale = meanScale(object.transform.scale);
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
   * Lifts the panel's slide preview into the world it is drawn in.
   *
   * The panel publishes it in the object's own space, which is where the
   * geometry it was read off lives, so it survives the object being moved or
   * turned; this is the one place that has the matrix to bring it out again.
   * Built here rather than per frame: it only changes when the panel says so.
   */
  private updateSlidePreview(state: EditorStore): void {
    this.slidePreviewUp = false;

    const preview = state.slidePreview;
    if (!preview || state.mode !== 'edit') return;

    const object = activeObject(state);
    const view = object ? this.views.get(object.id) : undefined;
    if (!view) return;

    const matrix = view.group.matrix;
    const landed = preview.points.map((point) =>
      new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrix),
    );

    const dots = new Float32Array(landed.length * 3);
    landed.forEach((point, i) => dots.set([point.x, point.y, point.z], i * 3));

    const edges = new Float32Array(preview.segments.length * 6);
    preview.segments.forEach(([from, to], i) => {
      edges.set([landed[from].x, landed[from].y, landed[from].z], i * 6);
      edges.set([landed[to].x, landed[to].y, landed[to].z], i * 6 + 3);
    });

    this.setOverlayPositions(this.slidePreviewPoints, dots);
    this.setOverlayPositions(this.slidePreviewEdges, edges);
    this.slidePreviewUp = landed.length > 0;
  }

  /** Shows the panel's slide preview, or takes it down when there is none. */
  private updateSlidePreviewVisibility(): void {
    // A slide running off the pointer moves the geometry itself, draws its own
    // rails and reads its travel out in the status bar. The panel's preview
    // sits where the mesh was when it was published, so it stands down for the
    // drag rather than answering the same question twice.
    const visible = this.slidePreviewUp && !this.slideDrag;

    this.slidePreviewEdges.visible = visible;
    this.slidePreviewPoints.visible = visible;
  }

  /** Swaps an overlay's geometry for one holding just these world positions. */
  private setOverlayPositions(
    overlay: THREE.Points | THREE.LineSegments,
    positions: Float32Array,
  ): void {
    overlay.geometry.dispose();
    overlay.geometry = new THREE.BufferGeometry();
    overlay.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  }

  /**
   * The falloff radius fitted to what the viewport can show.
   *
   * The radius is a stored setting rather than a display one: the ring has to
   * describe the reach the transform will really use, so the fit has to be
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
    const aspect =
      this.canvas.clientHeight > 0 ? this.canvas.clientWidth / this.canvas.clientHeight : 1;

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
   * pointer offset`. `syncScene()` calls this on every store change, including
   * the ones a drag itself emits, so re-seating the proxy here would reset the
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

  /** Whether a modal transform has its own guide up, and the handles are away. */
  private modalGuideUp(): boolean {
    return this.modalLine.visible || this.slideGuide.visible;
  }

  /**
   * Stands the handles down for a transform that draws its own guide.
   *
   * Hiding the helper is not enough on its own: three raycasts its picker
   * meshes whether or not they are drawn, so a handle nobody can see would
   * still highlight and still take a drag. Disabling the controls is what puts
   * the whole gizmo out of reach until the transform ends.
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
   * Positions the gizmo for object mode.
   *
   * The handles always stand on the pivot, whichever one is in force: the point
   * a turn is measured about is the point you grab it by, so nothing swings
   * round a point the gizmo never named. `objectPivotPoint` is the one place
   * that decides where that is, and `applyObjectGroupTransform` measures the
   * drag about the very seat this leaves behind.
   *
   * The drag is applied to every unlocked object in the selection, so a group
   * moves as a unit about the one point.
   */
  private updateObjectGizmo(state: EditorStore, gizmoMode: 'translate' | 'rotate' | 'scale'): void {
    const selected = state.objects.filter((object) => state.selectedObjectIds.includes(object.id));
    const transformable = selected.filter((object) => !object.locked);

    if (transformable.length === 0) {
      this.detachGizmo();
      return;
    }

    this.gizmo.setMode(gizmoMode);
    this.gizmo.enabled = !this.modalGuideUp();
    this.gizmoHelper.visible = !this.modalGuideUp();
    this.transformGroup = transformable.map((object) => object.id);

    const pivot = this.objectPivotPoint(state, transformable);
    this.gizmoProxy.position.set(pivot.x, pivot.y, pivot.z);

    // A lone object lends the handles its own axes, so they follow how it has
    // been turned. About the cursor they stay world-aligned: orbiting a point
    // outside the object around the object's own axes is not what "about the
    // cursor" means. A group has no one orientation to take, so it is
    // world-aligned as well.
    const oriented =
      transformable.length === 1 && state.pivot !== 'cursor' ? transformable[0].transform : null;
    this.gizmoProxy.rotation.set(
      oriented?.rotation.x ?? 0,
      oriented?.rotation.y ?? 0,
      oriented?.rotation.z ?? 0,
    );
    this.gizmoProxy.scale.set(
      oriented?.scale.x ?? 1,
      oriented?.scale.y ?? 1,
      oriented?.scale.z ?? 1,
    );

    this.captureGizmoBaseline();
    this.gizmo.attach(this.gizmoProxy);
  }

  /**
   * Where an object-mode turn or scale is measured about, and so where the
   * handles are seated.
   *
   * MEDIAN is the middle of what the selection draws rather than of its
   * origins: an edit-mode move or an array modifier can leave an origin nowhere
   * near the shape, and the shape is what you are looking at when you ask to
   * turn it about its middle. It is the point the 3D cursor snaps to on CURSOR
   * TO SELECTION, so the two agree on what "the selection" means.
   *
   * ORIGIN is the object's own origin, and across a group the active object's:
   * one point rather than one per object, since the handles have to stand on
   * the thing the turn is measured about. It falls back to the first of them
   * when the active object is locked or unset, which still leaves the pivot on
   * an origin rather than on a point belonging to none of them.
   */
  private objectPivotPoint(state: EditorStore, transformable: readonly SceneObject[]): Vec3 {
    if (state.pivot === 'cursor') return state.cursor;

    if (state.pivot === 'median') {
      return centroid(
        transformable.map((object) =>
          displayCenter(object, evaluatedMesh(object, state.cursor, state.meshVersion)),
        ),
      );
    }

    const anchor =
      transformable.find((object) => object.id === state.activeObjectId) ?? transformable[0];
    return anchor.transform.position;
  }

  /**
   * In edit mode the gizmo drives the selection on the one active object,
   * seated wherever the pivot says a turn is measured from: the middle of the
   * picked vertices, the object's own origin, or the 3D cursor.
   */
  private updateEditGizmo(state: EditorStore, gizmoMode: 'translate' | 'rotate' | 'scale'): void {
    const object = activeObject(state);
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
    this.gizmo.enabled = !this.modalGuideUp();
    this.gizmoHelper.visible = !this.modalGuideUp();
    this.transformGroup = [];

    // Zero is the object's origin in its own frame, so the ORIGIN pivot takes
    // the same road out to world space that the median does.
    const local = state.pivot === 'origin' ? vec3() : medianPoint(selected);
    const anchor =
      state.pivot === 'cursor'
        ? new THREE.Vector3(state.cursor.x, state.cursor.y, state.cursor.z)
        : new THREE.Vector3(local.x, local.y, local.z).applyMatrix4(
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

  /**
   * Holds where the gizmo and every object in the drag group stand, for a
   * transform to be measured from and, if it is cancelled, put back to.
   */
  private captureBaselines(state: EditorStore): void {
    this.captureGizmoBaseline();
    this.objectBaselines.clear();
    for (const object of state.objects) {
      if (!this.transformGroup.includes(object.id)) continue;
      this.objectBaselines.set(object.id, structuredClone(object.transform));
    }
  }

  private handleGizmoDragging = (event: { value: unknown }): void => {
    const dragging = event.value === true;
    this.gizmoDragging = dragging;
    const state = useEditorStore.getState();

    if (dragging) {
      this.captureBaselines(state);
      const tool = state.activeTool === 'select' ? 'move' : state.activeTool;
      state.recordHistory(
        state.mode === 'object' ? 'Transform object' : `${tool} selection`.toUpperCase(),
      );
      // Vertices are about to move, which takes the mesh away from what the
      // primitive's parameters describe: left live, a later tweak of one would
      // regenerate the shape straight over this edit. Cleared once here rather
      // than on every drag tick: moving the object itself changes nothing
      // about the mesh, so object mode keeps its parameters.
      if (state.mode === 'edit') {
        state.patchActiveObject({ primitive: null }, { touchGeometry: false });
      }
      if (state.activeTool === 'scale') this.beginScaleDrag();
      // The centre handle turns about the axis facing the camera, which is what
      // the R key turns about too. Running it through the same drag gives it the
      // same dashed line out to the pointer, in place of three's trackball and
      // the white line it draws across the model to report one.
      else if (this.gizmo.axis === FREE_ROTATE_AXIS) this.startRotateDrag(null);
      return;
    }

    this.endScaleDrag();
    this.endRotateDrag();
    this.autoMergeSelection();
    // The next drag measures its own falloff, from wherever the selection has
    // ended up rather than from where this one found it.
    this.dragSpread = null;

    // `gizmoDragging` is already false, so this resync is the one that re-seats
    // the gizmo on where the selection actually landed.
    state.touchMesh();
  };

  /**
   * What snapping quantises to right now, or null when it is off.
   *
   * Read fresh at every step rather than captured at drag start, so flipping
   * the switch or changing the step mid-drag takes effect where the user
   * expects it to rather than at the next drag.
   */
  private snapping(): SnapAmounts | null {
    const { snapEnabled, snapMode, snapStep, gridScale } = useEditorStore.getState();
    return snapAmounts(snapEnabled, snapStepFor(snapMode, snapStep), gridScale);
  }

  /**
   * Hands the gizmo the two amounts it can quantise on its own.
   *
   * TransformControls covers a move and a turn about one axis, which is exactly
   * the part of a drag it drives itself. The scale, the free turn and the
   * keyboard transforms are applied here instead, and snap their own amount.
   */
  private syncGizmoSnap(): void {
    const amounts = this.snapping();
    this.gizmo.translationSnap = amounts?.translate ?? null;
    this.gizmo.rotationSnap = amounts?.rotate ?? null;
  }

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

    // The line belongs to a scale that has no direction of its own: the
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
   * which is a turn about the view normal, not about any world axis.
   */
  private viewAxis(): Vec3 {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.negate();
    return vec3(forward.x, forward.y, forward.z);
  }

  private startRotateDrag(modal: { restore: () => void } | null): void {
    const pivotPixels = this.projectToPixels(this.gizmoProxy.position);
    this.rotateDrag = {
      pivot: this.gizmoProxy.position.clone(),
      pivotPixels,
      bearing: 0,
      seeded: false,
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

    const restore = this.prepareModalTransform('ROTATE');
    if (!restore) return;

    this.startRotateDrag({ restore });
    this.captureModalInput();
  }

  /**
   * What a keyboard rotate or scale does before anything moves, and how it is
   * undone on a cancel. Null, with the modal already ended, when the selection
   * gives it nothing to move.
   *
   * The history entry goes in first, while the scene is still untouched, which
   * is the only moment there is a state to undo back to.
   */
  private prepareModalTransform(label: 'ROTATE' | 'SCALE'): (() => void) | null {
    const state = useEditorStore.getState();
    const editing = state.mode === 'edit';
    const object = activeObject(state);
    const selected = editing && object ? object.mesh.selectedVerts() : [];

    if (editing ? selected.length === 0 : this.transformGroup.length === 0) {
      state.endModal();
      return null;
    }

    state.recordHistory(editing ? `${label} selection` : 'Transform object');
    if (editing) state.patchActiveObject({ primitive: null }, { touchGeometry: false });
    this.captureBaselines(state);

    if (!editing) {
      return () =>
        useEditorStore
          .getState()
          .setObjectTransforms(
            [...this.objectBaselines].map(([id, transform]) => ({ id, transform })),
          );
    }

    const restorePoints = selected.map((vert) => ({ vert, co: { ...vert.co } }));
    return () => {
      for (const point of restorePoints) point.vert.co = point.co;
      object?.mesh.computeNormals();
      useEditorStore.getState().touchMesh();
    };
  }

  /**
   * Takes the keyboard and the next click for a modal transform: no button is
   * held, so a click, Enter or Escape is what ends it, and X, Y or Z pins it.
   */
  private captureModalInput(): void {
    window.addEventListener('keydown', this.handleModalKey, true);
    window.addEventListener('pointerdown', this.handleModalPointer, true);
    window.addEventListener('contextmenu', this.handleModalContextMenu, true);
  }

  private releaseModalInput(): void {
    window.removeEventListener('keydown', this.handleModalKey, true);
    window.removeEventListener('pointerdown', this.handleModalPointer, true);
    window.removeEventListener('contextmenu', this.handleModalContextMenu, true);
  }

  private finishModalRotate(cancelled: boolean): void {
    const drag = this.rotateDrag;
    if (!drag?.modal) return;

    this.releaseModalInput();

    const state = useEditorStore.getState();
    if (cancelled) {
      drag.modal.restore();
      // The entry was recorded before anything moved, so with everything back
      // where it was it would undo to the state the scene is already in.
      state.discardHistory();
    } else {
      this.autoMergeSelection();
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

    // Nothing turns until the pointer is out where a bearing means something: a
    // keypress carries no pointer position at all, and the free-rotate handle is
    // grabbed on the pivot itself. Both take their first reading from outside
    // the dead radius, so neither can jump on its opening move.
    if (!drag.seeded) {
      this.updateModalLine();
      if (this.pointerPixels.distanceTo(drag.pivotPixels) < ROTATE_SEED_PX) return;
      drag.bearing = this.pointerBearing(drag.pivotPixels);
      drag.seeded = true;
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
    // Quantised off the running total rather than the step: one pointer move
    // covers a fraction of a notch, so rounding each step on its own would
    // round every one of them to nothing and the turn would never move.
    const snap = this.snapping();
    const total = snap ? snapTo(drag.applied, snap.rotate) : drag.applied;
    const settled = snap ? snapTo(previous, snap.rotate) : previous;

    if (drag.modal) {
      state.updateModal({ value: vec3(THREE.MathUtils.radToDeg(total), 0, 0) });
    }

    const baseline = this.gizmoBaseline;
    if (!baseline) return;

    const axis = drag.axis ? axisVector(drag.axis) : this.viewAxis();
    const turn = (angle: number) =>
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(axis.x, axis.y, axis.z), angle);

    if (state.mode === 'object') {
      // Re-applied whole against the drag-start baseline, so pinning an axis
      // part-way through re-reads the same total turn about the new one rather
      // than stacking it on what the old one had already done.
      this.gizmoProxy.quaternion.copy(turn(total).multiply(baseline.quaternion));
      this.applyObjectGroupTransform(state);
      return;
    }

    const object = activeObject(state);
    if (!object) return;

    // Edit mode has no per-vertex baseline to re-apply against, so it turns by
    // the step since the last move and `applyEditTransform` re-seats the
    // baseline behind it. Snapping leaves that step at zero while the pointer
    // crosses a notch without reaching the next, which reads as nothing to do.
    this.gizmoProxy.quaternion.copy(turn(total - settled).multiply(baseline.quaternion));
    this.applyEditTransform(state, object);
  }

  /**
   * Starts a scale that runs off the bare pointer, the way Blender's S does.
   *
   * No button is held, so it ends on a click, Enter or Escape instead of on
   * pointerup, and because it can be cancelled, it captures how to put
   * everything back before it touches anything.
   */
  private beginModalScale(): void {
    if (this.scaleDrag) return;

    const restore = this.prepareModalTransform('SCALE');
    if (!restore) return;

    this.startScaleDrag('XYZ', { restore, seeded: false });
    this.captureModalInput();
  }

  private finishModalScale(cancelled: boolean): void {
    const drag = this.scaleDrag;
    if (!drag?.modal) return;

    this.releaseModalInput();

    const state = useEditorStore.getState();
    if (cancelled) {
      drag.modal.restore();
      // The entry was recorded before anything moved, so with everything back
      // where it was it would undo to the state the scene is already in.
      state.discardHistory();
    } else {
      this.autoMergeSelection();
    }

    // Cleared before the store is told, so the modal subscription sees nothing
    // left to cancel.
    this.endScaleDrag();
    state.endModal();
    state.touchMesh();
  }

  /**
   * Starts a slide off the bare pointer, the way Blender's edge slide runs.
   *
   * The same shape as the modal scale and rotate: no button is held, so it ends
   * on a click, Enter or Escape, and the history entry goes in before anything
   * moves so a cancel can put it all back.
   *
   * Where the pointer already is decides which way a vertex slide runs: the
   * edge reaching most nearly toward the cursor is the one it travels down, so
   * the same keypress takes different edges depending on where you are looking.
   */
  private beginModalSlide(): void {
    if (this.slideDrag || this.scaleDrag || this.rotateDrag) return;

    const state = useEditorStore.getState();
    const object = activeObject(state);
    const view = object ? this.views.get(object.id) : undefined;
    if (!object || !view) {
      state.endModal();
      return;
    }

    const mesh = object.mesh;
    const matrix = view.group.matrix.clone();
    const selected = mesh.selectedVerts();
    const plan =
      state.modal?.element === 'edge'
        ? planEdgeSlide(mesh, mesh.selectedEdges())
        : planVertexSlide(mesh, selected, this.slideAim(selected, matrix));

    const reference = this.referenceRail(plan, matrix);
    if (!reference) {
      state.endModal('Nothing for this selection to slide along');
      return;
    }

    state.recordHistory('SLIDE selection');
    state.patchActiveObject({ primitive: null }, { touchGeometry: false });

    this.slideDrag = {
      mesh,
      plan,
      from: this.pointerPixels.clone(),
      positive: reference.positive,
      negative: reference.negative,
      factor: 0,
    };

    this.showSlideGuide(plan.rails, matrix);
    // The handles say nothing the rails do not, and they sit over the very
    // geometry being slid. `updateGizmo` brings them back at the end.
    this.standDownGizmo();
    this.captureModalInput();
  }

  private finishModalSlide(cancelled: boolean): void {
    const drag = this.slideDrag;
    if (!drag) return;

    this.releaseModalInput();

    const state = useEditorStore.getState();
    if (cancelled) {
      applySlide(drag.mesh, drag.plan, 0);
      // The entry was recorded before anything moved, so with everything back
      // where it was it would undo to the state the scene is already in.
      state.discardHistory();
    }

    // Cleared before the store is told, so the modal subscription sees nothing
    // left to cancel, and the handles are free to come back.
    this.slideDrag = null;
    this.slideGuide.visible = false;

    const moved = drag.plan.rails.length;
    const welded = cancelled ? 0 : this.autoMergeSelection();
    state.endModal(
      cancelled
        ? undefined
        : `Slid ${moved} ${moved === 1 ? 'vertex' : 'vertices'}${welded > 0 ? `, auto merged ${welded}` : ''}`,
    );
    state.touchMesh();
  }

  /**
   * What the pointer is asking a vertex slide to aim at, on screen.
   *
   * Null while the pointer sits on the selection itself, which names no
   * direction at all: the plan then takes the straightest pair of edges through
   * each vertex rather than guessing from a few pixels of noise.
   */
  private slideAim(verts: readonly Vert[], matrix: THREE.Matrix4): SlideAim | null {
    if (verts.length === 0) return null;

    const project = (point: Vec3) =>
      this.projectToPixels(new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrix));

    const asked = this.pointerPixels.clone().sub(project(medianPoint(verts)));
    if (asked.lengthSq() < 4) return null;

    return slideAim(project, asked);
  }

  /**
   * The rail the drag is measured against: whichever is nearest the pointer.
   *
   * A loop's rails point all over the screen, so one of them has to speak for
   * the rest, and the one under the cursor is the one the user is watching.
   * Null when the plan has nothing to travel along, which is what turns the
   * slide away rather than leaving it running with nowhere to go.
   */
  private referenceRail(
    plan: SlidePlan,
    matrix: THREE.Matrix4,
  ): { positive: THREE.Vector2; negative: THREE.Vector2 } | null {
    const at = (point: Vec3) =>
      this.projectToPixels(new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrix));

    let best: SlideRail | null = null;
    let found = Infinity;

    for (const rail of plan.rails) {
      const away = at(rail.origin).distanceToSquared(this.pointerPixels);
      if (away < found) {
        found = away;
        best = rail;
      }
    }
    if (!best) return null;

    const origin = at(best.origin);
    const positive = at(best.positive).sub(origin);
    const negative = at(best.negative).sub(origin);

    // Both ways closed, or a rail seen exactly end on: there is no direction to
    // drag along, and every move would answer with nothing.
    if (positive.lengthSq() < 1 && negative.lengthSq() < 1) return null;
    return { positive, negative };
  }

  private showSlideGuide(rails: readonly SlideRail[], matrix: THREE.Matrix4): void {
    const points = new Float32Array(rails.length * 6);
    const point = new THREE.Vector3();

    rails.forEach((rail, i) => {
      point.set(rail.negative.x, rail.negative.y, rail.negative.z).applyMatrix4(matrix);
      points.set([point.x, point.y, point.z], i * 6);
      point.set(rail.positive.x, rail.positive.y, rail.positive.z).applyMatrix4(matrix);
      points.set([point.x, point.y, point.z], i * 6 + 3);
    });

    // A slide plans its rails once and holds them for its whole run, so the
    // geometry is built here rather than rewritten every frame.
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(points);
    this.slideGuide.geometry.dispose();
    this.slideGuide.geometry = geometry;
    this.slideGuide.visible = true;
  }

  /** Runs the slide out to wherever the pointer has been dragged. */
  private applySlideDrag(): void {
    const drag = this.slideDrag;
    if (!drag) return;

    const factor = slideFactor(
      this.pointerPixels.clone().sub(drag.from),
      drag.positive,
      drag.negative,
    );
    if (Math.abs(factor - drag.factor) < 1e-4) return;

    drag.factor = factor;
    applySlide(drag.mesh, drag.plan, factor);

    const state = useEditorStore.getState();
    state.updateModal({ value: vec3(factor, 0, 0) });
    state.touchMesh();
  }

  /**
   * Welds what an edit-mode transform has just stacked on top of something else.
   *
   * Blender's auto merge, run once the transform ends rather than while it is
   * running: welding mid-drag would delete the very vertices the drag is still
   * holding on to. The history entry went in before the transform started, so
   * the weld lands inside it and one undo takes back both.
   */
  private autoMergeSelection(): number {
    const state = useEditorStore.getState();
    if (state.mode !== 'edit' || !state.autoMerge.enabled) return 0;

    const object = activeObject(state);
    if (!object) return 0;

    const { removed } = autoMergeVerts(
      object.mesh,
      object.mesh.selectedVerts(),
      state.autoMerge.threshold,
    );
    if (removed > 0) object.mesh.flushSelection(state.selectMode);
    return removed;
  }

  /** Whichever modal operation is running off the bare pointer, if any is. */
  private activeModal(): 'scale' | 'rotate' | 'slide' | OffsetDrag['kind'] | null {
    if (this.scaleDrag?.modal) return 'scale';
    if (this.rotateDrag?.modal) return 'rotate';
    if (this.slideDrag) return 'slide';
    if (this.offsetDrag) return this.offsetDrag.kind;
    return null;
  }

  private finishModal(cancelled: boolean): void {
    if (this.scaleDrag?.modal) this.finishModalScale(cancelled);
    else if (this.rotateDrag?.modal) this.finishModalRotate(cancelled);
    else if (this.slideDrag) this.finishModalSlide(cancelled);
    else if (this.offsetDrag) this.finishOffsetDrag(cancelled);
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

    // Only a scale or a turn has an axis to pin: a slide is already running
    // along one, the edge under it, and a bevel or an inset is one distance.
    // The keys are swallowed all the same, so a stray X mid-slide cannot reach
    // the delete operator behind it.
    if (kind !== 'scale' && kind !== 'rotate') return;

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

    const drag = this.offsetDrag;
    if (drag && startsOffsetHold(event.button, drag.amount)) {
      this.holdOffsetDrag(drag, event);
      return;
    }

    this.finishModal(event.button === 2);
  };

  /**
   * Takes the press as the start of the drag: zero moves to the pointer.
   *
   * The canvas keeps the pointer for the rest of the gesture, so the distance
   * goes on reading once the drag has run out over a panel, which is where a
   * face pulled out across the viewport ends up.
   */
  private holdOffsetDrag(drag: OffsetDrag, event: PointerEvent): void {
    // Seeded at the press rather than wherever the pointer happened to be at
    // the keypress: this is where the drag begins, so this is where it reads
    // nothing.
    this.seedOffsetDrag(drag, this.pointerPosition(event));
    drag.held = true;
    this.canvas.setPointerCapture(event.pointerId);
  }

  /** The release that ends a press-and-drag offset. One never held ignores it. */
  private handleModalPointerUp = (event: PointerEvent): void => {
    if (!this.offsetDrag?.held || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.finishOffsetDrag(false);
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

    const dragged = gizmoScaleRatio(
      this.pointerPixels.distanceTo(drag.pivotPixels),
      drag.reference,
    );
    // Held off zero at the smallest notch: a factor of nothing flattens the
    // selection to a point, and dragging back out cannot bring its shape back.
    const snap = this.snapping();
    const factor = snap ? Math.max(snap.scale, snapTo(dragged, snap.scale)) : dragged;

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

    const object = activeObject(state);
    if (!object) return;

    drag.applied = target;
    this.applyEditTransform(state, object, step);
  }

  /**
   * Starts a bevel, an inset or an extrude that takes its distance from the
   * pointer.
   *
   * The same shape as the modal scale and slide: no button is held, so it ends
   * on a click, Enter or Escape, and the history entry goes in before anything
   * changes so a cancel can drop it. A bevel is driven the way a scale is, by
   * the line drawn from the selection out to the pointer. An inset opens the
   * other way, as the pointer is pushed in toward the face it cuts into. An
   * extrude runs along one direction of its own, the region normal, so it gets
   * that axis drawn through the geometry instead.
   */
  private beginOffsetDrag(kind: OffsetDrag['kind']): void {
    if (this.offsetDrag || this.scaleDrag || this.rotateDrag || this.slideDrag) return;

    const state = useEditorStore.getState();
    const object = activeObject(state);
    const view = object ? this.views.get(object.id) : undefined;
    const selected = object?.mesh.selectedVerts() ?? [];
    if (!object || !view || selected.length === 0) {
      state.endModal();
      return;
    }

    const median = medianPoint(selected);
    const pivot = new THREE.Vector3(median.x, median.y, median.z).applyMatrix4(view.group.matrix);
    // The distance is an object-space one while the pointer travels across the
    // screen, so the object's own scale sits between the two. A non-uniform one
    // has no single answer, and the mean is what the falloff ring averages to
    // as well.
    const scale = meanScale(object.transform.scale);

    state.recordHistory(OFFSET_LABELS[kind]);
    state.patchActiveObject({ primitive: null }, { touchGeometry: false });

    const original = cloneMesh(object.mesh);
    const axis = kind === 'extrude' ? this.extrudeAxis(original, view.group.matrix) : null;

    this.offsetDrag = {
      kind,
      original,
      pivot,
      pivotPixels: this.projectToPixels(pivot),
      from: this.pointerPixels.clone(),
      reference: 0,
      seeded: false,
      held: false,
      unitsPerPixel: this.worldPerPixel(pivot) / Math.max(scale, 1e-6),
      axis,
      screenAxis: axis ? this.projectDirection(pivot, axis) : null,
      amount: 0,
      status: null,
    };

    this.modalLine.visible = true;
    // With the line up the handles say nothing it does not, and they sit over
    // the very geometry being cut. `updateGizmo` brings them back at the end.
    this.standDownGizmo();
    this.updateModalLine();

    this.captureModalInput();
    // Only an offset drag can be held down with the button, so only it waits
    // on the release.
    window.addEventListener('pointerup', this.handleModalPointerUp, true);
  }

  /** Where the drag reads nothing: the pointer's place, and the guide line's length. */
  private seedOffsetDrag(drag: OffsetDrag, at: THREE.Vector2): void {
    drag.from = at;
    drag.reference = at.distanceTo(drag.pivotPixels);
    // Which way is in only becomes known here, with a pointer position to read
    // it from. An extrude has a line of its own, the region normal, taken when
    // the drag began.
    if (drag.kind === 'inset') drag.screenAxis = inwardDirection(at, drag.pivotPixels);
    drag.seeded = true;
  }

  /** Runs the operator out to whatever distance the pointer has been dragged. */
  private applyOffsetDrag(): void {
    const drag = this.offsetDrag;
    if (!drag) return;

    this.updateModalLine();

    // A keypress carries no pointer position, so where the drag started from is
    // only known once the pointer first moves. Measuring from there is what
    // opens the distance at nothing wherever the pointer was sitting.
    if (!drag.seeded) {
      this.seedOffsetDrag(drag, this.pointerPixels.clone());
      return;
    }

    const amount = this.offsetDragAmount(drag);
    if (Math.abs(amount - drag.amount) < 1e-5) return;

    drag.amount = amount;
    this.previewOffset(drag);
  }

  /** The distance the pointer is asking for, by the reading its operator takes. */
  private offsetDragAmount(drag: OffsetDrag): number {
    if (drag.kind === 'bevel') {
      return guideAmount(
        this.pointerPixels.distanceTo(drag.pivotPixels),
        drag.reference,
        drag.unitsPerPixel,
      );
    }

    const travel = this.pointerPixels.clone().sub(drag.from);
    return drag.kind === 'inset'
      ? inwardAmount(travel, drag.screenAxis, drag.unitsPerPixel)
      : axisAmount(travel, drag.screenAxis, drag.unitsPerPixel);
  }

  /**
   * Rebuilds the mesh at the distance the drag has reached.
   *
   * Always from the copy taken when the drag began, never from what is on
   * screen: bevelling a chamfer that is already there chamfers the chamfer, and
   * every move would leave another one behind it.
   */
  private previewOffset(drag: OffsetDrag): void {
    const state = useEditorStore.getState();
    const mesh = cloneMesh(drag.original);

    // Zero is the shape that was already there. Running any of the three at it
    // would still cut the new geometry in, so none of them runs until there is
    // a distance to cut with.
    if (drag.amount !== 0) {
      const result = execOperator(
        {
          mesh,
          selectMode: state.selectMode,
          cursor: state.cursor,
          proportional: state.proportional,
        },
        drag.kind,
        offsetParams(drag.kind, drag.amount),
      );
      drag.status = result.status;
    } else {
      drag.status = null;
    }

    state.patchActiveObject({ mesh });
    state.updateModal({ value: vec3(drag.amount, 0, 0) });
  }

  private finishOffsetDrag(cancelled: boolean): void {
    const drag = this.offsetDrag;
    if (!drag) return;

    this.releaseModalInput();
    window.removeEventListener('pointerup', this.handleModalPointerUp, true);

    // A confirm that never left the start has nothing to keep either: the
    // operator has not run, and the entry recorded before it would undo to the
    // scene the user is already looking at.
    const state = useEditorStore.getState();
    const abandoned = cancelled || drag.amount === 0;
    if (abandoned) {
      state.patchActiveObject({ mesh: drag.original });
      state.discardHistory();
    }

    // Cleared before the store is told, so the modal subscription sees nothing
    // left to cancel, and the handles are free to come back.
    this.offsetDrag = null;
    this.modalLine.visible = false;

    state.endModal(abandoned ? undefined : (drag.status ?? undefined));
    state.touchMesh();
  }

  /**
   * The direction an extrude pulls the selection along, in world space.
   *
   * A region of faces travels along the normal they average to. Edges have no
   * region to average, and the operator walls them into quads along the
   * object's own Y, so that is what the guide line has to show for them.
   */
  private extrudeAxis(mesh: BMesh, matrix: THREE.Matrix4): THREE.Vector3 {
    const faces = mesh.selectedFaces();
    if (faces.length > 0) mesh.computeNormals();
    const normal = faces.length > 0 ? averageNormal(faces) : vec3(0, 1, 0);
    return new THREE.Vector3(normal.x, normal.y, normal.z).transformDirection(matrix);
  }

  /**
   * Which way a world direction runs across the canvas, as a unit vector.
   *
   * Measured over a hundred pixels' worth of it rather than over one world
   * unit, so the answer does not change with the zoom. A direction pointing at
   * the camera collapses to almost nothing on screen, and there is no reading
   * travel along a few pixels: null says so, and the caller falls back.
   */
  private projectDirection(origin: THREE.Vector3, direction: THREE.Vector3): THREE.Vector2 | null {
    const probe = origin.clone().addScaledVector(direction, this.worldPerPixel(origin) * 100);
    const offset = this.projectToPixels(probe).sub(this.projectToPixels(origin));
    return offset.length() < 10 ? null : offset.normalize();
  }

  /** The pointer unprojected at a point's own depth, so a line to it lands under it. */
  private pointerAtDepthOf(point: THREE.Vector3): THREE.Vector3 {
    const depth = point.clone().project(this.camera).z;
    return new THREE.Vector3(
      (this.pointerPixels.x / Math.max(this.canvas.clientWidth, 1)) * 2 - 1,
      -(this.pointerPixels.y / Math.max(this.canvas.clientHeight, 1)) * 2 + 1,
      depth,
    ).unproject(this.camera);
  }

  /**
   * Where an extrude's axis line starts and ends.
   *
   * Drawn through the selection and out both ways rather than from it to the
   * pointer: the travel is pinned to this one direction whatever the pointer
   * does off it, and the half behind the surface is where a negative distance
   * takes the region.
   */
  private axisLineEnds(pivot: THREE.Vector3, axis: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
    const reach = Math.max(this.worldPerPixel(pivot), 1e-6) * MODAL_AXIS_REACH_PX;
    return [
      pivot.clone().addScaledVector(axis, -reach),
      pivot.clone().addScaledVector(axis, reach),
    ];
  }

  /** Redraws the dashed guide: out to the pointer, or along the axis an extrude runs on. */
  private updateModalLine(): void {
    const drag = this.scaleDrag ?? this.rotateDrag ?? this.offsetDrag;
    if (!drag || !this.modalLine.visible) return;

    const axis = this.offsetDrag?.axis;
    const [from, to] = axis
      ? this.axisLineEnds(drag.pivot, axis)
      : [drag.pivot, this.pointerAtDepthOf(drag.pivot)];

    const positions = this.modalLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(0, from.x, from.y, from.z);
    positions.setXYZ(1, to.x, to.y, to.z);
    positions.needsUpdate = true;

    const material = this.modalLine.material as THREE.LineDashedMaterial;
    // Guarded: a zero dash size divides by zero in the dash shader, and the
    // line vanishes the moment the pointer sits on the pivot.
    const length = Math.max(from.distanceTo(to), 1e-4);
    material.dashSize = length / 30;
    material.gapSize = length / 45;
    this.modalLine.computeLineDistances();
  }

  private handleGizmoChange = (): void => {
    const state = useEditorStore.getState();
    if (!this.gizmoBaseline) return;
    // Scale is driven by the pointer in `applyScaleDrag`, and a free rotation
    // in `applyRotateDrag`, rather than by three's own world-space answer.
    if (this.scaleDrag || this.rotateDrag) return;

    if (state.mode === 'object') {
      this.applyObjectGroupTransform(state);
      return;
    }

    const object = activeObject(state);
    if (!object) return;

    this.applyEditTransform(state, object);
  };

  /**
   * The vertices a proportional drag carries, worked out once and then reused.
   *
   * Finding them means measuring every vertex in the mesh against every
   * selected one, which on a dense mesh is the slowest thing a pointer move
   * sets off. It is also supposed to be settled: the falloff is measured from
   * where the selection stood when the drag began, so recomputing it from the
   * vertices as they move would let the circle of influence crawl along with
   * them. Held until the selection, the radius or the curve changes, which is
   * what the wheel does mid-drag.
   */
  private proportionalSpread(
    state: EditorStore,
    object: SceneObject,
    selected: readonly Vert[],
  ): ProportionalOptions | ProportionalInfluence {
    if (!state.proportional.enabled || state.proportional.radius <= 0) return state.proportional;

    const held = this.dragSpread;
    const same =
      held &&
      held.mesh === object.mesh &&
      held.count === selected.length &&
      held.radius === state.proportional.radius &&
      held.falloff === state.proportional.falloff;
    if (same) return held.influence;

    const influence = proportionalInfluence(object.mesh, selected, state.proportional);
    this.dragSpread = {
      mesh: object.mesh,
      count: selected.length,
      radius: state.proportional.radius,
      falloff: state.proportional.falloff,
      influence,
    };
    return influence;
  }

  /**
   * Applies a gizmo drag to the selected vertices of the object being edited.
   *
   * Rotate and scale turn about wherever the gizmo was seated: the selection's
   * median, or the 3D cursor when that is the pivot, which is why the pivot
   * comes back through the object's own frame rather than being read off the
   * mesh. Move ignores the pivot, because a translation is the same wherever
   * you measure it from.
   */
  private applyEditTransform(state: EditorStore, object: SceneObject, scaleStep?: Vec3): void {
    const baseline = this.gizmoBaseline;
    if (!baseline) return;

    const selected = object.mesh.selectedVerts();
    if (selected.length === 0) return;

    const spread = this.proportionalSpread(state, object, selected);
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
        spread,
      );
      this.captureGizmoBaseline();
      state.touchMesh();
      return;
    }

    if (tool === 'scale') {
      if (!scaleStep) return;

      scaleVerts(object.mesh, selected, scaleStep, pivot, spread);
      state.touchMesh();
      return;
    }

    const delta = this.gizmoProxy.position.clone().sub(baseline.position);
    if (delta.lengthSq() < 1e-12) return;

    // The handles are world-aligned and the mesh edit is in object space, so
    // the drag comes back through the object's whole frame, its turn as well as
    // its scale. Undoing the scale alone sent a move along world X off along
    // the object's own X on anything that had been rotated.
    translateVerts(
      object.mesh,
      selected,
      inverseTransformOffset(object.transform, vec3(delta.x, delta.y, delta.z)),
      spread,
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
   * The turn is measured about wherever the gizmo was seated, which is the
   * pivot in force: each object's origin is carried around that point rather
   * than staying put, unless the point is the object's own origin, where the
   * offset is zero and it turns where it stands.
   */
  private applyObjectGroupTransform(state: EditorStore, scaleRatio: Vec3 = vec3(1, 1, 1)): void {
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
    this.pointerInside = true;
    this.readModifiers(event);
    if (this.gizmo.dragging) return;
    if (this.controls.onPointerDown(event)) return;
    if (event.button !== 0) return;

    this.dragStart = this.pointerPosition(event);
    this.dragCurrent = this.dragStart.clone();
    this.dragPath = [this.dragStart.clone()];
    // Shift means two things at once, so they are read at two different
    // moments: the keys down when the gesture began decide whether it builds
    // on the selection or replaces it, and whether Shift is down as the
    // pointer moves decides whether an oval is held round. Holding it
    // throughout asks for both, and letting go mid-drag frees the shape without
    // turning the addition back into a replacement.
    this.dragIntent = selectIntent(event);
    this.dragUniform = event.shiftKey;
  };

  private handlePointerMove = (event: PointerEvent): void => {
    this.pointerPixels = this.pointerPosition(event);
    this.pointerInside = true;
    this.readModifiers(event);
    // A scale drag is measured from the pointer itself, so it is driven here
    // rather than from three's change event: that fires before this handler
    // for the same move, and would always be working off the previous position.
    if (this.scaleDrag) {
      this.applyScaleDrag();
      return;
    }
    if (this.rotateDrag) {
      this.applyRotateDrag();
      return;
    }
    if (this.slideDrag) {
      this.applySlideDrag();
      return;
    }
    if (this.offsetDrag) {
      this.applyOffsetDrag();
      return;
    }
    if (this.controls.onPointerMove(event)) {
      // Orbiting: whatever was under the pointer before the camera moved is
      // not what is under it now, and nothing is being aimed at mid-orbit.
      this.clearHoverVert();
      return;
    }

    // Only while nothing is being dragged out: a region drag aims at what it
    // encloses rather than at one vertex, and the pick behind the mark is the
    // dearest thing a pointer move could be made to run.
    if (!this.dragStart) {
      this.updateHoverVert();
      return;
    }

    this.dragCurrent = this.pointerPosition(event);
    this.dragUniform = event.shiftKey;
    if (this.promoteDeferredGrab()) return;

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
    const intent = this.dragIntent;
    const uniform = event.shiftKey;
    // Cleared before either way out below: a drag the camera took over halfway
    // through never reaches the selection, and used to leave its marquee on
    // screen until something else drew over it.
    this.dragStart = null;
    this.dragCurrent = null;
    this.dragPath = [];
    // A grab that reached pointerup without travelling is the click this
    // deferral exists for, and falls through to the selection below.
    this.deferredGrab = false;
    this.hideSelectionShape();

    if (wasNavigating || !start || !end) return;

    // Under a few pixels the drag is a click with a shaky hand, whatever shape
    // it drew: a lasso that small encloses nothing anyone aimed at.
    if (start.distanceTo(end) > CLICK_SLOP_PIXELS) {
      // The release point closes the lasso: thinning may have dropped it, and
      // it is the one point the user was certainly looking at.
      const shape = useEditorStore.getState().selectShape;
      const points = [...path, end];
      const region = regionForShape(shape, start, end, points, uniform);
      const marquee = marqueeShape(shape, start, end, points, uniform);

      if (useEditorStore.getState().mode === 'object') {
        this.objectRegionSelect(region, marquee, intent);
      } else {
        this.regionSelect(region, marquee, intent);
      }
      return;
    }

    // Alt names a loop whichever way the pick is pulling, so Shift+Alt stacks
    // one onto the selection or takes it back out, by the same rule as a
    // single element, and Shift+Ctrl+Alt only ever takes one out.
    this.clickSelect(end, intent, event.altKey);
  };

  /**
   * Turns a grab held back by `deferGizmoGrab` into a real one, once the pointer
   * has travelled far enough to be a drag rather than a click.
   *
   * The drag is picked up from where the pointer is now, so the handle does not
   * jump by the few pixels the gesture spent making its mind up. If the axis
   * slipped out from under the pointer in those pixels three refuses the grab,
   * and the gesture stays the region drag it already looks like.
   */
  private promoteDeferredGrab(): boolean {
    if (!this.deferredGrab || !this.gizmo.enabled) return false;
    if (!this.dragStart || !this.dragCurrent) return false;
    if (this.dragStart.distanceTo(this.dragCurrent) <= CLICK_SLOP_PIXELS) return false;

    this.deferredGrab = false;
    const ndc = this.ndcPosition(this.dragCurrent);
    this.grabGizmo?.({ x: ndc.x, y: ndc.y, button: 0 });
    if (!this.gizmo.dragging) return false;

    this.dragStart = null;
    this.dragCurrent = null;
    this.dragPath = [];
    this.hideSelectionShape();
    return true;
  }

  /**
   * Whether what a click at `pointer` would land on is selected already, or
   * null when it would land on nothing.
   *
   * An object in object mode, a vertex, edge or face of the mesh being edited
   * in edit mode. Built on the picks `clickSelect` runs, so the pointer's sign,
   * the gizmo's deferral and the click itself never disagree about what is
   * there.
   */
  private selectedAt(pointer: THREE.Vector2): boolean | null {
    const state = useEditorStore.getState();

    if (state.mode === 'object') {
      const objectId = this.objectUnderPointer(pointer);
      return objectId === null ? null : state.selectedObjectIds.includes(objectId);
    }

    const object = activeObject(state);
    const pick = this.elementUnderPointer(pointer);
    return object && pick ? elementSelected(object.mesh, state.selectMode, pick.elementId) : null;
  }

  /** The visible object a click at `pointer` would land on in object mode. */
  private objectUnderPointer(pointer: THREE.Vector2): string | null {
    const state = useEditorStore.getState();
    const targets = state.objects
      .filter((object) => object.visible)
      .map((object) => this.views.get(object.id)?.pickTarget)
      .filter((target): target is THREE.Mesh => target !== undefined);

    this.updateRaycaster(pointer);
    const objectId = this.raycaster.intersectObjects(targets, false)[0]?.object.userData.objectId;
    return typeof objectId === 'string' ? objectId : null;
  }

  /** The element of the mesh being edited that a click at `pointer` would land on. */
  private elementUnderPointer(pointer: THREE.Vector2): PickResult | null {
    const state = useEditorStore.getState();
    if (state.mode !== 'edit') return null;

    const object = activeObject(state);
    const view = object ? this.views.get(object.id) : undefined;
    if (!object || !view) return null;

    this.updateRaycaster(pointer);
    return pickElement(
      view,
      object.mesh,
      state.selectMode,
      pointer,
      this.camera,
      this.canvasSize(),
      this.raycaster,
      this.pickable(object.mesh, view),
    );
  }

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

    const pointer = this.pointerPosition(event);
    useEditorStore.getState().openCursorMenu({
      x: pointer.x,
      y: pointer.y,
      targets: this.resolveCursorTargets(pointer),
    });
  };

  /**
   * Runs one of the menu's snaps from the keyboard.
   *
   * The menu resolves its targets as the right-click lands, because by the time
   * an entry is picked the pointer sits over the menu instead. A key has no
   * click to resolve from, so the same pass runs here against wherever the
   * pointer was left, and the store words the hit and the miss for both paths.
   *
   * A pointer that is not over the canvas has nothing to aim at, and the store
   * says so rather than the snap landing somewhere nobody pointed at.
   */
  private snapCursorUnderPointer(kind: CursorSnapKind): void {
    const targets = this.pointerInside ? this.resolveCursorTargets(this.pointerPixels) : null;
    useEditorStore.getState().snapCursor(kind, targets);
  }

  /**
   * Opens the delete menu where the pointer is, for the Delete key.
   *
   * A pointer off the canvas, over a panel say, has left no spot to open at,
   * so the menu opens in the middle of the view instead of at the edge it
   * last crossed.
   */
  private openDeleteMenu(): void {
    const at = this.pointerInside
      ? this.pointerPixels
      : new THREE.Vector2(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
    useEditorStore.getState().openDeleteMenu({ x: at.x, y: at.y });
  }

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
    const size = this.canvasSize();
    const targets: CursorSnapTargets = { point: null, vertex: null, edge: null, face: null };

    const ordered = [...state.objects].sort(
      (a, b) => Number(b.id === state.activeObjectId) - Number(a.id === state.activeObjectId),
    );

    let nearestHit = Infinity;
    for (const object of ordered) {
      if (!object.visible) continue;
      const view = this.views.get(object.id);
      if (!view) continue;

      const mesh = this.pickMesh(object, state);
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

      // Snapping the cursor to something round the back of the model is as
      // wrong as selecting it. Both reads answer from one pass over the mesh,
      // and once the nearer objects have supplied both there is none at all.
      if (!targets.vertex || !targets.edge) {
        const facing = this.pickable(mesh, view);

        if (!targets.vertex) {
          const pick = pickElement(
            view,
            mesh,
            'vertex',
            pointer,
            this.camera,
            size,
            this.raycaster,
            facing,
          );
          const vert = pick ? mesh.verts.get(pick.elementId) : undefined;
          if (vert) targets.vertex = toWorld(vert.co);
        }

        if (!targets.edge) {
          const pick = pickElement(
            view,
            mesh,
            'edge',
            pointer,
            this.camera,
            size,
            this.raycaster,
            facing,
          );
          const edge = pick ? mesh.edges.get(pick.elementId) : undefined;
          if (edge) targets.edge = toWorld(mesh.edgeCenter(edge));
        }
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
  }

  /**
   * Ends a gizmo drag whose pointer went away without a pointerup.
   *
   * TransformControls clears `dragging` only in its pointerup handler, so a
   * capture dropped some other way (the pointer leaving the window, a release
   * the page never sees, a cancelled touch) leaves the gizmo latched: the
   * selection keeps following the bare cursor and viewport clicks are swallowed
   * because they look like part of the drag. Clearing the flags goes through
   * three's own `dragging-changed`, so the drag finishes on the normal path.
   * On an ordinary pointerup this has already run and is a no-op.
   */
  private handleLostPointerCapture = (): void => {
    this.deferredGrab = false;
    if (!this.gizmoDragging) return;
    this.gizmo.axis = null;
    this.gizmo.dragging = false;
  };

  private handlePointerLeave = (): void => {
    this.pointerInside = false;
    this.clearHoverVert();
  };

  /**
   * Keeps Shift and Ctrl current, so the pointer can say what a click would do
   * before it is made.
   *
   * Read from the keyboard as well as from the mouse because the keys are
   * usually pressed with the pointer already resting on what is being aimed
   * at, and a press on its own fires no pointer event to read them from.
   */
  private handleModifierKey = (event: KeyboardEvent): void => {
    this.readModifiers(event);
  };

  /** A window that loses focus never sees the keyup, and the marks would stick. */
  private handleWindowBlur = (): void => {
    this.heldModifiers.shift = false;
    this.heldModifiers.ctrl = false;
    this.heldModifiers.alt = false;
  };

  private readModifiers(event: SelectModifiers & { altKey: boolean }): void {
    this.heldModifiers.shift = event.shiftKey;
    this.heldModifiers.ctrl = event.ctrlKey || event.metaKey;
    this.heldModifiers.alt = event.altKey;
  }

  private pointerPosition(event: MouseEvent): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
  }

  private drawSelectionShape(): void {
    if (!this.dragStart || !this.dragCurrent) return;
    if (this.dragStart.distanceTo(this.dragCurrent) < CLICK_SLOP_PIXELS) return;

    const shape = useEditorStore.getState().selectShape;
    this.shapeLayer ??= createMarqueeLayer(this.overlay);
    drawMarquee(
      this.overlay,
      this.shapeLayer,
      marqueeShape(shape, this.dragStart, this.dragCurrent, this.dragPath, this.dragUniform),
    );
  }

  private hideSelectionShape(): void {
    hideMarquee(this.overlay, this.shapeLayer);
  }

  /**
   * The mesh a view's pick buffers and pick target describe.
   *
   * Edit mode picks the object's own mesh, the one the operators run on, and
   * everywhere else the pick lands on what is drawn. The two differ only while
   * a modifier is previewing on top of the object being edited.
   */
  private pickMesh(object: SceneObject, state: EditorStore): BMesh {
    if (state.mode === 'edit' && object.id === state.activeObjectId) return object.mesh;
    return evaluatedMesh(object, state.cursor, state.meshVersion);
  }

  /**
   * What the pointer is allowed to reach on a mesh, given the shading.
   *
   * X-ray and wireframe are the two modes whose whole point is seeing (and
   * therefore selecting) what the surface would otherwise hide, so they hand
   * back null and leave every element pickable. Everywhere else the pick is
   * held to the geometry actually on screen, which is what stops a click on a
   * dense model landing on its far side. A mesh with a face taken out of it
   * hands back null as well, since what shows through the hole is the inside
   * of the far wall (see `facingElements`).
   */
  private pickable(mesh: BMesh, view: ObjectView): FacingElements | null {
    const { shading } = useEditorStore.getState();
    if (shading === 'xray' || shading === 'wireframe') return null;
    return facingElements(mesh, view.group.matrix, this.camera);
  }

  /**
   * Marks the vertex a click would take, and nothing when there is none.
   *
   * Two vertices left in the same place (a slide run onto its neighbour with
   * auto merge off) draw one dot between them, and selecting the one
   * underneath changed nothing anyone could see. The mark says both that there
   * is a vertex under the pointer and which one the click has hold of, before
   * the click rather than after it.
   *
   * Runs the same pick `clickSelect` runs, so what lights up is exactly what
   * would be selected, unselectable geometry round the back included.
   */
  private updateHoverVert(): void {
    const state = useEditorStore.getState();
    const hovering =
      this.pointerInside &&
      !this.activeModal() &&
      !this.gizmoDragging &&
      state.mode === 'edit' &&
      state.selectMode === 'vertex';

    const object = hovering ? activeObject(state) : null;
    const view = object ? this.views.get(object.id) : undefined;

    let mark: Vec3 | null = null;
    if (object && view) {
      const result = pickElement(
        view,
        object.mesh,
        'vertex',
        this.pointerPixels,
        this.camera,
        this.canvasSize(),
        this.raycaster,
        this.pickable(object.mesh, view),
      );
      // Read back out of the view's own buffers rather than off the mesh: the
      // mark has to land on the dot it is marking, whichever buffer that dot
      // was drawn from.
      const index = result ? view.vertIds.indexOf(result.elementId) : -1;
      if (index >= 0) {
        mark = vec3(
          view.vertPositions[index * 3],
          view.vertPositions[index * 3 + 1],
          view.vertPositions[index * 3 + 2],
        );
      }
    }

    for (const [id, candidate] of this.views) {
      candidate.showHoverVert(id === object?.id ? mark : null);
    }
  }

  private clearHoverVert(): void {
    for (const view of this.views.values()) view.showHoverVert(null);
  }

  /** The canvas in CSS pixels, the space every pointer position here is in. */
  private canvasSize(): { width: number; height: number } {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
  }

  private ndcPosition(pointer: THREE.Vector2): THREE.Vector2 {
    return new THREE.Vector2(
      (pointer.x / this.canvas.clientWidth) * 2 - 1,
      -(pointer.y / this.canvas.clientHeight) * 2 + 1,
    );
  }

  private pixelPosition(pointer: { x: number; y: number }): THREE.Vector2 {
    return new THREE.Vector2(
      ((pointer.x + 1) / 2) * this.canvas.clientWidth,
      ((1 - pointer.y) / 2) * this.canvas.clientHeight,
    );
  }

  private updateRaycaster(pointer: THREE.Vector2): void {
    this.raycaster.setFromCamera(this.ndcPosition(pointer), this.camera);
  }

  private clickSelect(pointer: THREE.Vector2, intent: SelectIntent, loopSelect: boolean): void {
    const state = useEditorStore.getState();

    if (state.mode === 'object') {
      const objectId = this.objectUnderPointer(pointer);
      if (objectId === null) {
        // A plain click on empty space clears the selection. One that was
        // asking to add or take away found nothing to work on, so it leaves
        // what is selected alone rather than emptying it by accident.
        if (intent === 'replace') state.setActiveObject(null);
        return;
      }

      state.setActiveObject(
        objectId,
        clickIntent(intent, state.selectedObjectIds.includes(objectId)),
      );
      return;
    }

    const object = activeObject(state);
    const view = object ? this.views.get(object.id) : undefined;
    if (!object || !view) return;

    const result = this.elementUnderPointer(pointer);
    if (!result) {
      if (intent === 'replace') {
        object.mesh.deselectAll();
        state.touchMesh(this.previewOnlyNote(view));
      }
      return;
    }

    clickElement(object.mesh, state.selectMode, result, intent, loopSelect);
    state.touchMesh();
  }

  /**
   * Why a click found nothing, when a modifier is the reason it did.
   *
   * The stack rebuilds its result from the mesh every time the viewport draws
   * and holds none of its elements, so the vertex a subdivision leaves in the
   * middle of a cap is part of the picture rather than part of the model, and
   * nothing can take hold of it until the modifier is applied. Only said when
   * the pointer was over that picture: a click on the background is a deselect
   * and means nothing more than that.
   */
  private previewOnlyNote(view: ObjectView): string | undefined {
    if (view.pickTarget === view.surfaceTarget) return undefined;
    if (this.raycaster.intersectObject(view.surfaceTarget, false).length === 0) return undefined;
    return 'Apply the modifier to edit what it adds: a click takes hold of the mesh under it';
  }

  /**
   * Objects a region drag touched, in object mode.
   *
   * Touching is the whole test: any part of an object inside the region takes
   * it, which is what `pickObjectsInRegion` reads off the geometry on screen.
   * The ray covers the one case that geometry cannot: a region small enough to
   * sit inside a single face, touching an object without reaching an edge of it.
   */
  private objectRegionSelect(region: Region, marquee: Marquee, intent: SelectIntent): void {
    const state = useEditorStore.getState();
    const entries = state.objects
      .filter((object) => object.visible)
      .map((object) => ({ id: object.id, view: this.views.get(object.id) }))
      .filter((entry): entry is { id: string; view: ObjectView } => entry.view !== undefined);

    const size = this.canvasSize();
    const bounds = marqueeBounds(marquee);
    const hits = pickObjectsInRegion(entries, region, bounds, this.camera, size);

    const centre = new THREE.Vector2(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
    );
    if (region.contains(centre)) {
      this.updateRaycaster(centre);
      const targets = entries.map((entry) => entry.view.pickTarget);
      const objectId = this.raycaster.intersectObjects(targets, false)[0]?.object.userData.objectId;
      if (typeof objectId === 'string' && !hits.includes(objectId)) hits.push(objectId);
    }

    state.selectObjects(hits, intent);
  }

  /**
   * Elements a region drag touched, in edit mode.
   *
   * Touching is the whole test, as it is in object mode: a region that clips one
   * corner of a face takes the face. The ray covers the one case the geometry
   * cannot, a region small enough to sit inside a single face without reaching
   * any side of it.
   */
  private regionSelect(region: Region, marquee: Marquee, intent: SelectIntent): void {
    const state = useEditorStore.getState();
    const object = activeObject(state);
    const view = object ? this.views.get(object.id) : undefined;
    if (state.mode !== 'edit' || !object || !view) return;

    const size = this.canvasSize();
    const facing = this.pickable(object.mesh, view);
    const hits = pickInRegion(
      view,
      state.selectMode,
      region,
      this.camera,
      size,
      object.mesh,
      facing,
    );

    if (state.selectMode === 'face') {
      const bounds = marqueeBounds(marquee);
      const centre = new THREE.Vector2(
        (bounds.minX + bounds.maxX) / 2,
        (bounds.minY + bounds.maxY) / 2,
      );
      if (region.contains(centre)) {
        this.updateRaycaster(centre);
        const pick = pickElement(
          view,
          object.mesh,
          'face',
          centre,
          this.camera,
          size,
          this.raycaster,
          facing,
        );
        if (pick && !hits.includes(pick.elementId)) hits.push(pick.elementId);
      }
    }

    applySelection(object.mesh, state.selectMode, hits, { intent, loopSelect: false });
    object.mesh.flushSelection(state.selectMode);
    state.touchMesh();
  }

  // -------------------------------------------------------------- framing

  private frame(target: 'selected' | 'all'): void {
    const selected = useEditorStore.getState().selectedObjectIds;
    const box = target === 'all' ? this.sceneBounds() : this.bounds((id) => selected.includes(id));
    if (box.isEmpty()) return;
    this.controls.frameBox(box);
  }

  /** The box around every visible object the given filter keeps. */
  private bounds(keep: (id: string) => boolean): THREE.Box3 {
    const state = useEditorStore.getState();
    const box = new THREE.Box3();

    for (const object of state.objects) {
      if (!object.visible || !keep(object.id)) continue;
      const view = this.views.get(object.id);
      if (view) box.expandByObject(view.group);
    }

    return box;
  }

  /** Everything the scene draws, worked out once per change to it. */
  private sceneBounds(): THREE.Box3 {
    this.sceneBoxCache ??= this.bounds(() => true);
    return this.sceneBoxCache;
  }

  // ------------------------------------------------------------- lifecycle

  resize(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;

    this.renderer.setSize(width, height, false);
    this.outlineResolution.set(width, height);
    (this.slideGuide.material as LineMaterial).resolution.set(width, height);
    for (const view of this.views.values()) {
      view.setResolution(width, height, this.renderer.getPixelRatio());
    }

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

    // Before anything reads the camera: a keyboard view is turning under its
    // own steam, and the frame it draws has to be the one it has got to.
    this.controls.update();

    const distance = this.controls.distance;
    this.grid.update(distance);
    this.extendFarPlane(distance);
    this.tightenNearPlane(distance);
    this.updateViewLost(distance);
    this.updateCursor();
    this.updateProportionalRing();
    this.updateSlidePreviewVisibility();
    this.updatePointerCursor();
    this.updateSelectionOutlines();
    if (this.modalGuideUp()) this.standDownGizmo();
    this.expireRecentVerts();
    this.publishViewAxes();
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Hands the corner widget the camera's orientation and whatever axis a
   * transform is pinned to.
   *
   * Only on a change: the widget writes to the DOM when it hears, and an orbit
   * that has come to rest would otherwise have it rewriting the same numbers
   * sixty times a second.
   */
  private publishViewAxes(): void {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const toward = new THREE.Vector3();
    this.camera.matrixWorld.extractBasis(right, up, toward);
    const axes = this.pinnedTransformAxes();

    const signature = `${right.toArray()}|${up.toArray()}|${toward.toArray()}|${axes?.join('') ?? ''}`;
    if (signature === this.publishedViewAxes) return;
    this.publishedViewAxes = signature;

    publishViewAxes({
      basis: {
        right: vec3(right.x, right.y, right.z),
        up: vec3(up.x, up.y, up.z),
        toward: vec3(toward.x, toward.y, toward.z),
      },
      axes,
    });
  }

  /**
   * The axes a transform in progress is running along, or null when it is free.
   *
   * Two sources, because a transform is pinned two ways: X, Y or Z during a
   * modal drag, which the store carries, and the handle a gizmo drag was
   * grabbed by, which only the gizmo knows. A plane handle names two axes and
   * the free handle names none.
   */
  private pinnedTransformAxes(): readonly Axis[] | null {
    const modal = useEditorStore.getState().modal;
    if (modal?.axis) return pinnedAxes(modal.axis, modal.excludeAxis);

    if (!this.gizmoDragging) return null;
    const handle = this.gizmo.axis ?? '';
    const axes = (['x', 'y', 'z'] as const).filter((axis) => handle.toLowerCase().includes(axis));
    // All three is the free handle, which pins nothing at all.
    return axes.length > 0 && axes.length < 3 ? axes : null;
  }

  /**
   * Marks the pointer for whichever transform is under way.
   *
   * The sole writer of the canvas cursor: the drag starts used to set it
   * themselves, which left two of them able to overwrite each other and a
   * stale value behind whenever one ended without the other noticing.
   */
  private updatePointerCursor(): void {
    const axis = this.gizmo.axis;
    const rotating =
      this.rotateDrag !== null || (this.gizmo.mode === 'rotate' && axis === FREE_ROTATE_AXIS);

    // A crosshair reads as "measuring", which is what the scale line is doing:
    // the ordinary arrow gives no hint that dragging now changes size rather
    // than orbiting or picking something.
    const cursor = rotating
      ? ROTATE_CURSOR
      : this.modalGuideUp()
        ? 'crosshair'
        : this.selectionCursor();
    if (cursor === this.appliedCursor) return;

    this.appliedCursor = cursor;
    this.canvas.style.cursor = cursor;
  }

  /**
   * The marks the pointer wears for the pick the held keys would make.
   *
   * What a click is about to do is settled before it is made, and nothing else
   * on screen says what: the same Shift+click adds or takes away depending on
   * whether what is under the pointer is selected already, and takes one
   * element or a whole loop depending on Alt. So the answer belongs on the
   * pointer. Worn under every tool, not the select one alone, because a click
   * picks things up whichever tool is in hand: move, rotate and scale all
   * leave Shift+click building a selection for the gizmo to work on, and that
   * is the moment the marks are most needed.
   */
  private selectionCursor(): string {
    // Mid-drag the gizmo is moving something rather than picking it, and Shift
    // is being held for what it means there instead.
    if (this.gizmoDragging) return '';

    const { shift, ctrl, alt } = this.heldModifiers;
    // Once the button is down the keys it went down with are the ones the
    // release will read, and a region being drawn takes what it touches the
    // way those keys said, one element at a time whatever Alt says.
    const intent = this.dragStart
      ? this.dragIntent
      : selectIntent({ shiftKey: shift, ctrlKey: ctrl, metaKey: false });
    const drawingRegion =
      this.dragStart !== null &&
      this.dragCurrent !== null &&
      this.dragStart.distanceTo(this.dragCurrent) > CLICK_SLOP_PIXELS;
    if (drawingRegion) return selectCursor(intent, false);

    const landsOnSelected = intent === 'add' && this.selectedUnderPointer();
    return selectCursor(clickIntent(intent, landsOnSelected), alt && this.loopUnderAlt());
  }

  /**
   * Whether what a click would land on right now is selected already.
   *
   * Asked every frame while Shift is down, and the pick behind it is the
   * dearest thing a frame could be made to run, so the answer is held until
   * something it rests on moves: the pointer, the camera, or the scene and its
   * selection. A click flips the answer by changing the selection, which is
   * what turns the plus into a minus under the pointer the moment it lands.
   */
  private selectedUnderPointer(): boolean {
    if (!this.pointerInside) return false;

    const state = useEditorStore.getState();
    const key = [
      this.pointerPixels.x,
      this.pointerPixels.y,
      this.camera,
      ...this.camera.matrixWorld.elements,
      ...this.camera.projectionMatrix.elements,
      state.objects,
      state.selectedObjectIds,
      state.meshVersion,
      state.mode,
      state.selectMode,
      state.shading,
    ];
    if (this.hoverTarget && shallowArrayEqual(key, this.hoverTarget.key)) {
      return this.hoverTarget.selected;
    }

    const selected = this.selectedAt(this.pointerPixels) === true;
    this.hoverTarget = { key, selected };
    return selected;
  }

  /**
   * Whether Alt would name a loop where the pointer is standing.
   *
   * Only edge and face select have loops to name: a vertex click reads Alt as
   * nothing at all, and object mode has no elements to run one through. Under
   * the Maya preset Alt+drag is the orbit, so the click never reaches the
   * selection and the ring would be promising something that cannot happen.
   *
   * What the mesh holds is not asked. A ring that came and went as the pointer
   * crossed a triangle would cost a pick every frame to draw, and would read
   * as flicker rather than as an answer; where there is no loop to take, the
   * click falls back to the one element under it, which is no worse than a
   * plain click would have been.
   */
  private loopUnderAlt(): boolean {
    if (this.controls.preset === 'maya') return false;
    const state = useEditorStore.getState();
    return state.mode === 'edit' && state.selectMode !== 'vertex';
  }

  /**
   * Redraws what the camera position decides, once it has actually moved.
   *
   * Two overlays depend on where the model is seen from: the selection outline,
   * since which edges are on a silhouette changes with the eye, and the
   * wireframe, which leaves out the edges lying on the far side. An orbit
   * changes both even though nothing in the scene did. Views with neither
   * return immediately, so this costs nothing on an empty or hidden scene.
   */
  private updateSelectionOutlines(): void {
    if (this.camera.position.distanceToSquared(this.outlineEye) < 1e-10) return;
    this.outlineEye.copy(this.camera.position);

    const eye = vec3(this.camera.position.x, this.camera.position.y, this.camera.position.z);
    for (const view of this.views.values()) view.refreshForCamera(eye);
  }

  /**
   * Keeps the far clipping plane ahead of the current zoom.
   *
   * The far plane used to be a fixed 2000 units (from `clipEnd`'s default),
   * while the orbit can zoom out to `MAX_ORBIT_DISTANCE` (5000). Once the
   * camera-to-target distance passed the fixed far plane, the target (and
   * everything near it, grid included) fell outside the frustum and the
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

  /**
   * Draws the near clipping plane in as the zoom closes on the target.
   *
   * The counterpart to `extendFarPlane`, and the reason a small object survives
   * being zoomed into. `clipStart` alone is a fixed 0.05 m, so once the orbit
   * came within about a hand's width of what it was looking at, the frustum
   * began at the object and cut through it: the shape thinned into a wedge and
   * then vanished, well before the zoom limit. Capping the near plane at a
   * tenth of the orbit distance leaves the whole object in front of it at any
   * zoom, down to the smallest one the size floor allows.
   *
   * A tenth rather than something finer so that `clipStart` still means what it
   * says over the whole normal working range: someone who raised it to cut away
   * foreground clutter keeps that cut everywhere except the last stretch of the
   * zoom, where honouring it would take the object away instead of the clutter.
   * Depth precision is the other reason not to go finer than the zoom needs.
   */
  private tightenNearPlane(distance: number): void {
    const near = Math.min(useEditorStore.getState().clipStart, distance / 10);
    // Ratio rather than a fixed epsilon: the useful step at 1000 m out is
    // metres, and at a tenth of a millimetre in it is microns.
    if (Math.abs(this.perspectiveCamera.near - near) < near * 0.01) return;

    this.perspectiveCamera.near = near;
    this.perspectiveCamera.updateProjectionMatrix();
  }

  /** Flags when Frame All should draw attention to itself, and why. */
  private updateViewLost(distance: number): void {
    const state = useEditorStore.getState();
    const lost = state.objects.length === 0 ? null : this.lostView(distance);
    if (lost === this.viewLostReported) return;
    this.viewLostReported = lost;
    state.setViewLost(lost);
  }

  /**
   * Which way the scene has been lost, if it has.
   *
   * All this end supplies is where the scene is: nothing visible leaves no gap
   * for a zoom to be failing to close, and the orbit is then judged on its own
   * distance. The rule itself is `viewLostReason`.
   */
  private lostView(distance: number): ViewLostReason | null {
    const box = this.sceneBounds();
    const gap = box.isEmpty() ? 0 : box.distanceToPoint(this.camera.position);
    return viewLostReason(distance, gap);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);

    // Handed over before anything is torn down, for whichever viewport is
    // mounted next.
    useEditorStore.getState().setCameraPose(this.controls.pose());
    // The widget outlives no viewport: without this it would sit at the last
    // orientation this one published until the next one draws a frame.
    resetViewAxes();

    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.removeEventListener('lostpointercapture', this.handleLostPointerCapture);
    window.removeEventListener('keydown', this.handleModifierKey);
    window.removeEventListener('keyup', this.handleModifierKey);
    window.removeEventListener('blur', this.handleWindowBlur);

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
      if (holder.material) disposeMaterial(holder.material);
    });
  }
}

/**
 * A click on one element of the mesh being edited, for `clickSelect`.
 *
 * Whether the element was selected is read before anything changes, and it
 * decides a Shift+click on a loop as well as on the one element: a picked
 * edge or face takes its whole loop back out, an unpicked one adds it, which
 * is how Blender reads the same click.
 */
export function clickElement(
  mesh: BMesh,
  mode: SelectMode,
  pick: PickResult,
  intent: SelectIntent,
  loopSelect: boolean,
): void {
  applySelection(mesh, mode, [pick.elementId], {
    intent: clickIntent(intent, elementSelected(mesh, mode, pick.elementId)),
    loopSelect,
    point: pick.point,
  });
  mesh.flushSelection(mode);
}

function elementSelected(mesh: BMesh, mode: SelectMode, id: number): boolean {
  if (mode === 'vertex') return mesh.verts.get(id)?.selected ?? false;
  if (mode === 'edge') return mesh.edges.get(id)?.selected ?? false;
  return mesh.faces.get(id)?.selected ?? false;
}

function applySelection(
  mesh: BMesh,
  mode: SelectMode,
  ids: readonly number[],
  options: { intent: SelectIntent; loopSelect: boolean; point?: Vec3 },
): void {
  // A replacing pick starts from an empty selection; ADD and SUBTRACT both
  // work on whatever is already there.
  if (options.intent === 'replace') mesh.deselectAll();
  const selected = options.intent !== 'subtract';

  for (const id of ids) {
    if (mode === 'vertex') {
      const vert = mesh.verts.get(id);
      if (!vert) continue;
      // Selecting stamps the click order, which is what the operators that
      // care about the order a selection was made in read.
      if (selected) mesh.selectVert(vert);
      else vert.selected = false;
    } else if (mode === 'edge') {
      const edge = mesh.edges.get(id);
      if (!edge) continue;
      const members = options.loopSelect ? selectEdgeLoop(mesh, edge) : [edge];
      for (const member of members) member.selected = selected;
    } else {
      const face = mesh.faces.get(id);
      if (!face) continue;
      const loop = options.loopSelect ? faceLoopAtClick(mesh, face, options.point) : [];
      // Empty at a triangle or an n-gon: nothing to run a loop along, so the
      // click falls back to the one face.
      for (const member of loop.length > 0 ? loop : [face]) member.selected = selected;
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
 * - The guide lines (the track a drag is confined to, and the delta along it)
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

    const tint = axisTint(controls.axis ?? null);
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
 * Drawn twice (a heavy `--void` stroke under a thin `--bone` one) because a
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

/** The ordinary arrow, drawn so badges can be hung off its tail. */
const POINTER_ARROW =
  `<path d='M3.5 2 L3.5 16.8 L7.2 13.4 L9.6 18.6 L12.2 17.4 L9.9 12.4 L14.8 12 Z' ` +
  `fill='#f4f1ea' stroke='#0b0b0b' stroke-width='1.4' stroke-linejoin='round'/>`;

/** A ring, for the whole loop an Alt+click takes rather than the one element. */
const LOOP_RING = `<ellipse cx='23' cy='7.5' rx='5' ry='3.4'/>`;

const PLUS_SIGN = `<path d='M23 19v8'/><path d='M19 23h8'/>`;
const MINUS_SIGN = `<path d='M19 23h8'/>`;

/**
 * The arrow with its marks beside it, for the selection gestures.
 *
 * The two marks answer different questions and so keep to their own halves of
 * the column beside the arrow: the ring on top says how much a click takes,
 * one element or the loop through it, and the sign below says which way that
 * goes, onto the selection or out of it. Stacked rather than side by side so
 * neither moves when the other comes and goes.
 *
 * Every mark is drawn twice, a heavy dark stroke under a thin light one, for
 * the same reason the rotate cursor is: it has to stay legible over the dark
 * viewport and over a lit surface both, and no single colour manages that.
 */
function badgedPointer(marks: string): string {
  return [
    `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>`,
    POINTER_ARROW,
    `<g fill='none' stroke='#0b0b0b' stroke-width='4.4' stroke-linecap='round'>${marks}</g>`,
    `<g fill='none' stroke='#f4f1ea' stroke-width='2.2' stroke-linecap='round'>${marks}</g>`,
    `</svg>`,
  ].join('');
}

// Hotspot on the arrow's tip, where a pick is aimed. The keyword fallbacks
// cover a browser that refuses an SVG cursor: `copy` already wears a plus,
// and nothing in the standard set means "take away" or "take the loop".
const badgedCursor = (marks: string, fallback = 'default') =>
  `url("data:image/svg+xml,${encodeURIComponent(badgedPointer(marks))}") 3 2, ${fallback}`;

export const SELECT_ADD_CURSOR = badgedCursor(PLUS_SIGN, 'copy');
export const SELECT_SUBTRACT_CURSOR = badgedCursor(MINUS_SIGN);
export const SELECT_LOOP_CURSOR = badgedCursor(LOOP_RING);
export const SELECT_ADD_LOOP_CURSOR = badgedCursor(PLUS_SIGN + LOOP_RING, 'copy');
export const SELECT_SUBTRACT_LOOP_CURSOR = badgedCursor(MINUS_SIGN + LOOP_RING);

/** The keys a pick reads, from a pointer event or from a keyboard one. */
export interface SelectModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * What the keys held during a gesture ask the selection to do.
 *
 * Shift builds on the selection and Shift+Ctrl takes away. What Shift asks for
 * is ADD, and a click then settles it against what it lands on (`clickIntent`),
 * while a region drag adds everything it touches: a region lands on selected
 * and unselected things at once, and adding is the one answer the pointer can
 * promise before the drag is drawn. Command counts as Ctrl, as it does
 * everywhere else in the bindings, and on a Mac it is the only one of the two
 * that reaches here: Ctrl+click is a right-click there and opens the cursor
 * menu instead.
 *
 * Alt is not part of this. It names an edge or face loop, and whatever it
 * names is added, removed or swapped in by the same rule as a single element.
 */
export function selectIntent(event: SelectModifiers): SelectIntent {
  if (!event.shiftKey) return 'replace';
  return event.ctrlKey || event.metaKey ? 'subtract' : 'add';
}

/**
 * Which way a click goes, once it is known whether what it landed on is
 * selected already.
 *
 * Shift is the one key for building a selection both ways: a Shift+click takes
 * in what is out and drops what is already in, for an object, a vertex, an
 * edge and a face alike. A bare click replaces and Shift+Ctrl takes away,
 * whatever is under the pointer.
 */
export function clickIntent(intent: SelectIntent, alreadySelected: boolean): SelectIntent {
  return intent === 'add' && alreadySelected ? 'subtract' : intent;
}

/** The pointer for a pick going `intent`'s way, ringed when it takes a whole loop. */
export function selectCursor(intent: SelectIntent, loop: boolean): string {
  if (intent === 'add') return loop ? SELECT_ADD_LOOP_CURSOR : SELECT_ADD_CURSOR;
  if (intent === 'subtract') return loop ? SELECT_SUBTRACT_LOOP_CURSOR : SELECT_SUBTRACT_CURSOR;
  return loop ? SELECT_LOOP_CURSOR : '';
}

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
 * - The rotate line never earns its place. A ring drag draws its own circle,
 *   and the centre handle is run by `startRotateDrag`, which puts up the same
 *   dashed line to the pointer that the R key does. Left alone the control
 *   would also show one for a merely hovered ring, before any turn has begun.
 *
 * Wrapped around `updateMatrixWorld` because that is where the control decides
 * this, and the renderer calls it on the way into every frame: visibility set
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

    const axis = controls.axis ?? '';
    // 'XYZX' and friends repeat a letter, so count the distinct ones.
    const spanned = new Set([...axis].filter((letter) => 'XYZ'.includes(letter))).size;

    if (spanned > 1) for (const guide of axisGuides) guide.visible = false;
    if (spanned === 2) for (const guide of deltaGuides) guide.visible = false;
    for (const guide of rotateGuides) guide.visible = false;
  };
}

/** An object scale as one number, for distances read in its space under a non-uniform scale. */
function meanScale(scale: Vec3): number {
  return (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3;
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
