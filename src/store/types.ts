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

export type ToolId =
  | 'select'
  | 'move'
  | 'rotate'
  | 'scale'
  | 'extrude'
  | 'inset'
  | 'bevel'
  | 'loopcut'
  | 'merge';

export type SnapMode = 'increment' | 'vertex' | 'edge' | 'face';

export type PivotMode = 'median' | 'cursor' | 'individual' | 'active';

export type NavigationPreset = 'blender' | 'maya';

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

export interface SnapSettings {
  enabled: boolean;
  mode: SnapMode;
  increment: number;
}

export interface ProportionalSettings {
  enabled: boolean;
  radius: number;
  falloff: FalloffCurve;
}

export interface OverlaySettings {
  grid: boolean;
  axes: boolean;
  normals: boolean;
  faceOrientation: boolean;
  statistics: boolean;
  /** The 3D cursor crosshair. Hiding it does not move or disable it. */
  cursor: boolean;
}

/**
 * Where the 3D cursor could go, resolved under the pointer at right-click.
 *
 * Each is world space, or null when the click found nothing of that kind — the
 * menu disables those entries rather than hiding them, so the options stay in
 * the same place every time.
 */
export interface CursorSnapTargets {
  point: Vec3 | null;
  vertex: Vec3 | null;
  edge: Vec3 | null;
  face: Vec3 | null;
}

export interface CursorMenuState {
  /** Canvas-relative pixels; the menu anchors its top-left corner here. */
  x: number;
  y: number;
  targets: CursorSnapTargets;
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

export interface Toast {
  id: string;
  variant: 'success' | 'error' | 'warning' | 'info';
  message: string;
}

export type DialogId = 'export' | 'shortcuts' | 'merge' | 'preferences' | null;

export interface HintState {
  text: string;
  /** Viewport-relative; the host is `position: fixed` so no portal is needed. */
  x: number;
  y: number;
}

export interface LastOperator {
  name: string;
  label: string;
  params: Record<string, unknown>;
}

export interface ModalTransform {
  kind: 'move' | 'rotate' | 'scale';
  axis: 'x' | 'y' | 'z' | null;
  /** Axis excluded rather than constrained to, from Shift + axis. */
  excludeAxis: boolean;
  /** Digits typed so far for an exact numeric entry. */
  typed: string;
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
