import type { Transform, Vec3 } from '../math';
import type { BMesh } from '../mesh';

export interface Material {
  id: string;
  name: string;
  /** Base colour as 0..1 RGB. There is no texture pipeline by design. */
  color: { r: number; g: number; b: number };
}

/** The picture on an image plane, which travels with the plane. */
export interface ExportTexture {
  /** The name the image file goes out under, unique within one export. */
  fileName: string;
  /** The image file's bytes as imported: PNG, JPEG or BMP. */
  data: Uint8Array;
}

export interface ExportObject {
  name: string;
  mesh: BMesh;
  transform: Transform;
  materials: Material[];
  /**
   * Set on an image plane. It then goes out with its UVs and a single material
   * carrying the picture, which is how the editor draws it: the image covers
   * every face, whatever the material slots say.
   */
  texture?: ExportTexture;
}

/** The material a picture travels in, named after its file. */
export function textureMaterialName(texture: ExportTexture): string {
  return texture.fileName.replace(/\.[^.]*$/, '');
}

export type UpAxis = 'y' | 'z';
export type UnitPreset = 'meters' | 'centimeters';
export type AxisPreset = 'unity' | 'unreal' | 'blender' | 'maya' | 'custom';

export interface ExportOptions {
  /** Bake the object transform into the vertex positions. */
  applyTransform: boolean;
  triangulate: boolean;
  /** Emit per-polygon-vertex normals rather than one normal per face. */
  perVertexNormals: boolean;
  upAxis: UpAxis;
  unit: UnitPreset;
  scale: number;
  preset: AxisPreset;
}

export const AXIS_PRESETS: Record<
  Exclude<AxisPreset, 'custom'>,
  Pick<ExportOptions, 'upAxis' | 'unit' | 'scale'>
> = {
  unity: { upAxis: 'y', unit: 'meters', scale: 1 },
  unreal: { upAxis: 'z', unit: 'centimeters', scale: 1 },
  blender: { upAxis: 'y', unit: 'meters', scale: 1 },
  maya: { upAxis: 'y', unit: 'centimeters', scale: 1 },
};

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  applyTransform: true,
  triangulate: false,
  perVertexNormals: true,
  upAxis: 'y',
  unit: 'meters',
  scale: 1,
  preset: 'unity',
};

export function unitScaleFactor(unit: UnitPreset): number {
  return unit === 'centimeters' ? 100 : 1;
}

/**
 * Converts a point from the editor's Y-up space into the target's.
 *
 * Z-up targets (Blender, Unreal, 3ds Max) map our +Y onto their +Z and our +Z
 * onto their -Y, which keeps handedness and leaves the model facing forward.
 */
export function convertPoint(point: Vec3, upAxis: UpAxis, scale: number): Vec3 {
  if (upAxis === 'z') {
    return { x: point.x * scale, y: -point.z * scale, z: point.y * scale };
  }
  return { x: point.x * scale, y: point.y * scale, z: point.z * scale };
}

export function convertDirection(direction: Vec3, upAxis: UpAxis): Vec3 {
  if (upAxis === 'z') return { x: direction.x, y: -direction.z, z: direction.y };
  return { ...direction };
}

export function resolveExportOptions(options: Partial<ExportOptions> = {}): ExportOptions {
  const merged = { ...DEFAULT_EXPORT_OPTIONS, ...options };
  if (merged.preset !== 'custom') {
    return { ...merged, ...AXIS_PRESETS[merged.preset] };
  }
  return merged;
}
