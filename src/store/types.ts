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

export type DialogId = 'export' | 'shortcuts' | 'merge' | null;

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
