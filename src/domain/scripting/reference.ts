import {
  MAX_BEND_ANGLE,
  MAX_SHARP_ANGLE,
  MAX_SMOOTHING,
  MAX_SUBSURF_LEVELS,
  MAX_TARGET_FACES,
  MAX_TWIST_ANGLE,
  MAX_VOXEL_SIZE,
  MIN_OBJECT_SIZE,
  MIN_TARGET_FACES,
  MIN_VOXEL_SIZE,
  type ModifierType,
  type PrimitiveKind,
} from '@kernel/index';

/**
 * What a script may hand a parameter, and how it is checked on the way in.
 *
 * The kernel's operators quietly fall back to a default on a value they cannot
 * read, which is right for a panel that can only ever send good ones. A script
 * can send anything, and a typo that silently ran with the default would be a
 * bug the author never hears about, so the scripting layer refuses it instead.
 */
export type ValueSpec =
  | { kind: 'number'; min?: number; max?: number }
  | { kind: 'integer'; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'string' }
  | { kind: 'enum'; values: readonly string[] }
  /**
   * `{ x, y, z }` numbers, written as `[x, y, z]` or `{ x, y, z }`. `uniform`
   * takes one number for all three, which only means something for a scale.
   */
  | { kind: 'vector'; min?: number; max?: number; uniform?: boolean }
  /** `{ x, y, z }` switches, written the same two ways. */
  | { kind: 'flags' }
  /** `"#rrggbb"`, `"#rgb"` or `[r, g, b]` from 0 to 1. */
  | { kind: 'color' }
  /** The knife's runs of points, each point checked for its kind and fields. */
  | { kind: 'knifeCuts' };

export interface FieldSpec {
  name: string;
  value: ValueSpec;
  description: string;
}

export type OperatorGroup = 'modelling' | 'cleanup' | 'topology' | 'transform' | 'selection';

/**
 * What has to be selected for an operation to have anything to work on.
 *
 * Several operations answer an empty selection with a status line and nothing
 * else, which is right for a button the panel greys out anyway. A script has
 * no panel to read, and an extrude that quietly did nothing would leave the
 * next line working on a shape that never grew, so a script checks this first
 * and stops with a reason.
 */
export interface SelectionNeed {
  of: 'verts' | 'edges' | 'faces' | 'facesOrEdges' | 'anything';
  /** How many at the least. Default 1. */
  count?: number;
  /** Exactly `count`, no more. */
  exactly?: boolean;
}

export interface OperatorSpec {
  name: string;
  group: OperatorGroup;
  /** One line: what it does and what it needs selected. */
  summary: string;
  params: readonly FieldSpec[];
  needs?: SelectionNeed;
}

const WORDS = ['no', 'one', 'two', 'three'];
const NOUNS = { verts: ['vertex', 'vertices'], edges: ['edge', 'edges'], faces: ['face', 'faces'] };

/** `at least one face`, `exactly two vertices`: what `needs` reads as in a sentence. */
export function describeNeed(need: SelectionNeed): string {
  if (need.of === 'anything') return 'something';
  if (need.of === 'facesOrEdges') return 'faces or edges';
  const count = need.count ?? 1;
  const [one, many] = NOUNS[need.of];
  const noun = count === 1 ? one : many;
  const amount = WORDS[count] ?? String(count);
  if (need.exactly) return `exactly ${amount} ${noun}`;
  return count === 1 ? `at least one ${noun}` : `${amount} or more ${noun}`;
}

const number = (min?: number, max?: number): ValueSpec => ({ kind: 'number', min, max });
const integer = (min?: number, max?: number): ValueSpec => ({ kind: 'integer', min, max });
const boolean: ValueSpec = { kind: 'boolean' };
const oneOf = (...values: string[]): ValueSpec => ({ kind: 'enum', values });

/**
 * Every modelling operation a script can run on a mesh, with its parameters.
 *
 * The names and defaults are the kernel's own (`OPERATORS` in
 * `src/kernel/commands/operators.ts`). A test holds the two lists together, so
 * an operator added there without an entry here fails the suite rather than
 * going undocumented.
 */
export const OPERATOR_SPECS: readonly OperatorSpec[] = [
  {
    name: 'extrude',
    group: 'modelling',
    needs: { of: 'facesOrEdges' },
    summary:
      'Pulls the selected faces out into new geometry, or the selected edges when no face is selected.',
    params: [
      { name: 'offset', value: number(), description: 'How far, in metres. Default 1.' },
      {
        name: 'individual',
        value: boolean,
        description: 'Extrude each face on its own rather than as one region. Default false.',
      },
      {
        name: 'alongNormals',
        value: boolean,
        description: 'Move each vertex along its own normal. Default false.',
      },
    ],
  },
  {
    name: 'inset',
    group: 'modelling',
    needs: { of: 'faces' },
    summary: 'Shrinks the selected faces inward, leaving a ring of faces around each.',
    params: [
      { name: 'thickness', value: number(0), description: 'Width of the ring. Default 0.2.' },
      {
        name: 'depth',
        value: number(),
        description: 'How far the inset face moves along its normal. Default 0.',
      },
      {
        name: 'individual',
        value: boolean,
        description: 'Inset each face on its own. Default false.',
      },
    ],
  },
  {
    name: 'bevel',
    group: 'modelling',
    needs: { of: 'edges' },
    summary: 'Rounds off the selected edges.',
    params: [
      { name: 'width', value: number(0), description: 'Width of the bevel. Default 0.2.' },
      {
        name: 'segments',
        value: integer(1, 12),
        description: 'Faces across the bevel, 1 to 12. Default 1.',
      },
      {
        name: 'clampOverlap',
        value: boolean,
        description: 'Keep the bevel from running past its neighbours. Default true.',
      },
    ],
  },
  {
    name: 'loopCut',
    group: 'modelling',
    needs: { of: 'edges' },
    summary: 'Cuts new edge loops across the ring of quads the first selected edge belongs to.',
    params: [
      { name: 'cuts', value: integer(1, 32), description: 'How many loops, 1 to 32. Default 1.' },
      {
        name: 'slide',
        value: number(-1, 1),
        description: 'Moves a single cut toward either side, from -1 to 1. Default 0.',
      },
    ],
  },
  {
    name: 'knife',
    group: 'modelling',
    summary:
      'Cuts new edges along runs of points: { kind: "vert", vert }, { kind: "edge", edge, t } or { kind: "face", face, co }. vert, edge and face are ids from mesh.verts, mesh.edges and mesh.faces; t runs from 0 at the edge\'s a end to 1 at its b end; co is a point on the face, as [x, y, z]. Leaves the cut selected.',
    params: [
      {
        name: 'cuts',
        value: { kind: 'knifeCuts' },
        description:
          'A list of runs, each a list of two or more points in the order the cut crosses them.',
      },
    ],
  },
  {
    name: 'subdivide',
    group: 'modelling',
    summary: 'Splits the selected faces into a grid, or the selected edges in edge select.',
    params: [
      { name: 'cuts', value: integer(1, 16), description: 'Cuts per edge, 1 to 16. Default 1.' },
      {
        name: 'smooth',
        value: number(0, 1),
        description: 'Rounds the result off, from 0 to 1. Default 0.',
      },
    ],
  },
  {
    name: 'relax',
    group: 'modelling',
    summary: 'Straightens and evens out a selected loop, keeping it on the surface.',
    params: [
      { name: 'factor', value: number(0, 1), description: 'Strength, from 0 to 1. Default 0.5.' },
      {
        name: 'iterations',
        value: integer(1, 50),
        description: 'Passes, 1 to 50. Default 1.',
      },
      {
        name: 'keepShape',
        value: boolean,
        description: 'Hold the loop to the surface it sits on. Default true.',
      },
    ],
  },
  {
    name: 'circle',
    group: 'modelling',
    summary: 'Rounds each selected loop onto the circle that fits it best.',
    params: [
      { name: 'factor', value: number(0, 1), description: 'Strength, from 0 to 1. Default 1.' },
    ],
  },
  {
    name: 'space',
    group: 'modelling',
    summary: 'Evens the gaps along each selected loop, leaving its shape alone.',
    params: [
      { name: 'factor', value: number(0, 1), description: 'Strength, from 0 to 1. Default 1.' },
    ],
  },
  {
    name: 'shrinkFatten',
    group: 'modelling',
    needs: { of: 'verts' },
    summary: 'Moves the selected vertices along their normals.',
    params: [{ name: 'distance', value: number(), description: 'How far. Default 0.1.' }],
  },
  {
    name: 'vertexSlide',
    group: 'modelling',
    summary: 'Runs the selected vertices along one of the edges leaving them.',
    params: [
      {
        name: 'direction',
        value: integer(1),
        description: 'Which edge, counted from 1. Default 1.',
      },
      { name: 'distance', value: number(0), description: 'How far, in metres.' },
    ],
  },
  {
    name: 'edgeSlide',
    group: 'modelling',
    summary: 'Runs the selected edges across the faces on one side of them.',
    params: [
      { name: 'direction', value: integer(1, 2), description: 'Which side, 1 or 2. Default 1.' },
      { name: 'distance', value: number(0), description: 'How far, in metres.' },
    ],
  },
  {
    name: 'setEdgeLength',
    group: 'modelling',
    summary: 'Stretches each selected edge to one length about its middle.',
    params: [{ name: 'length', value: number(0), description: 'In metres. Default 1.' }],
  },
  {
    name: 'mergeByDistance',
    group: 'cleanup',
    summary:
      'Welds vertices closer together than the threshold: the selected ones, or the whole mesh.',
    params: [{ name: 'threshold', value: number(0), description: 'In metres. Default 0.001.' }],
  },
  {
    name: 'merge',
    group: 'cleanup',
    needs: { of: 'verts', count: 2 },
    summary: 'Collapses two or more selected vertices into one.',
    params: [
      {
        name: 'mode',
        value: oneOf('center', 'cursor', 'first', 'last', 'collapse'),
        description: 'Where they meet. Default "center".',
      },
    ],
  },
  {
    name: 'delete',
    group: 'cleanup',
    needs: { of: 'anything' },
    summary: 'Deletes the selected geometry.',
    params: [
      {
        name: 'mode',
        value: oneOf('verts', 'edges', 'faces', 'onlyFaces', 'edgesAndFaces'),
        description: 'What goes. Default "verts".',
      },
    ],
  },
  {
    name: 'dissolve',
    group: 'cleanup',
    summary: 'Removes the selection and merges the faces around it, keeping the surface closed.',
    params: [
      {
        name: 'mode',
        value: oneOf('verts', 'edges', 'faces', 'limited'),
        description: 'What to dissolve. Default "edges".',
      },
      {
        name: 'angle',
        value: number(0, 180),
        description:
          'The sharpest fold, in degrees, still dissolved. Default 40, or 5 for "limited".',
      },
    ],
  },
  {
    name: 'triangulate',
    group: 'cleanup',
    summary: 'Splits the selected faces, or every face, into triangles.',
    params: [],
  },
  {
    name: 'trisToQuads',
    group: 'cleanup',
    summary: 'Joins pairs of triangles into quads where they lie flat enough.',
    params: [
      {
        name: 'angle',
        value: number(0, 180),
        description: 'The sharpest fold, in degrees, still joined. Default 40.',
      },
    ],
  },
  {
    name: 'connect',
    group: 'topology',
    needs: { of: 'verts', count: 2, exactly: true },
    summary: 'Joins exactly two selected vertices with an edge, splitting the face between them.',
    params: [],
  },
  {
    name: 'fill',
    group: 'topology',
    needs: { of: 'edges', count: 3 },
    summary: 'Fills the hole a selected boundary loop runs around.',
    params: [
      {
        name: 'bridge',
        value: boolean,
        description: 'Bridge two loops instead of capping one. Default false.',
      },
    ],
  },
  {
    name: 'bridge',
    group: 'topology',
    needs: { of: 'edges', count: 2 },
    summary: 'Joins two selected edge loops of equal length with a band of quads.',
    params: [],
  },
  {
    name: 'recalculateNormals',
    group: 'topology',
    summary: 'Turns every face to point the same way.',
    params: [
      {
        name: 'outside',
        value: boolean,
        description: 'Point them out of the shape rather than in. Default true.',
      },
    ],
  },
  {
    name: 'flipNormals',
    group: 'topology',
    summary: 'Turns the selected faces, or every face, round.',
    params: [],
  },
  {
    name: 'shade',
    group: 'topology',
    summary: 'Shades the selected faces, or every face, smooth or flat.',
    params: [
      { name: 'smooth', value: boolean, description: 'Smooth rather than flat. Default true.' },
    ],
  },
  {
    name: 'markSharp',
    group: 'topology',
    summary: 'Marks the selected edges sharp, so smooth shading keeps a crease there.',
    params: [
      { name: 'clear', value: boolean, description: 'Take the mark off instead. Default false.' },
    ],
  },
  {
    name: 'translate',
    group: 'transform',
    needs: { of: 'verts' },
    summary: 'Moves the selected vertices.',
    params: [
      { name: 'offset', value: { kind: 'vector' }, description: 'In metres, as [x, y, z].' },
    ],
  },
  {
    name: 'rotate',
    group: 'transform',
    needs: { of: 'verts' },
    summary: 'Turns the selected vertices about their middle.',
    params: [
      { name: 'axis', value: oneOf('x', 'y', 'z'), description: 'The axis. Default "y".' },
      { name: 'angle', value: number(), description: 'In degrees.' },
    ],
  },
  {
    name: 'scale',
    group: 'transform',
    needs: { of: 'verts' },
    summary: 'Scales the selected vertices about their middle.',
    params: [
      {
        name: 'scale',
        value: { kind: 'vector', uniform: true },
        description: 'Factor along each axis, as [x, y, z], or one number for all three.',
      },
    ],
  },
  {
    name: 'selectAll',
    group: 'selection',
    summary: 'Selects every element.',
    params: [],
  },
  {
    name: 'deselectAll',
    group: 'selection',
    summary: 'Clears the selection.',
    params: [],
  },
  {
    name: 'invertSelection',
    group: 'selection',
    summary: 'Selects what was not selected, and the other way round.',
    params: [],
  },
  {
    name: 'growSelection',
    group: 'selection',
    summary: 'Adds one ring of neighbours to the selection.',
    params: [],
  },
  {
    name: 'shrinkSelection',
    group: 'selection',
    summary: 'Takes the outer ring off the selection.',
    params: [],
  },
  {
    name: 'selectEdgeLoop',
    group: 'selection',
    needs: { of: 'edges', count: 2 },
    summary: 'Extends two selected edges that meet along the loops they run in.',
    params: [],
  },
  {
    name: 'selectFaceLoop',
    group: 'selection',
    needs: { of: 'faces', count: 2 },
    summary: 'Selects the loop of quads running through two adjacent selected faces.',
    params: [],
  },
];

export const PRIMITIVE_KINDS: readonly PrimitiveKind[] = [
  'cube',
  'plane',
  'circle',
  'grid',
  'uvSphere',
  'icoSphere',
  'cylinder',
  'cone',
  'capsule',
  'torus',
];

const length = number(MIN_OBJECT_SIZE);

/**
 * The shape options `scene.add` takes.
 *
 * The counts carry a ceiling the panel does not: a slider stops where the hand
 * does, while a loop can ask for a million segments, and a sphere of that many
 * takes the tab down with it before anything can refuse it.
 */
export const PRIMITIVE_OPTIONS: readonly FieldSpec[] = [
  { name: 'size', value: length, description: 'Edge length of a cube, plane or grid, in metres.' },
  { name: 'radius', value: length, description: 'From the centre to the surface, in metres.' },
  { name: 'radius2', value: length, description: 'Radius of the tube a torus sweeps.' },
  { name: 'height', value: length, description: 'Along the local Y axis, in metres.' },
  { name: 'segments', value: integer(3, 500), description: 'Divisions around, 3 to 500.' },
  { name: 'rings', value: integer(3, 500), description: 'Divisions from pole to pole, 3 to 500.' },
  {
    name: 'subdivisions',
    value: integer(0, 6),
    description: 'How often an ico sphere is split, 0 to 6.',
  },
  {
    name: 'capFill',
    value: boolean,
    description: 'Close the open ends of a circle, cylinder or cone.',
  },
];

const color: FieldSpec = {
  name: 'color',
  value: { kind: 'color' },
  description: '"#rrggbb", "#rgb" or [r, g, b] from 0 to 1.',
};

/** What any object can be named, placed and coloured with as it is added. */
export const PLACEMENT_OPTIONS: readonly FieldSpec[] = [
  { name: 'name', value: { kind: 'string' }, description: 'What the outliner calls it.' },
  {
    name: 'position',
    value: { kind: 'vector' },
    description: 'In metres. Default: the 3D cursor.',
  },
  { name: 'rotation', value: { kind: 'vector' }, description: 'In degrees about X, Y and Z.' },
  {
    name: 'scale',
    value: { kind: 'vector', uniform: true },
    description: 'Along X, Y and Z, or one number.',
  },
  { ...color, description: `Colour of its first material, ${color.description}` },
];

/** What a material slot can be made with. */
export const MATERIAL_OPTIONS: readonly FieldSpec[] = [
  { name: 'name', value: { kind: 'string' }, description: 'What the MATERIALS list calls it.' },
  { ...color, description: `Its colour, ${color.description}` },
];

const origin: FieldSpec = {
  name: 'origin',
  value: oneOf('object', 'cursor'),
  description: 'Measured from the object origin or the 3D cursor.',
};

/**
 * The settings each modifier type has, with the ranges the MODIFIERS panel
 * holds them to. `name` and `enabled` are common to all of them and checked on
 * their own.
 */
export const MODIFIER_FIELDS: Record<ModifierType, readonly FieldSpec[]> = {
  mirror: [
    { name: 'axes', value: { kind: 'flags' }, description: 'Which axes to mirror across.' },
    origin,
    { name: 'merge', value: boolean, description: 'Weld the seam between the halves.' },
    { name: 'mergeThreshold', value: number(0), description: 'How close counts as the seam.' },
    { name: 'clipping', value: boolean, description: 'Snap vertices near the plane onto it.' },
    {
      name: 'bisect',
      value: boolean,
      description: 'Keep only the positive half before mirroring.',
    },
  ],
  array: [
    {
      name: 'count',
      value: integer(1, 128),
      description: 'Copies including the original, 1 to 128.',
    },
    { name: 'useRelative', value: boolean, description: 'Offset by the size of the mesh.' },
    {
      name: 'relativeOffset',
      value: { kind: 'vector' },
      description:
        'Offset per copy as [x, y, z], in sizes of the mesh: [1, 0, 0] sets the copies side by side along X.',
    },
    { name: 'useConstant', value: boolean, description: 'Offset by a fixed distance too.' },
    {
      name: 'constantOffset',
      value: { kind: 'vector' },
      description: 'Offset per copy as [x, y, z], in metres.',
    },
    { name: 'merge', value: boolean, description: 'Weld where copies touch.' },
    { name: 'mergeThreshold', value: number(0), description: 'How close counts as touching.' },
  ],
  solidify: [
    { name: 'thickness', value: number(), description: 'How thick the shell is.' },
    { name: 'evenOffset', value: boolean, description: 'Split the thickness either side.' },
    { name: 'rimFill', value: boolean, description: 'Close the open edges of the shell.' },
  ],
  bend: [
    {
      name: 'angles',
      value: { kind: 'vector', min: -MAX_BEND_ANGLE, max: MAX_BEND_ANGLE },
      description: `Degrees to curl around X, Y and Z, from -${MAX_BEND_ANGLE} to ${MAX_BEND_ANGLE}, as [x, y, z] or { z: 90 } for one axis.`,
    },
    origin,
  ],
  twist: [
    {
      name: 'angles',
      value: { kind: 'vector', min: -MAX_TWIST_ANGLE, max: MAX_TWIST_ANGLE },
      description: `Degrees one end turns past the other about X, Y and Z, from -${MAX_TWIST_ANGLE} to ${MAX_TWIST_ANGLE}, as [x, y, z] or { y: 180 } for one axis.`,
    },
    origin,
  ],
  weld: [{ name: 'threshold', value: number(0), description: 'Vertices closer than this fuse.' }],
  subdivide: [
    { name: 'levels', value: integer(0, 3), description: 'Times to split every face, 0 to 3.' },
    { name: 'smooth', value: number(0, 1), description: 'How much to round off, 0 to 1.' },
  ],
  subsurf: [
    {
      name: 'levels',
      value: integer(0, MAX_SUBSURF_LEVELS),
      description: `Subdivision levels, 0 to ${MAX_SUBSURF_LEVELS}.`,
    },
    { name: 'catmullClark', value: boolean, description: 'Round toward a smooth surface.' },
  ],
  remesh: [
    {
      name: 'method',
      value: oneOf('voxel', 'blocks', 'decimate'),
      description: 'Contour a voxel grid, read it off blocky, or reduce.',
    },
    {
      name: 'topology',
      value: oneOf('quads', 'triangles'),
      description: 'What the result is made of.',
    },
    { name: 'adaptive', value: boolean, description: 'Aim for targetFaces instead.' },
    {
      name: 'targetFaces',
      value: integer(MIN_TARGET_FACES, MAX_TARGET_FACES),
      description: `Roughly how many faces, ${MIN_TARGET_FACES} to ${MAX_TARGET_FACES}.`,
    },
    {
      name: 'voxelSize',
      value: number(MIN_VOXEL_SIZE, MAX_VOXEL_SIZE),
      description: `Finest detail the grid holds, ${MIN_VOXEL_SIZE} to ${MAX_VOXEL_SIZE}.`,
    },
    { name: 'ratio', value: number(0.01, 1), description: 'Fraction a reduce keeps, 0.01 to 1.' },
    {
      name: 'smoothing',
      value: integer(0, MAX_SMOOTHING),
      description: `Relaxation passes, 0 to ${MAX_SMOOTHING}.`,
    },
    { name: 'projection', value: number(0, 1), description: 'Pull back onto the surface, 0 to 1.' },
    {
      name: 'sharpAngle',
      value: number(0, MAX_SHARP_ANGLE),
      description: `Creases kept above this many degrees, 0 to ${MAX_SHARP_ANGLE}.`,
    },
    { name: 'preserveBoundary', value: boolean, description: 'Leave an open border alone.' },
  ],
};

export const MODIFIER_TYPES = Object.keys(MODIFIER_FIELDS) as ModifierType[];

export type ApiOwner = 'global' | 'scene' | 'object' | 'mesh' | 'modifier' | 'material' | 'view';

/** One name a script can reach, as the editor's hover and the docs describe it. */
export interface ApiEntry {
  /** Unique, and the anchor of its row in the docs: `scene.add`, `mesh.extrude`. */
  id: string;
  owner: ApiOwner;
  /** As written in code. */
  name: string;
  kind: 'function' | 'property' | 'namespace';
  signature: string;
  summary: string;
}

/** The variable each owner is written as in the signatures and the docs. */
export const OWNER_NAMES: Record<Exclude<ApiOwner, 'global'>, string> = {
  scene: 'scene',
  object: 'object',
  mesh: 'mesh',
  modifier: 'modifier',
  material: 'material',
  view: 'view',
};

type EntrySource = Omit<ApiEntry, 'id' | 'owner' | 'signature'> & { args?: string };

function entries(owner: Exclude<ApiOwner, 'global'>, sources: readonly EntrySource[]): ApiEntry[] {
  return sources.map(({ args, ...source }) => ({
    ...source,
    id: `${owner}.${source.name}`,
    owner,
    signature:
      source.kind === 'function'
        ? `${OWNER_NAMES[owner]}.${source.name}(${args ?? ''})`
        : `${OWNER_NAMES[owner]}.${source.name}`,
  }));
}

/** How an operator reads as a signature: its parameters, or nothing to pass. */
function operatorArgs(spec: OperatorSpec): string {
  if (spec.params.length === 0) return '';
  return `{ ${spec.params.map((param) => param.name).join(', ')} }`;
}

export const API_ENTRIES: readonly ApiEntry[] = [
  {
    id: 'scene',
    owner: 'global',
    name: 'scene',
    kind: 'namespace',
    signature: 'scene',
    summary: 'The objects in the scene: add, find, select, join, cut and delete them.',
  },
  {
    id: 'view',
    owner: 'global',
    name: 'view',
    kind: 'namespace',
    signature: 'view',
    summary: 'The viewport camera and how it draws the scene.',
  },
  ...entries('scene', [
    {
      name: 'add',
      kind: 'function',
      args: 'kind, options?',
      summary: `Adds a primitive at the 3D cursor and returns it. kind is ${PRIMITIVE_KINDS.join(', ')}. options takes the shape (size, radius, segments...) and name, position, rotation, scale and color.`,
    },
    {
      name: 'addMesh',
      kind: 'function',
      args: '{ verts, faces, name?, position?, rotation?, scale?, color? }',
      summary:
        'Builds an object from your own geometry and returns it. verts lists [x, y, z] points, faces lists the vertex indices around each face, three or more per face.',
    },
    {
      name: 'objects',
      kind: 'property',
      summary: 'Every object in the scene, in the order the outliner lists them.',
    },
    {
      name: 'find',
      kind: 'function',
      args: 'name',
      summary: 'The object with that name, in any case, or null when there is none.',
    },
    {
      name: 'active',
      kind: 'property',
      summary: 'The active object, or null. Set it to an object or a name to make that one active.',
    },
    { name: 'selected', kind: 'property', summary: 'The selected objects.' },
    {
      name: 'select',
      kind: 'function',
      args: '...objects',
      summary:
        'Selects exactly these objects, given as objects or names, and makes the last one active. With none, clears the selection.',
    },
    { name: 'selectAll', kind: 'function', summary: 'Selects every object.' },
    {
      name: 'delete',
      kind: 'function',
      args: '...objects',
      summary: 'Deletes these objects, given as objects or names.',
    },
    {
      name: 'clear',
      kind: 'function',
      summary: 'Deletes every object, for a script that builds its scene from nothing.',
    },
    {
      name: 'join',
      kind: 'function',
      args: 'target, ...others',
      summary: 'Merges the others into target, which keeps its name, and returns target.',
    },
    {
      name: 'boolean',
      kind: 'function',
      args: 'op, target, ...cutters',
      summary:
        'Cuts target with the cutters, which are used up, and returns target. op is union, difference or intersect. It runs in the background: write await in front of it.',
    },
    {
      name: 'group',
      kind: 'function',
      args: 'objects, name?',
      summary:
        'Puts the objects in a new outliner folder, named name when given, and returns its name. An object is in one folder at most and folders do not nest, so group every part at once.',
    },
    {
      name: 'cursor',
      kind: 'property',
      summary:
        'Where the 3D cursor is, as { x, y, z }. Set it with [x, y, z] or { x, y, z }: new objects are added there.',
    },
    {
      name: 'name',
      kind: 'property',
      summary:
        'The project name, which saved and exported files are named after. Set it to rename.',
    },
  ]),
  ...entries('object', [
    { name: 'name', kind: 'property', summary: 'What the outliner calls it. Set it to rename.' },
    {
      name: 'position',
      kind: 'property',
      summary:
        'Where its origin is, in metres, as { x, y, z }. Set it with [x, y, z] or { x, y, z }.',
    },
    { name: 'rotation', kind: 'property', summary: 'Its rotation in degrees about X, Y and Z.' },
    {
      name: 'scale',
      kind: 'property',
      summary: 'Its scale along X, Y and Z. Set one number to scale evenly.',
    },
    { name: 'visible', kind: 'property', summary: 'Whether it is drawn.' },
    {
      name: 'locked',
      kind: 'property',
      summary: 'A locked object refuses every edit, from a script as much as by hand.',
    },
    {
      name: 'color',
      kind: 'property',
      summary:
        'Colour of its first material, as "#rrggbb". Set it with "#rrggbb", "#rgb" or [r, g, b] from 0 to 1.',
    },
    {
      name: 'stats',
      kind: 'property',
      summary: 'How many { verts, edges, faces, tris } its mesh holds, before modifiers.',
    },
    {
      name: 'bounds',
      kind: 'property',
      summary:
        'Where its shape sits in the world as drawn, modifiers and all: { min, max, size, center }, in metres. null when it has no vertices. Read it to place one part against another.',
    },
    { name: 'modifiers', kind: 'property', summary: 'Its modifier stack, top to bottom.' },
    {
      name: 'materials',
      kind: 'property',
      summary:
        'Its material slots, in order. Every face wears one; the first is the one color sets.',
    },
    {
      name: 'select',
      kind: 'function',
      args: 'add?',
      summary: 'Selects it and makes it active. Pass true to add it to the selection.',
    },
    {
      name: 'duplicate',
      kind: 'function',
      args: 'linked?',
      summary: 'Copies it and returns the copy. Pass true for a linked copy sharing this mesh.',
    },
    { name: 'delete', kind: 'function', summary: 'Removes it from the scene.' },
    {
      name: 'addModifier',
      kind: 'function',
      args: 'type, settings?',
      summary: `Adds a modifier to the bottom of its stack and returns it. type is ${MODIFIER_TYPES.join(', ')}.`,
    },
    {
      name: 'addMaterial',
      kind: 'function',
      args: '{ name?, color? }',
      summary:
        'Adds a material slot and returns it. No face wears it until mesh.assignMaterial puts some on it.',
    },
    {
      name: 'edit',
      kind: 'function',
      args: '(mesh) => { ... }',
      summary:
        'Edits its mesh: calls the function with the mesh tools, selection and every modelling operation, and returns what it returns.',
    },
    {
      name: 'applyTransform',
      kind: 'function',
      summary: 'Bakes its rotation and scale into the vertices, leaving it where it stands.',
    },
    {
      name: 'originToGeometry',
      kind: 'function',
      summary: 'Moves its origin to the middle of the mesh, leaving the shape where it is.',
    },
    { name: 'originToCursor', kind: 'function', summary: 'Moves its origin onto the 3D cursor.' },
    {
      name: 'separate',
      kind: 'function',
      summary: 'Splits its loose parts into objects of their own and returns every part.',
    },
  ]),
  ...entries('mesh', [
    {
      name: 'selectMode',
      kind: 'property',
      summary:
        'vertex, edge or face. The select calls set it for you; subdivide and invert read it.',
    },
    {
      name: 'selectVerts',
      kind: 'function',
      args: 'where?, { add }?',
      summary:
        'Selects the vertices where(v) is true for, or all of them. v has id, x, y, z, position and normal. where can also be a list of [x, y, z] points, picking the vertices on them. { add: true } keeps what was selected.',
    },
    {
      name: 'selectEdges',
      kind: 'function',
      args: 'where?, { add }?',
      summary:
        'Selects the edges where(e) is true for, or all of them. e has id, center, length, a and b, its two ends. A list of [x, y, z] points picks the edges centred on them.',
    },
    {
      name: 'selectFaces',
      kind: 'function',
      args: 'where?, { add }?',
      summary:
        'Selects the faces where(f) is true for, or all of them. f has id, center, normal, area, sides and material, the index of the slot it wears. A list of [x, y, z] points picks the faces centred on them.',
    },
    { name: 'verts', kind: 'property', summary: 'Every vertex, as selectVerts describes them.' },
    { name: 'edges', kind: 'property', summary: 'Every edge, as selectEdges describes them.' },
    { name: 'faces', kind: 'property', summary: 'Every face, as selectFaces describes them.' },
    {
      name: 'selection',
      kind: 'property',
      summary: 'How many { verts, edges, faces } are selected.',
    },
    {
      name: 'deform',
      kind: 'function',
      args: '(v) => [x, y, z]',
      summary:
        'Moves every vertex to the point the function returns for it. v is a vertex as selectVerts describes it. Returning nothing leaves that vertex where it is.',
    },
    {
      name: 'run',
      kind: 'function',
      args: 'name, params?',
      summary: 'Runs an operation by its name, the same as calling it as a method.',
    },
    {
      name: 'assignMaterial',
      kind: 'function',
      args: 'material',
      summary:
        "Puts the selected faces on one of the object's material slots, given as the material, its index or its name. Needs at least one face selected.",
    },
    ...OPERATOR_SPECS.map((spec): EntrySource => ({
      name: spec.name,
      kind: 'function',
      args: operatorArgs(spec),
      summary: spec.summary,
    })),
  ]),
  ...entries('modifier', [
    { name: 'type', kind: 'property', summary: 'Which modifier it is: mirror, bend, array...' },
    { name: 'name', kind: 'property', summary: 'What the stack calls it. Set it to rename.' },
    {
      name: 'enabled',
      kind: 'property',
      summary: 'Switches it on or off, leaving it in the stack.',
    },
    { name: 'settings', kind: 'property', summary: 'A copy of its settings.' },
    {
      name: 'set',
      kind: 'function',
      args: 'settings',
      summary:
        'Changes the settings named and leaves the rest. Nested ones such as angles and axes merge the same way.',
    },
    {
      name: 'apply',
      kind: 'function',
      summary: 'Bakes it into the mesh and takes it off the stack.',
    },
    { name: 'remove', kind: 'function', summary: 'Takes it off the stack.' },
    { name: 'moveUp', kind: 'function', summary: 'Moves it one place up the stack.' },
    { name: 'moveDown', kind: 'function', summary: 'Moves it one place down the stack.' },
  ]),
  ...entries('material', [
    {
      name: 'name',
      kind: 'property',
      summary: 'What the MATERIALS list calls it. Set it to rename.',
    },
    {
      name: 'color',
      kind: 'property',
      summary: 'Its colour, as "#rrggbb". Set it with "#rrggbb", "#rgb" or [r, g, b] from 0 to 1.',
    },
    {
      name: 'index',
      kind: 'property',
      summary: 'Its place among the slots, counted from 0: the number a face wears.',
    },
    {
      name: 'remove',
      kind: 'function',
      summary: 'Takes the slot off. Faces that wore it go back to the first slot.',
    },
  ]),
  ...entries('view', [
    { name: 'frameAll', kind: 'function', summary: 'Points the camera at the whole scene.' },
    { name: 'frameSelected', kind: 'function', summary: 'Points the camera at the selection.' },
    {
      name: 'shading',
      kind: 'property',
      summary: 'How surfaces are drawn: solid, solidWire, wireframe, xray or matcap.',
    },
    {
      name: 'orthographic',
      kind: 'property',
      summary: 'true for a camera without perspective.',
    },
  ]),
];

const BY_ID = new Map(API_ENTRIES.map((entry) => [entry.id, entry]));

export function apiEntry(id: string): ApiEntry | undefined {
  return BY_ID.get(id);
}

/** The objects reached through a global rather than through a variable. */
export const NAMESPACES: ReadonlySet<string> = new Set(['scene', 'view']);

/**
 * The entries a member name could mean, written after `receiver.`.
 *
 * After `scene.` or `view.` there is one answer. After a variable there is no
 * telling whether it holds an object, a mesh or a modifier, so every owner
 * that has the name is offered: `delete` on an object and on a mesh are both
 * real. Whether it is being called settles `scale`, the property of an object
 * and the operation of a mesh.
 */
export function memberEntries(receiver: string, name: string, called?: boolean): ApiEntry[] {
  if (NAMESPACES.has(receiver)) {
    const entry = BY_ID.get(`${receiver}.${name}`);
    return entry ? [entry] : [];
  }

  const matches = API_ENTRIES.filter(
    (entry) => entry.name === name && entry.owner !== 'global' && !NAMESPACES.has(entry.owner),
  );
  if (called === undefined) return matches;

  const kind = called ? 'function' : 'property';
  const fitting = matches.filter((entry) => entry.kind === kind);
  return fitting.length > 0 ? fitting : matches;
}

/** Every entry reachable after `receiver.`, for the completion list. */
export function membersOf(receiver: string): ApiEntry[] {
  if (NAMESPACES.has(receiver)) {
    return API_ENTRIES.filter((entry) => entry.owner === receiver);
  }
  return API_ENTRIES.filter((entry) => entry.owner !== 'global' && !NAMESPACES.has(entry.owner));
}

/** Where an entry is explained at length, in the docs module. */
export function docsHref(entry: ApiEntry): string {
  return `/docs#scripting/${entry.id}`;
}
