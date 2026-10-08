import { DEFAULT_REMESH_SETTINGS, type RemeshSettings } from '../remesh';

import type { LatticeInterpolation } from './lattice';

export type ModifierType =
  | 'mirror'
  | 'array'
  | 'solidify'
  | 'bend'
  | 'twist'
  | 'lattice'
  | 'weld'
  | 'subdivide'
  | 'subsurf'
  | 'remesh';

export interface ModifierBase {
  id: string;
  name: string;
  enabled: boolean;
}

/** What a modifier measures from when it has a choice. */
export type ModifierOrigin = 'object' | 'cursor';

export interface MirrorModifier extends ModifierBase {
  type: 'mirror';
  axes: { x: boolean; y: boolean; z: boolean };
  /**
   * Where the mirror plane sits: through the object's own origin, or through
   * the 3D cursor. Optional because projects saved before the choice existed
   * carry no value at all, and those meshes were mirrored about the object.
   */
  origin?: ModifierOrigin;
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

/**
 * Curls the mesh around X, then Y, then Z, as three bends stacked one after
 * another would. Around each axis, the longer of the two sides square to it is
 * the one that curls, toward the other. It only moves the vertices there are:
 * a face curves as far as the loops already across it let it.
 */
export interface BendModifier extends ModifierBase {
  type: 'bend';
  /**
   * Degrees around each axis, from -360 to 360. The angle is spread over the
   * whole length that curls, so 360 closes it into a ring however long it is.
   */
  angles: { x: number; y: number; z: number };
  /** Where the bend is centred. The mesh there stays where it was. */
  origin: ModifierOrigin;
}

/**
 * Turns the mesh about X, then Y, then Z, as three twists stacked one after
 * another would. About each axis, the further along it a vertex lies, the
 * further it turns. Like the bend, it only moves the vertices there are.
 */
export interface TwistModifier extends ModifierBase {
  type: 'twist';
  /**
   * Degrees about each axis, from -1440 to 1440: how far one end of the mesh
   * turns past the other, spread evenly along its length.
   */
  angles: { x: number; y: number; z: number };
  /** The twist turns about a line through this, and the mesh level with it holds still. */
  origin: ModifierOrigin;
}

/**
 * Shapes the mesh with a cage: a grid of points around it, held by a cage
 * object of its own. Moving the cage's points in edit mode pulls the mesh
 * along with them, the parts nearest each point the furthest.
 */
export interface LatticeModifier extends ModifierBase {
  type: 'lattice';
  /**
   * The cage object, or null for none. An id that no longer names a cage, one
   * deleted since, leaves the mesh as it is rather than failing the stack.
   */
  objectId: string | null;
  interpolation: LatticeInterpolation;
  /** How much of the cage's pull reaches the mesh, from 0 to 1. */
  strength: number;
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

export interface SubsurfModifier extends ModifierBase {
  type: 'subsurf';
  levels: number;
  /** Round toward the Catmull-Clark limit surface, or only split the faces. */
  catmullClark: boolean;
}

/**
 * Rebuilds the topology wholesale: the one modifier that throws away the
 * geometry it was given rather than adding to it.
 *
 * Carries the remesher's settings record rather than a chosen subset, so every
 * control the kernel reads is one the stack can set: there is no second place
 * for a default to live and disagree with. Shading is the exception: it is a
 * property of the object, not of the rebuild, so a remesh carries across
 * whatever the object was already shaded as instead of offering its own answer.
 */
export interface RemeshModifier extends ModifierBase, Omit<RemeshSettings, 'smoothShading'> {
  type: 'remesh';
}

/** The remesher's defaults, less the shading the object owns. */
function remeshDefaults(): Omit<RemeshSettings, 'smoothShading'> {
  const { smoothShading, ...rest } = DEFAULT_REMESH_SETTINGS;
  void smoothShading;
  return rest;
}

export type Modifier =
  | MirrorModifier
  | ArrayModifier
  | SolidifyModifier
  | BendModifier
  | TwistModifier
  | LatticeModifier
  | WeldModifier
  | SubdivideModifier
  | SubsurfModifier
  | RemeshModifier;

let counter = 0;
/**
 * Which page load made an id. The counter starts again at every load, while an
 * object opened from a file keeps the modifier ids it was saved with, and two
 * modifiers sharing one would both answer every edit meant for either.
 */
const SESSION = Date.now().toString(36);

function nextId(type: ModifierType): string {
  counter += 1;
  return `${type}-${SESSION}-${counter}`;
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
        origin: 'object',
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
    case 'bend':
      return {
        id: nextId(type),
        type,
        name: 'BEND',
        enabled: true,
        angles: { x: 0, y: 0, z: 45 },
        origin: 'object',
      };
    case 'twist':
      return {
        id: nextId(type),
        type,
        name: 'TWIST',
        enabled: true,
        angles: { x: 0, y: 90, z: 0 },
        origin: 'object',
      };
    case 'lattice':
      return {
        id: nextId(type),
        type,
        name: 'LATTICE',
        enabled: true,
        objectId: null,
        interpolation: 'smooth',
        strength: 1,
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
        name: 'LOOP SUBDIVIDE',
        enabled: true,
        levels: 1,
        smooth: 0,
      };
    case 'subsurf':
      return {
        id: nextId(type),
        type,
        name: 'SUBDIVISION SURFACE',
        enabled: true,
        levels: 1,
        catmullClark: true,
      };
    case 'remesh':
      return {
        ...remeshDefaults(),
        id: nextId(type),
        type,
        name: 'REMESH',
        enabled: true,
      };
  }
}
