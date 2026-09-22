import type {
  BMesh,
  FalloffCurve,
  Material,
  Modifier,
  PrimitiveKind,
  PrimitiveParams,
  SelectMode,
  Transform,
  Vec3,
} from '@kernel/index';

export type EditorMode = 'object' | 'edit';

export type ShadingMode = 'solid' | 'wireframe' | 'solidWire' | 'xray' | 'matcap';

/** What a selection drag draws: the region it sweeps is what gets picked. */
export type SelectShape = 'box' | 'circle' | 'lasso';

export type ToolId = 'select' | 'move' | 'rotate' | 'scale' | 'extrude' | 'inset' | 'loopcut';

/** What snapping measures against: the grid square itself, or a step you set. */
export type SnapMode = 'grid' | 'custom';

/**
 * What a rotation or a scale turns about.
 *
 * ORIGIN is the object's own origin, the amber square, and across a selection
 * of several it is the active object's. MEDIAN is the middle of what is
 * selected, and CURSOR the 3D cursor. Whichever is in force, the gizmo is
 * seated on it: what a turn is measured about is what you grab it by.
 */
export type PivotMode = 'origin' | 'median' | 'cursor';

export type NavigationPreset = 'blender' | 'maya';

/** A long operation's progress, for the status bar. Null when nothing is running. */
export interface OperationProgress {
  /** What is running, in the status bar's voice: "UNION", "REMESH". */
  label: string;
  /** How far along, 0 to 1. */
  value: number;
}

export interface SceneObject {
  id: string;
  name: string;
  /** The editable mesh. Modifiers are evaluated on top of it for display. */
  mesh: BMesh;
  transform: Transform;
  visible: boolean;
  locked: boolean;
  parentId: string | null;
  materials: Material[];
  modifiers: Modifier[];
  activeMaterial: number;
  /** Set while a freshly added primitive can still be re-parameterised. */
  primitive: { kind: PrimitiveKind; params: PrimitiveParams } | null;
}

/**
 * Auto merge: vertices that a transform leaves on top of each other are welded
 * into one, the way Blender's does.
 *
 * The threshold is in object space, so it means the same thing however the
 * object is scaled in the scene.
 */
export interface AutoMergeSettings {
  enabled: boolean;
  threshold: number;
}

export interface ProportionalSettings {
  enabled: boolean;
  radius: number;
  falloff: FalloffCurve;
}

/**
 * A surface the PANELS VISIBILITY preferences can hide.
 *
 * `primitives` is the panel at the head of the left column, titled PRIMITIVES
 * in object mode and SELECT in edit mode: one panel wearing two titles, so one
 * switch. The tool rail and the status bar sit in here with the panels because
 * hiding them is the same act, whatever shape the thing is.
 */
export type PanelId =
  | 'toolRail'
  | 'primitives'
  | 'object'
  | 'boolean'
  | 'operations'
  | 'loopOperations'
  | 'topology'
  | 'outliner'
  | 'properties'
  | 'modifiers'
  | 'statusBar';

export type PanelVisibility = Record<PanelId, boolean>;

export interface OverlaySettings {
  grid: boolean;
  axes: boolean;
  normals: boolean;
  faceOrientation: boolean;
  statistics: boolean;
  /** The 3D cursor crosshair. Hiding it does not move or disable it. */
  cursor: boolean;
  /** The square marking each selected object's origin. */
  origins: boolean;
}

/**
 * Where the 3D cursor could go, resolved under the pointer at right-click.
 *
 * Each is world space, or null when the click found nothing of that kind: the
 * menu disables those entries rather than hiding them, so the options stay in
 * the same place every time.
 */
export interface CursorSnapTargets {
  point: Vec3 | null;
  vertex: Vec3 | null;
  edge: Vec3 | null;
  face: Vec3 | null;
}

/** Which of them a menu entry or a shortcut is asking for. */
export type CursorSnapKind = keyof CursorSnapTargets;

export interface CursorMenuState {
  /** Canvas-relative pixels; the menu anchors its top-left corner here. */
  x: number;
  y: number;
  targets: CursorSnapTargets;
}

/**
 * Where the orbit camera is standing.
 *
 * The focus point plus the spherical offset from it, which is exactly the state
 * `CameraController` navigates in: a matrix would have to be decomposed back
 * into these to be usable. Held in the store so it survives the viewport being
 * torn down and rebuilt, which is what switching module does.
 */
export interface CameraPose {
  target: Vec3;
  radius: number;
  phi: number;
  theta: number;
}

export interface ViewportSettings {
  shading: ShadingMode;
  overlays: OverlaySettings;
  backfaceCulling: boolean;
  orthographic: boolean;
  focalLength: number;
  clipStart: number;
  clipEnd: number;
  navigation: NavigationPreset;
}

/**
 * Settings that belong to the person rather than the project.
 *
 * Persisted to localStorage as one blob and deliberately kept out of
 * `.3doo`: opening someone else's project must not repaint your viewport.
 */
export interface Preferences {
  tooltipsEnabled: boolean;
  /**
   * Which panels, the tool rail and the status bar are on screen.
   *
   * A preference rather than project state: what someone keeps out of their
   * way is how they work, and it has no business travelling to whoever opens
   * the file. What is folded shut, which `collapsedPanels` holds, does travel
   * with the scene.
   */
  panels: PanelVisibility;
  /** Width of the object-mode selection outline, in screen pixels. */
  selectionLineWidth: number;
  /** `#rrggbb`. The active object wears it; the rest of the selection a darker mix. */
  selectionLineColor: string;
  /** `#rrggbb` the viewport clears to behind the scene. */
  viewportBackground: string;
  /**
   * Whether an orbit stops when it reaches straight up or straight down.
   *
   * Off by default, so a vertical drag rolls over the pole and carries on round
   * the other side, upside down, the way a turntable does. On, the orbit holds
   * just short of the pole: the horizon never turns over, which is worth having
   * when a model is being worked on level and the view is not meant to flip.
   */
  lockVerticalOrbit: boolean;
  /**
   * Multiplier on the grid's own step, not a length: the plane rescales itself
   * by powers of ten as the camera pulls back, so a square is this many units
   * times whichever decade the zoom has settled on.
   */
  gridScale: number;
  /** How many divisions fall between two heavy lines. */
  gridSubdivisions: number;
  /**
   * Snapping: a move, a turn and a scale land on whole steps instead of
   * wherever the pointer left them.
   *
   * Kept here beside `gridScale` rather than with the tools, because the step
   * below is measured against it: they are one setting, and the top bar and the
   * preferences dialog are two views of it.
   */
  snapEnabled: boolean;
  /** Whether the steps are grid squares, or `snapStep` of one. */
  snapMode: SnapMode;
  /**
   * The custom step, as a multiple of `gridScale`, used while `snapMode` is
   * custom. 1 is one whole square, 0.1 a tenth of one.
   *
   * Kept while the mode is grid rather than reset to 1, so switching to the
   * grid and back does not cost the figure that was typed. Unlike the plane it
   * is named against it does not rescale with the zoom: a step that changed by
   * ten every time the camera pulled back could not place anything.
   */
  snapStep: number;
  /**
   * How many steps undo keeps, from `MIN_HISTORY_SIZE` to `MAX_HISTORY_SIZE`.
   *
   * A preference rather than a fixed cap because what it costs depends on the
   * scene: each step is a whole copy of it, so the same fifty steps are nothing
   * on a few boxes and hundreds of megabytes on a dense sculpt.
   */
  historySize: number;
  /** `#rrggbb` of the fine division lines, and how solid they are (0 to 1). */
  gridColor: string;
  gridOpacity: number;
  /** `#rrggbb` of the heavy line every `gridSubdivisions` divisions, and its solidity. */
  gridMajorColor: string;
  gridMajorOpacity: number;
}

/**
 * Why Frame All is asking to be clicked.
 *
 * Two ways to lose the scene and one way back from both. 'far' is the orbit
 * scrolled out past everything there is; 'stuck' is the pivot left somewhere
 * the model is not, where the wheel turns and nothing comes any closer.
 */
export type ViewLostReason = 'far' | 'stuck';

export interface Toast {
  id: string;
  variant: 'success' | 'error' | 'warning' | 'info';
  message: string;
  /**
   * How many times this exact message has been raised while it was queued.
   * Raising it again renews the toast rather than stacking a second copy.
   */
  issued: number;
}

export type DialogId = 'export' | 'shortcuts' | 'merge' | 'preferences' | 'history' | null;

export interface HintState {
  text: string;
  /** Viewport-relative; the host is `position: fixed` so no portal is needed. */
  x: number;
  y: number;
  /** Top of the anchor, so the tooltip can flip above it near the bottom of its area. */
  anchorTop: number;
}

export interface LastOperator {
  name: string;
  label: string;
  params: Record<string, unknown>;
}

export interface ModalTransform {
  kind: 'move' | 'rotate' | 'scale' | 'slide' | 'bevel' | 'inset' | 'extrude';
  /** Which kind of element a slide is moving. Absent for the other transforms. */
  element?: 'vertex' | 'edge';
  axis: 'x' | 'y' | 'z' | null;
  /** Axis excluded rather than constrained to, from Shift + axis. */
  excludeAxis: boolean;
  /** Digits typed so far for an exact numeric entry. */
  typed: string;
  /** A bevel, an inset or an extrude carries its one distance in x, as a rotation does its angle. */
  value: Vec3;
}

export interface SceneStats {
  verts: number;
  edges: number;
  faces: number;
  tris: number;
  objects: number;
  selectedVerts: number;
  selectedEdges: number;
  selectedFaces: number;
}

export type { Material, Modifier, SelectMode, Transform, Vec3 };
