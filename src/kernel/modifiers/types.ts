export type ModifierType = 'mirror' | 'array' | 'solidify' | 'weld' | 'subdivide';

export interface ModifierBase {
  id: string;
  name: string;
  enabled: boolean;
}

export interface MirrorModifier extends ModifierBase {
  type: 'mirror';
  axes: { x: boolean; y: boolean; z: boolean };
  merge: boolean;
  mergeThreshold: number;
  /** Snap vertices within `mergeThreshold` of the mirror plane onto it. */
  clipping: boolean;
  /** Cut the mesh at the mirror plane and keep only the positive half. */
  bisect: boolean;
}

export interface ArrayModifier extends ModifierBase {
  type: 'array';
  count: number;
  /** Offset as a fraction of the mesh bounding box, per axis. */
  relativeOffset: { x: number; y: number; z: number };
  constantOffset: { x: number; y: number; z: number };
  useRelative: boolean;
  useConstant: boolean;
  merge: boolean;
  mergeThreshold: number;
}

export interface SolidifyModifier extends ModifierBase {
  type: 'solidify';
  thickness: number;
  /** Split the thickness either side of the original surface. */
  evenOffset: boolean;
  rimFill: boolean;
}

export interface WeldModifier extends ModifierBase {
  type: 'weld';
  /** Vertices closer together than this are fused, mesh-wide. */
  threshold: number;
}

export interface SubdivideModifier extends ModifierBase {
  type: 'subdivide';
  levels: number;
  smooth: number;
}

export type Modifier =
  | MirrorModifier
  | ArrayModifier
  | SolidifyModifier
  | WeldModifier
  | SubdivideModifier;

let counter = 0;

function nextId(type: ModifierType): string {
  counter += 1;
  return `${type}-${counter}`;
}

export function createModifier(type: ModifierType): Modifier {
  switch (type) {
    case 'mirror':
      return {
        id: nextId(type),
        type,
        name: 'MIRROR',
        enabled: true,
        axes: { x: true, y: false, z: false },
        merge: true,
        mergeThreshold: 0.001,
        clipping: false,
        bisect: false,
      };
    case 'array':
      return {
        id: nextId(type),
        type,
        name: 'ARRAY',
        enabled: true,
        count: 3,
        relativeOffset: { x: 1, y: 0, z: 0 },
        constantOffset: { x: 0, y: 0, z: 0 },
        useRelative: true,
        useConstant: false,
        merge: false,
        mergeThreshold: 0.001,
      };
    case 'solidify':
      return {
        id: nextId(type),
        type,
        name: 'SOLIDIFY',
        enabled: true,
        thickness: 0.1,
        evenOffset: false,
        rimFill: true,
      };
    case 'weld':
      return {
        id: nextId(type),
        type,
        name: 'WELD',
        enabled: true,
        threshold: 0.001,
      };
    case 'subdivide':
      return {
        id: nextId(type),
        type,
        name: 'SUBDIVISION',
        enabled: true,
        levels: 1,
        smooth: 1,
      };
  }
}
