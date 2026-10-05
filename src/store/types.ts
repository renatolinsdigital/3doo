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

/**
 * What a click or a region drag does with what it picked.
 *
 * Each value pulls one way only. The viewport's Shift+click toggles by
 * choosing between ADD and SUBTRACT from what it landed on, and the outliner
 * does the same from the row clicked, so by the time a pick reaches the store
 * it has already been settled.
 */
export type SelectIntent = 'replace' | 'add' | 'subtract';

export type ToolId =
  'select' | 'move' | 'rotate' | 'scale' | 'knife' | 'extrude' | 'inset' | 'loopcut';

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

/**
 * An imported binary the scene points at: at present, an image.
 *
 * The bytes are held as the `Blob` they arrived as, which is what the viewport
 * builds a texture from. Kept in one map on the store rather than on the
 * object that uses it, so a linked duplicate and an undone delete share the
 * one copy.
 */
export interface SceneAsset {
  id: string;
  /** The file's own name, as imported. */
  name: string;
  /** MIME type of the bytes: `image/png`, `image/jpeg`, `image/bmp`. */
  type: string;
  /** Natural pixel size, for the plane's proportions and the properties panel. */
  width: number;
  height: number;
  /**
   * The bytes, or null for an asset whose file could not be found on load.
   *
   * Null rather than dropping the entry: the object still says which picture it
   * wants, so a file that arrives without the image in it can say what is
   * missing instead of silently becoming a blank plane.
   */
  blob: Blob | null;
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
  /** The outliner folder this object sits in, or null when it is loose. */
  groupId: string | null;
  materials: Material[];
  modifiers: Modifier[];
  activeMaterial: number;
  /** Set while a freshly added primitive can still be re-parameterised. */
  primitive: { kind: PrimitiveKind; params: PrimitiveParams } | null;
  /**
   * The asset this object is drawn with, or null for ordinary geometry.
   *
   * An image object is a plane like any other: this only says which picture
   * goes on it, so every tool, modifier and export keeps working on it without
   * knowing images exist.
   */
  image: { assetId: string } | null;
}

/**
 * A folder in the outliner: a name and the objects that point at it.
 *
 * Visibility and the lock stay on the objects rather than being mirrored here,
 * so everything that draws or edits the scene keeps reading one flag. The
 * folder's own toggles set every member at once.
 */
export interface SceneGroup {
  id: string;
  name: string;
  /** Folded shut, hiding its members' rows. */
  collapsed: boolean;
}

/**
 * Where a moved object lands in the outliner.
 *
 * `group` is that folder's own list, at the end of it. `object` is next to
 * that row, in whatever folder the row itself sits in, which is how an object
 * leaves a folder: it lands beside a row that is not in one.
 */
export type MoveTarget =
  { kind: 'group'; groupId: string } | { kind: 'object'; objectId: string; after: boolean };

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

/** Where the edit-mode delete menu opened, in canvas-relative pixels. */
export interface DeleteMenuState {
  x: number;
  y: number;
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
  /**
   * Whether the editor keeps writing the scene as you work, as a numbered
   * `.3doo` into the `3doo-auto-saves` folder in the location the user chose.
   * Nothing of the project is kept in the browser, on or off.
   *
   * Off by default. Turning it on with no location chosen yet is the click
   * that asks for one, since a page can only be handed a folder by the user,
   * and a browser that cannot hand one over cannot turn it on at all.
   */
  autosaveEnabled: boolean;
  /**
   * How often the autosave writes, in seconds.
   *
   * A trade between how much a crash can cost and how quickly the folder fills
   * with copies, which is why it is the user's call: a few boxes cost nothing
   * to write every minute, and a dense sculpt with photographs beside it does
   * not want a new copy of itself that often.
   */
  autosaveInterval: number;
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

/**
 * One press of the keyboard orbit, from Blender's numpad.
 *
 * The four directions turn the camera by a fixed step, which is what makes
 * them worth having beside the mouse: a drag cannot land on a round angle.
 * 'opposite' is Blender's numpad 9, which walks round to the far side in one
 * go and is the only one that is not a small nudge.
 */
export type OrbitStep = 'left' | 'right' | 'up' | 'down' | 'opposite';

/**
 * What a button can ask of the modal operation in progress: make it, call it
 * off, or take back the knife's last point. Enter, Esc and Backspace do the
 * same from the keyboard.
 */
export type ModalCommand = 'confirm' | 'cancel' | 'back';

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

export type DialogId =
  | 'export'
  | 'shortcuts'
  | 'merge'
  | 'preferences'
  | 'history'
  | 'newProject'
  | 'openProject'
  | 'reload'
  | 'autosaveLocation'
  | 'script'
  | 'mcp'
  | null;

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
  kind: 'move' | 'rotate' | 'scale' | 'slide' | 'bevel' | 'inset' | 'extrude' | 'knife';
  /** Which kind of element a slide is moving. Absent for the other transforms. */
  element?: 'vertex' | 'edge';
  axis: 'x' | 'y' | 'z' | null;
  /** Axis excluded rather than constrained to, from Shift + axis. */
  excludeAxis: boolean;
  /** Digits typed so far for an exact numeric entry. */
  typed: string;
  /**
   * A bevel, an inset or an extrude carries its one distance in x, as a rotation
   * does its angle, and a knife cut how many points it has.
   */
  value: Vec3;
}

/**
 * Where the TOPOLOGY panel's slide row would leave the selection.
 *
 * Published while that row is switched on and drawn by the viewport over the
 * mesh, so where a numbered slide lands is visible before it is run. In the
 * active object's own space, which is where the geometry it was read off lives.
 */
export interface SlidePreview {
  /** Where each vertex the slide would move lands. */
  points: Vec3[];
  /** Index pairs into `points`: the selected edges, drawn where they land. */
  segments: [number, number][];
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
