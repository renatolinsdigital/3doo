import {
  BMesh,
  type BooleanOp,
  type Edge,
  type Face,
  type Material,
  type Modifier,
  type ModifierType,
  type PrimitiveKind,
  type PrimitiveParams,
  type SelectMode,
  type Vec3,
  type Vert,
  PRIMITIVE_FIELDS,
  composeMatrix,
  degToRad,
  radToDeg,
  transformPoint,
  vec3,
} from '@kernel/index';
import { type SceneObject, evaluatedMesh, useEditorStore } from '@store/index';
import type { ShadingMode } from '@store/types';

import {
  type FieldSpec,
  MATERIAL_OPTIONS,
  MODIFIER_FIELDS,
  MODIFIER_TYPES,
  OPERATOR_SPECS,
  PLACEMENT_OPTIONS,
  PRIMITIVE_KINDS,
  PRIMITIVE_OPTIONS,
  type SelectionNeed,
  type ValueSpec,
  describeNeed,
} from './reference';

const store = () => useEditorStore.getState();

const SELECT_MODES: readonly SelectMode[] = ['vertex', 'edge', 'face'];
const BOOLEAN_OPS: readonly BooleanOp[] = ['union', 'difference', 'intersect'];
const SHADING_MODES: readonly ShadingMode[] = ['solid', 'solidWire', 'wireframe', 'xray', 'matcap'];

// ------------------------------------------------------------------ reading

/** A value as an error message can quote it, kept short enough to read. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') return 'a function';
  if (Array.isArray(value)) {
    const shown = `[${value.map(describe).join(', ')}]`;
    return shown.length > 40 ? `a list of ${value.length}` : shown;
  }
  if (value !== null && typeof value === 'object') return 'an object';
  return String(value);
}

/** How many single-character edits apart two names are. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length];
}

/** ` Did you mean "add"?`, when one of `known` is a near miss, or nothing. */
export function suggestion(name: string, known: readonly string[]): string {
  let best: string | null = null;
  let bestDistance = Math.max(2, Math.floor(name.length / 3)) + 1;
  for (const candidate of known) {
    const d = distance(name, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best ? ` Did you mean "${best}"?` : '';
}

const quoted = (values: readonly string[]) => values.map((value) => `"${value}"`).join(', ');

function readEnum<T extends string>(value: unknown, values: readonly T[], what: string): T {
  if (typeof value === 'string') {
    const match = values.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
    if (match) return match;
    throw new Error(
      `${what} has to be one of ${quoted(values)}, not "${value}".${suggestion(value, values)}`,
    );
  }
  throw new Error(`${what} has to be one of ${quoted(values)}, not ${describe(value)}.`);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A point or a direction, written as `[x, y, z]` or `{ x, y, z }`.
 *
 * An object may leave axes out when there is a value to fill them from, which
 * is what lets `{ z: 90 }` turn one axis of a bend and leave the other two.
 */
export function readVector(value: unknown, what: string, fill?: Vec3, uniform = false): Vec3 {
  if (uniform && finite(value)) return vec3(value, value, value);

  if (Array.isArray(value) && value.length === 3 && value.every(finite)) {
    return vec3(value[0], value[1], value[2]);
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const point = value as Record<string, unknown>;
    const axis = (key: 'x' | 'y' | 'z') => {
      if (point[key] === undefined && fill) return fill[key];
      if (finite(point[key])) return point[key];
      throw new Error(`${what}.${key} has to be a number, not ${describe(point[key])}.`);
    };
    return vec3(axis('x'), axis('y'), axis('z'));
  }

  const forms = uniform ? '[x, y, z], { x, y, z } or one number' : '[x, y, z] or { x, y, z }';
  throw new Error(`${what} has to be ${forms}, not ${describe(value)}.`);
}

function readFlags(value: unknown, what: string, fill: { x: boolean; y: boolean; z: boolean }) {
  if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'boolean')) {
    return { x: value[0] as boolean, y: value[1] as boolean, z: value[2] as boolean };
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const flags = value as Record<string, unknown>;
    const axis = (key: 'x' | 'y' | 'z') => {
      if (flags[key] === undefined) return fill[key];
      if (typeof flags[key] === 'boolean') return flags[key];
      throw new Error(`${what}.${key} has to be true or false, not ${describe(flags[key])}.`);
    };
    return { x: axis('x'), y: axis('y'), z: axis('z') };
  }
  throw new Error(`${what} has to be [x, y, z] or { x, y, z } of true and false.`);
}

function inRange(value: number, spec: { min?: number; max?: number }, what: string): number {
  const { min, max } = spec;
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    const range =
      min !== undefined && max !== undefined
        ? `from ${min} to ${max}`
        : min !== undefined
          ? `${min} or more`
          : `${max} or less`;
    throw new Error(`${what} has to be ${range}, not ${value}.`);
  }
  return value;
}

/** One value checked against its spec, with `current` filling what it leaves out. */
function readValue(spec: ValueSpec, value: unknown, what: string, current?: unknown): unknown {
  switch (spec.kind) {
    case 'number':
      if (!finite(value)) throw new Error(`${what} has to be a number, not ${describe(value)}.`);
      return inRange(value, spec, what);
    case 'integer':
      if (!finite(value) || !Number.isInteger(value)) {
        throw new Error(`${what} has to be a whole number, not ${describe(value)}.`);
      }
      return inRange(value, spec, what);
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error(`${what} has to be true or false, not ${describe(value)}.`);
      }
      return value;
    case 'string':
      if (typeof value !== 'string') {
        throw new Error(`${what} has to be text, not ${describe(value)}.`);
      }
      return value;
    case 'enum':
      return readEnum(value, spec.values, what);
    case 'vector': {
      const vector = readVector(value, what, current as Vec3 | undefined, spec.uniform);
      for (const axis of ['x', 'y', 'z'] as const) inRange(vector[axis], spec, `${what}.${axis}`);
      return vector;
    }
    case 'flags':
      return readFlags(
        value,
        what,
        (current as { x: boolean; y: boolean; z: boolean }) ?? {
          x: false,
          y: false,
          z: false,
        },
      );
    case 'color':
      // Checked here so a bad colour is reported against the option that
      // carried it; the setter it is handed to reads it again.
      readColor(value, what);
      return value;
    case 'knifeCuts':
      return readKnifeCuts(value, what);
  }
}

function readId(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${what} has to be an id from the mesh, not ${describe(value)}.`);
  }
  return value;
}

/**
 * The knife's runs, checked point by point.
 *
 * The kernel drops a point it cannot read and cuts with the rest, which is
 * right for the viewport's own clicks. A script that wrote `co: [x, y, z]`
 * would lose that point without a word, so here it is read the way every
 * other point in the API is, and anything else is refused.
 */
function readKnifeCuts(value: unknown, what: string): unknown[][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${what} has to be a list of runs, each a list of points.`);
  }
  return value.map((run, r) => {
    if (!Array.isArray(run) || run.length < 2) {
      throw new Error(`${what}[${r}] has to be a list of two or more points.`);
    }
    return run.map((point: unknown, p) => {
      const at = `${what}[${r}][${p}]`;
      if (point === null || typeof point !== 'object' || Array.isArray(point)) {
        throw new Error(`${at} has to be { kind, ... }, not ${describe(point)}.`);
      }
      const fields = point as Record<string, unknown>;
      switch (fields.kind) {
        case 'vert':
          return { kind: 'vert', vert: readId(fields.vert, `${at}.vert`) };
        case 'edge': {
          if (!finite(fields.t)) throw new Error(`${at}.t has to be a number from 0 to 1.`);
          return {
            kind: 'edge',
            edge: readId(fields.edge, `${at}.edge`),
            t: inRange(fields.t, { min: 0, max: 1 }, `${at}.t`),
          };
        }
        case 'face':
          return {
            kind: 'face',
            face: readId(fields.face, `${at}.face`),
            co: readVector(fields.co, `${at}.co`),
          };
        default:
          throw new Error(
            `${at}.kind has to be "vert", "edge" or "face", not ${describe(fields.kind)}.`,
          );
      }
    });
  });
}

/**
 * Reads an options object against the fields it may hold.
 *
 * A name the fields do not know is refused rather than ignored: `ofset: 2`
 * running at the default offset is the bug a script author never finds.
 */
export function readFields(
  what: string,
  fields: readonly FieldSpec[],
  input: unknown,
  current: Record<string, unknown> = {},
): Record<string, unknown> {
  if (input === undefined) return {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${what} takes its options as { name: value }, not ${describe(input)}.`);
  }

  const names = fields.map((field) => field.name);
  const read: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = fields.find((candidate) => candidate.name === key);
    if (!field) {
      const takes = names.length > 0 ? `It takes ${names.join(', ')}.` : 'It takes none.';
      throw new Error(`${what} has no option "${key}".${suggestion(key, names)} ${takes}`);
    }
    if (value === undefined) continue;
    read[key] = readValue(field.value, value, `${what}: ${key}`, current[key]);
  }
  return read;
}

/** `"#rrggbb"`, `"#rgb"` or `[r, g, b]` from 0 to 1, as the material colour it means. */
function readColor(value: unknown, what: string): { r: number; g: number; b: number } {
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '');
    const full = /^[0-9a-f]{3}$/i.test(hex) ? [...hex].map((c) => c + c).join('') : hex;
    if (/^[0-9a-f]{6}$/i.test(full)) {
      return {
        r: parseInt(full.slice(0, 2), 16) / 255,
        g: parseInt(full.slice(2, 4), 16) / 255,
        b: parseInt(full.slice(4, 6), 16) / 255,
      };
    }
  }
  if (Array.isArray(value) && value.length === 3 && value.every(finite)) {
    const [r, g, b] = value.map((channel) => inRange(channel, { min: 0, max: 1 }, what));
    return { r, g, b };
  }
  throw new Error(
    `${what} has to be "#rrggbb", "#rgb" or [r, g, b] from 0 to 1, not ${describe(value)}.`,
  );
}

function toHex(color: { r: number; g: number; b: number }): string {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

// -------------------------------------------------------------- the scene

/** The object behind an id, or why a script can no longer reach it. */
function sceneObject(id: string, lastName: string): SceneObject {
  const object = store().objects.find((candidate) => candidate.id === id);
  if (!object) throw new Error(`${lastName} is no longer in the scene.`);
  return object;
}

function unlocked(object: SceneObject): SceneObject {
  if (object.locked) throw new Error(`${object.name} is locked: set locked = false to edit it.`);
  return object;
}

function soleUser(object: SceneObject): SceneObject {
  if (store().objects.some((other) => other.id !== object.id && other.mesh === object.mesh)) {
    throw new Error(
      `${object.name} shares its mesh with a linked copy, and this would change both.`,
    );
  }
  return object;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  center: Vec3;
}

/**
 * The world-space box around the shapes of `objects` as drawn, modifiers and
 * all, or null when none of them has a vertex.
 */
export function worldBounds(objects: readonly SceneObject[]): Bounds | null {
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (const object of objects) {
    const matrix = composeMatrix(object.transform);
    for (const vert of evaluatedMesh(object).verts.values()) {
      const p = transformPoint(matrix, vert.co);
      if (!min || !max) {
        min = { ...p };
        max = { ...p };
        continue;
      }
      min = vec3(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z));
      max = vec3(Math.max(max.x, p.x), Math.max(max.y, p.y), Math.max(max.z, p.z));
    }
  }
  if (!min || !max) return null;
  return {
    min,
    max,
    size: vec3(max.x - min.x, max.y - min.y, max.z - min.z),
    center: vec3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2),
  };
}

/**
 * Runs a store action that works on the active object against `id` instead.
 *
 * The active object is put back afterwards, so editing one object from a
 * script does not quietly change which one the panels are showing. An action
 * that made another object active on purpose, as a duplicate does, keeps it.
 */
function onObject<T>(id: string, work: () => T): T {
  const before = store().activeObjectId;
  if (before === id) return work();

  useEditorStore.setState({ activeObjectId: id });
  try {
    return work();
  } finally {
    const state = store();
    const stillThere = before !== null && state.objects.some((object) => object.id === before);
    if (state.activeObjectId === id && stillThere)
      useEditorStore.setState({ activeObjectId: before });
  }
}

/**
 * Throws on a write to a name the target does not have.
 *
 * A typo on assignment, `cube.positon = [0, 1, 0]`, would otherwise make a new
 * property that nothing reads, and the script would run and do nothing.
 */
function guarded<T extends object>(target: T, label: string, reads = false): T {
  const chain = () => {
    const links: object[] = [];
    for (let link: object | null = target; link && link !== Object.prototype;) {
      links.push(link);
      link = Object.getPrototypeOf(link);
    }
    return links;
  };
  const known = () => [
    ...new Set(
      chain()
        .flatMap((link) => Object.getOwnPropertyNames(link))
        .filter((name) => name !== 'constructor'),
    ),
  ];
  const readOnly = (key: string) => {
    for (const link of chain()) {
      const descriptor = Object.getOwnPropertyDescriptor(link, key);
      if (descriptor) return Boolean(descriptor.get && !descriptor.set);
    }
    return false;
  };

  return new Proxy(target, {
    set(object, key, value, receiver) {
      if (typeof key === 'string' && !(key in object)) {
        throw new Error(`${label} has no property "${key}".${suggestion(key, known())}`);
      }
      if (typeof key === 'string' && readOnly(key)) {
        throw new Error(`${label}.${key} can be read but not set.`);
      }
      return Reflect.set(object, key, value, receiver);
    },
    get(object, key, receiver) {
      if (reads && typeof key === 'string' && !(key in object) && !IGNORED_READS.has(key)) {
        throw new Error(
          `${label}.${key} is not part of the scripting API.${suggestion(key, known())}`,
        );
      }
      return Reflect.get(object, key, receiver);
    },
  });
}

/** What the language and the tools around it look for on any object, unasked. */
const IGNORED_READS = new Set(['then', 'toJSON', 'asymmetricMatch', 'nodeType', '$$typeof']);

export interface VertInfo {
  id: number;
  x: number;
  y: number;
  z: number;
  position: Vec3;
  normal: Vec3;
  selected: boolean;
}

export interface EdgeInfo {
  id: number;
  a: Vec3;
  b: Vec3;
  center: Vec3;
  length: number;
  selected: boolean;
}

export interface FaceInfo {
  id: number;
  center: Vec3;
  normal: Vec3;
  area: number;
  sides: number;
  /** The index of the material slot it wears. */
  material: number;
  selected: boolean;
}

function vertInfo(vert: Vert): VertInfo {
  const { x, y, z } = vert.co;
  return {
    id: vert.id,
    x,
    y,
    z,
    position: vec3(x, y, z),
    normal: { ...vert.normal },
    selected: vert.selected,
  };
}

function edgeInfo(mesh: BMesh, edge: Edge): EdgeInfo {
  const a = { ...edge.v0.co };
  const b = { ...edge.v1.co };
  return {
    id: edge.id,
    a,
    b,
    center: mesh.edgeCenter(edge),
    length: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
    selected: edge.selected,
  };
}

function faceInfo(mesh: BMesh, face: Face): FaceInfo {
  return {
    id: face.id,
    center: mesh.faceCenter(face),
    normal: { ...face.normal },
    area: mesh.faceArea(face),
    sides: mesh.faceLoopCount(face),
    material: face.materialIndex,
    selected: face.selected,
  };
}

/** A material slot named by a script: the material, its index or its name. */
function readSlot(object: SceneObject, value: unknown, what: string): number {
  const { materials } = object;
  if (value instanceof MaterialHandle) {
    const index = materials.findIndex((material) => material.id === value.id);
    if (index < 0) throw new Error(`${what}: that material belongs to another object.`);
    return index;
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value < materials.length) return value;
    const range = materials.length === 0 ? 'and it has none' : `from 0 to ${materials.length - 1}`;
    throw new Error(`${what}: ${object.name} has material slots ${range}, not ${value}.`);
  }
  if (typeof value === 'string') {
    const names = materials.map((material) => material.name);
    const index = names.findIndex((name) => name.toLowerCase() === value.toLowerCase());
    if (index >= 0) return index;
    throw new Error(
      `${what}: ${object.name} has no material called "${value}".${suggestion(value, names)}`,
    );
  }
  throw new Error(`${what} takes a material, its index or its name, not ${describe(value)}.`);
}

function readWhere<T>(where: unknown, what: string): ((info: T) => unknown) | null {
  if (where === undefined || where === null) return null;
  if (typeof where !== 'function') {
    throw new Error(`${what} takes a function that says which to select, not ${describe(where)}.`);
  }
  return where as (info: T) => unknown;
}

function readAdd(options: unknown, what: string): boolean {
  const read = readFields(
    what,
    [{ name: 'add', value: { kind: 'boolean' }, description: '' }],
    options,
  );
  return read.add === true;
}

const OPERATOR_NAMES = OPERATOR_SPECS.map((spec) => spec.name);

function satisfies(mesh: BMesh, need: SelectionNeed): boolean {
  const { selectedVerts, selectedEdges, selectedFaces } = mesh.stats();
  const count = need.count ?? 1;
  if (need.of === 'anything') return selectedVerts + selectedEdges + selectedFaces > 0;
  if (need.of === 'facesOrEdges') return selectedFaces > 0 || selectedEdges > 0;
  const selected = { verts: selectedVerts, edges: selectedEdges, faces: selectedFaces }[need.of];
  return need.exactly ? selected === count : selected >= count;
}

/** What `object.edit` hands its function. Every operation is a method on it too. */
export interface MeshTools {
  selectMode: SelectMode;
  readonly verts: VertInfo[];
  readonly edges: EdgeInfo[];
  readonly faces: FaceInfo[];
  readonly selection: { verts: number; edges: number; faces: number };
  selectVerts(where?: (vert: VertInfo) => unknown, options?: { add?: boolean }): number;
  selectEdges(where?: (edge: EdgeInfo) => unknown, options?: { add?: boolean }): number;
  selectFaces(where?: (face: FaceInfo) => unknown, options?: { add?: boolean }): number;
  deform(move: (vert: VertInfo) => unknown): number;
  assignMaterial(material: unknown): number;
  run(name: string, params?: Record<string, unknown>): string;
  [operation: string]: unknown;
}

function meshTools(objectId: string, lastName: string, startMode: SelectMode): MeshTools {
  let mode = startMode;
  const mesh = () => sceneObject(objectId, lastName).mesh;
  const touched = () => store().touchMesh();

  const run = (name: unknown, params?: unknown): string => {
    if (typeof name !== 'string')
      throw new Error(`mesh.run takes an operation's name, not ${describe(name)}.`);
    const spec = OPERATOR_SPECS.find((candidate) => candidate.name === name);
    if (!spec) {
      throw new Error(`There is no operation "${name}".${suggestion(name, OPERATOR_NAMES)}`);
    }
    const read = readFields(`mesh.${name}`, spec.params, params);
    unlocked(sceneObject(objectId, lastName));
    if (spec.needs && !satisfies(mesh(), spec.needs)) {
      throw new Error(`mesh.${name} needs ${describeNeed(spec.needs)} selected first.`);
    }

    return onObject(objectId, () => {
      const state = store();
      const saved = { selectMode: state.selectMode, proportional: state.proportional };
      // The operation reads the select mode off the store, and a script's
      // result should not hang on whether proportional editing was left on.
      useEditorStore.setState({
        selectMode: mode,
        proportional: { ...state.proportional, enabled: false },
      });
      try {
        return store().exec(name, read, name, { record: false, throws: true })?.status ?? '';
      } finally {
        useEditorStore.setState(saved);
      }
    });
  };

  const tools: Record<string, unknown> = {
    run,
    selectVerts(where?: unknown, options?: unknown) {
      const test = readWhere<VertInfo>(where, 'mesh.selectVerts');
      const add = readAdd(options, 'mesh.selectVerts');
      const target = mesh();
      if (!add) target.deselectAll();
      let count = 0;
      for (const vert of target.verts.values()) {
        if (test && !test(vertInfo(vert))) continue;
        target.selectVert(vert);
        count++;
      }
      target.flushSelection('vertex');
      mode = 'vertex';
      touched();
      return count;
    },
    selectEdges(where?: unknown, options?: unknown) {
      const test = readWhere<EdgeInfo>(where, 'mesh.selectEdges');
      const add = readAdd(options, 'mesh.selectEdges');
      const target = mesh();
      if (!add) target.deselectAll();
      let count = 0;
      for (const edge of target.edges.values()) {
        if (test && !test(edgeInfo(target, edge))) continue;
        edge.selected = true;
        count++;
      }
      target.flushSelection('edge');
      mode = 'edge';
      touched();
      return count;
    },
    selectFaces(where?: unknown, options?: unknown) {
      const test = readWhere<FaceInfo>(where, 'mesh.selectFaces');
      const add = readAdd(options, 'mesh.selectFaces');
      const target = mesh();
      if (!add) target.deselectAll();
      let count = 0;
      for (const face of target.faces.values()) {
        if (test && !test(faceInfo(target, face))) continue;
        face.selected = true;
        count++;
      }
      target.flushSelection('face');
      mode = 'face';
      touched();
      return count;
    },
    deform(move: unknown) {
      if (typeof move !== 'function') {
        throw new Error('mesh.deform takes a function that returns where each vertex goes.');
      }
      unlocked(sceneObject(objectId, lastName));
      const target = mesh();
      let moved = 0;
      for (const vert of target.verts.values()) {
        const next = move(vertInfo(vert));
        if (next === undefined || next === null) continue;
        vert.co = readVector(next, `mesh.deform: vertex ${vert.id}`);
        moved++;
      }
      target.computeNormals();
      // The primitive's parameters would rebuild the shape over the move.
      onObject(objectId, () => store().patchActiveObject({ primitive: null }));
      return moved;
    },
    assignMaterial(material: unknown) {
      const object = unlocked(sceneObject(objectId, lastName));
      const slot = readSlot(object, material, 'mesh.assignMaterial');
      const faces = mesh().selectedFaces();
      if (faces.length === 0) {
        throw new Error('mesh.assignMaterial needs at least one face selected first.');
      }
      for (const face of faces) face.materialIndex = slot;
      // As ASSIGN does: the primitive's parameters would rebuild the faces and
      // lose what they wear.
      onObject(objectId, () => store().patchActiveObject({ primitive: null }));
      return faces.length;
    },
  };

  for (const spec of OPERATOR_SPECS) {
    tools[spec.name] = (params?: unknown) => run(spec.name, params);
  }

  Object.defineProperties(tools, {
    selectMode: {
      get: () => mode,
      set: (value: unknown) => {
        mode = readEnum(value, SELECT_MODES, 'mesh.selectMode');
      },
      enumerable: true,
    },
    verts: { get: () => [...mesh().verts.values()].map(vertInfo), enumerable: true },
    edges: {
      get: () => {
        const target = mesh();
        return [...target.edges.values()].map((edge) => edgeInfo(target, edge));
      },
      enumerable: true,
    },
    faces: {
      get: () => {
        const target = mesh();
        return [...target.faces.values()].map((face) => faceInfo(target, face));
      },
      enumerable: true,
    },
    selection: {
      get: () => {
        const { selectedVerts, selectedEdges, selectedFaces } = mesh().stats();
        return { verts: selectedVerts, edges: selectedEdges, faces: selectedFaces };
      },
      enumerable: true,
    },
  });

  return guarded(tools as MeshTools, 'mesh', true);
}

export class ModifierHandle {
  constructor(
    private readonly objectId: string,
    readonly id: string,
    private lastName: string,
  ) {}

  private get modifier(): Modifier {
    const object = sceneObject(this.objectId, this.lastName);
    const modifier = object.modifiers.find((candidate) => candidate.id === this.id);
    if (!modifier) throw new Error(`That modifier is no longer on ${object.name}.`);
    return modifier;
  }

  private update(patch: Partial<Modifier>): void {
    unlocked(sceneObject(this.objectId, this.lastName));
    onObject(this.objectId, () => store().updateModifier(this.id, patch));
  }

  get type(): ModifierType {
    return this.modifier.type;
  }

  get name(): string {
    return this.modifier.name;
  }

  set name(value: string) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`modifier.name has to be some text, not ${describe(value)}.`);
    }
    this.update({ name: value });
  }

  get enabled(): boolean {
    return this.modifier.enabled;
  }

  set enabled(value: boolean) {
    if (typeof value !== 'boolean') {
      throw new Error(`modifier.enabled has to be true or false, not ${describe(value)}.`);
    }
    this.update({ enabled: value });
  }

  get settings(): Record<string, unknown> {
    const { id, type, ...settings } = structuredClone(this.modifier);
    void id;
    void type;
    return settings;
  }

  set(settings: unknown): this {
    const modifier = this.modifier;
    const fields: FieldSpec[] = [
      { name: 'name', value: { kind: 'string' }, description: '' },
      { name: 'enabled', value: { kind: 'boolean' }, description: '' },
      ...MODIFIER_FIELDS[modifier.type],
    ];
    const patch = readFields(
      `${modifier.type} modifier`,
      fields,
      settings,
      modifier as unknown as Record<string, unknown>,
    );
    this.update(patch as Partial<Modifier>);
    return this;
  }

  apply(): void {
    const object = soleUser(unlocked(sceneObject(this.objectId, this.lastName)));
    const id = this.modifier.id;
    onObject(object.id, () => store().applyModifierToMesh(id));
  }

  remove(): void {
    unlocked(sceneObject(this.objectId, this.lastName));
    const id = this.modifier.id;
    onObject(this.objectId, () => store().removeModifier(id));
  }

  moveUp(): void {
    unlocked(sceneObject(this.objectId, this.lastName));
    onObject(this.objectId, () => store().moveModifier(this.modifier.id, -1));
  }

  moveDown(): void {
    unlocked(sceneObject(this.objectId, this.lastName));
    onObject(this.objectId, () => store().moveModifier(this.modifier.id, 1));
  }

  toString(): string {
    return `Modifier(${this.modifier.name})`;
  }
}

/**
 * One material slot of one object, followed by its id rather than its place:
 * removing an earlier slot renumbers the rest, and the handle still means the
 * same material afterwards.
 */
export class MaterialHandle {
  constructor(
    private readonly objectId: string,
    readonly id: string,
    private lastName: string,
  ) {}

  private get slot(): number {
    const object = sceneObject(this.objectId, this.lastName);
    const index = object.materials.findIndex((candidate) => candidate.id === this.id);
    if (index < 0) throw new Error(`That material is no longer on ${object.name}.`);
    return index;
  }

  private get material(): Material {
    return sceneObject(this.objectId, this.lastName).materials[this.slot];
  }

  private update(patch: Partial<Material>): void {
    unlocked(sceneObject(this.objectId, this.lastName));
    const slot = this.slot;
    onObject(this.objectId, () => store().updateMaterial(slot, patch));
  }

  get index(): number {
    return this.slot;
  }

  get name(): string {
    return this.material.name;
  }

  set name(value: string) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`material.name has to be some text, not ${describe(value)}.`);
    }
    this.update({ name: value });
  }

  get color(): string {
    return toHex(this.material.color);
  }

  set color(value: unknown) {
    this.update({ color: readColor(value, 'material.color') });
  }

  remove(): void {
    unlocked(sceneObject(this.objectId, this.lastName));
    const slot = this.slot;
    onObject(this.objectId, () => store().removeMaterial(slot));
  }

  toString(): string {
    return `Material(${this.material.name})`;
  }
}

export class ObjectHandle {
  private lastName: string;

  constructor(
    readonly id: string,
    private readonly handles: Handles,
  ) {
    this.lastName = sceneObject(id, 'That object').name;
  }

  private get object(): SceneObject {
    const object = sceneObject(this.id, this.lastName);
    this.lastName = object.name;
    return object;
  }

  private transform(patch: Partial<SceneObject['transform']>): void {
    unlocked(this.object);
    store().setObjectTransform(this.id, patch);
  }

  get name(): string {
    return this.object.name;
  }

  set name(value: string) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`object.name has to be some text, not ${describe(value)}.`);
    }
    store().renameObject(this.object.id, value);
    this.lastName = value;
  }

  get position(): Vec3 {
    return { ...this.object.transform.position };
  }

  set position(value: unknown) {
    this.transform({ position: readVector(value, 'position') });
  }

  get rotation(): Vec3 {
    const { x, y, z } = this.object.transform.rotation;
    return vec3(radToDeg(x), radToDeg(y), radToDeg(z));
  }

  set rotation(value: unknown) {
    const degrees = readVector(value, 'rotation');
    this.transform({
      rotation: vec3(degToRad(degrees.x), degToRad(degrees.y), degToRad(degrees.z)),
    });
  }

  get scale(): Vec3 {
    return { ...this.object.transform.scale };
  }

  set scale(value: unknown) {
    this.transform({ scale: readVector(value, 'scale', undefined, true) });
  }

  get visible(): boolean {
    return this.object.visible;
  }

  set visible(value: boolean) {
    if (typeof value !== 'boolean') {
      throw new Error(`object.visible has to be true or false, not ${describe(value)}.`);
    }
    if (this.object.visible !== value) store().toggleObjectVisibility(this.id);
  }

  get locked(): boolean {
    return this.object.locked;
  }

  set locked(value: boolean) {
    if (typeof value !== 'boolean') {
      throw new Error(`object.locked has to be true or false, not ${describe(value)}.`);
    }
    if (this.object.locked !== value) store().toggleObjectLock(this.id);
  }

  get color(): string | null {
    const material = this.object.materials[0];
    return material ? toHex(material.color) : null;
  }

  set color(value: unknown) {
    const color = readColor(value, 'color');
    const object = unlocked(this.object);
    onObject(this.id, () => {
      if (object.materials.length === 0) store().addMaterial();
      store().updateMaterial(0, { color });
    });
  }

  get stats(): { verts: number; edges: number; faces: number; tris: number } {
    const { verts, edges, faces, tris } = this.object.mesh.stats();
    return { verts, edges, faces, tris };
  }

  get bounds(): Bounds | null {
    return worldBounds([this.object]);
  }

  get modifiers(): ModifierHandle[] {
    const object = this.object;
    return object.modifiers.map((modifier) => this.handles.modifier(object, modifier.id));
  }

  get materials(): MaterialHandle[] {
    const object = this.object;
    return object.materials.map((material) => this.handles.material(object, material.id));
  }

  select(add: unknown = false): this {
    if (typeof add !== 'boolean') {
      throw new Error(`object.select takes true to add to the selection, not ${describe(add)}.`);
    }
    store().setActiveObject(this.object.id, add ? 'add' : 'replace');
    return this;
  }

  duplicate(linked: unknown = false): ObjectHandle {
    if (typeof linked !== 'boolean') {
      throw new Error(`object.duplicate takes true for a linked copy, not ${describe(linked)}.`);
    }
    store().selectObjects([this.object.id]);
    store().duplicateSelected(linked);
    const copy = store().activeObjectId;
    if (!copy || copy === this.id) throw new Error(`${this.lastName} could not be copied.`);
    return this.handles.object(copy);
  }

  delete(): void {
    store().deleteSelected([this.object.id]);
  }

  addModifier(type: unknown, settings?: unknown): ModifierHandle {
    const kind = readEnum(type, MODIFIER_TYPES, 'object.addModifier: type');
    const object = unlocked(this.object);
    onObject(this.id, () => store().addModifier(kind));
    const added = this.object.modifiers[this.object.modifiers.length - 1];
    const handle = this.handles.modifier(object, added.id);
    if (settings !== undefined) handle.set(settings);
    return handle;
  }

  addMaterial(options?: unknown): MaterialHandle {
    const read = readFields('object.addMaterial', MATERIAL_OPTIONS, options);
    const object = unlocked(this.object);
    onObject(this.id, () => store().addMaterial());
    const added = this.object.materials[this.object.materials.length - 1];
    const handle = this.handles.material(object, added.id);
    if (read.name !== undefined) handle.name = read.name as string;
    if (read.color !== undefined) handle.color = read.color;
    return handle;
  }

  edit<T>(work: (mesh: MeshTools) => T): T {
    if (typeof work !== 'function') {
      throw new Error('object.edit takes a function: object.edit((mesh) => { ... }).');
    }
    const object = unlocked(this.object);
    const state = store();
    // In edit mode on this very object, the selection is the one picked by
    // hand, which a script may well have been written to act on. Anywhere
    // else it is whatever an earlier session left behind, so it starts clean,
    // as edit mode itself does.
    const live = state.mode === 'edit' && state.activeObjectId === this.id;
    if (!live) object.mesh.deselectAll();

    const tools = meshTools(this.id, object.name, live ? state.selectMode : 'vertex');
    const finish = () => {
      // Shows what the script picked the way it picked it.
      if (live && store().selectMode !== tools.selectMode) store().setSelectMode(tools.selectMode);
    };

    const result = work(tools);
    if (result instanceof Promise) return result.finally(finish) as T;
    finish();
    return result;
  }

  applyTransform(): this {
    soleUser(unlocked(this.object));
    store().applyTransformToSelected([this.id]);
    return this;
  }

  originToGeometry(): this {
    soleUser(unlocked(this.object));
    store().originToGeometry([this.id]);
    return this;
  }

  originToCursor(): this {
    soleUser(unlocked(this.object));
    store().originToCursor([this.id]);
    return this;
  }

  separate(): ObjectHandle[] {
    soleUser(unlocked(this.object));
    const before = new Set(store().objects.map((object) => object.id));
    onObject(this.id, () => store().separateLooseParts());
    const parts = store().objects.filter(
      (object) => object.id === this.id || !before.has(object.id),
    );
    return parts.map((object) => this.handles.object(object.id));
  }

  toString(): string {
    return `Object(${this.lastName})`;
  }

  toJSON(): { name: string; position: Vec3; rotation: Vec3; scale: Vec3 } {
    return { name: this.name, position: this.position, rotation: this.rotation, scale: this.scale };
  }
}

/**
 * One handle per object and per modifier for the length of a run, so the
 * same object found twice is the same value: `scene.find('BASE') === base`.
 */
class Handles {
  private objects = new Map<string, ObjectHandle>();
  private modifiers = new Map<string, ModifierHandle>();
  private materials = new Map<string, MaterialHandle>();

  object(id: string): ObjectHandle {
    let handle = this.objects.get(id);
    if (!handle) {
      handle = guarded(new ObjectHandle(id, this), 'object');
      this.objects.set(id, handle);
    }
    return handle;
  }

  modifier(object: SceneObject, id: string): ModifierHandle {
    let handle = this.modifiers.get(id);
    if (!handle) {
      handle = guarded(new ModifierHandle(object.id, id, object.name), 'modifier');
      this.modifiers.set(id, handle);
    }
    return handle;
  }

  /** Keyed by object too: a duplicate's slots keep the ids of the original's. */
  material(object: SceneObject, id: string): MaterialHandle {
    const key = `${object.id}/${id}`;
    let handle = this.materials.get(key);
    if (!handle) {
      handle = guarded(new MaterialHandle(object.id, id, object.name), 'material');
      this.materials.set(key, handle);
    }
    return handle;
  }
}

export interface ScriptApi {
  scene: Record<string, unknown>;
  view: Record<string, unknown>;
}

/** The globals a script is handed: `scene` and `view`. */
export function createScriptApi(): ScriptApi {
  const handles = new Handles();

  /** An object, or the name of one, as the object it means. */
  const resolve = (item: unknown, what: string): ObjectHandle => {
    if (item instanceof ObjectHandle) return handles.object(item.id);
    if (typeof item === 'string') {
      const object = store().objects.find(
        (candidate) => candidate.name.toLowerCase() === item.toLowerCase(),
      );
      if (object) return handles.object(object.id);
      const names = store().objects.map((candidate) => candidate.name);
      throw new Error(`There is no object called "${item}".${suggestion(item, names)}`);
    }
    throw new Error(`${what} takes objects or their names, not ${describe(item)}.`);
  };

  const resolveAll = (items: readonly unknown[], what: string): ObjectHandle[] =>
    items.flat().map((item) => resolve(item, what));

  /** Puts a newly added object where `placement` says, and names and colours it. */
  const place = (handle: ObjectHandle, placement: Record<string, unknown>) => {
    if (placement.name !== undefined) handle.name = placement.name as string;
    if (placement.position !== undefined) handle.position = placement.position;
    if (placement.rotation !== undefined) handle.rotation = placement.rotation;
    if (placement.scale !== undefined) handle.scale = placement.scale;
    if (placement.color !== undefined) handle.color = placement.color;
  };

  const split = (read: Record<string, unknown>) => {
    const placement: Record<string, unknown> = {};
    const shape: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(read)) {
      if (PLACEMENT_OPTIONS.some((field) => field.name === key)) placement[key] = value;
      else shape[key] = value;
    }
    return { placement, shape };
  };

  const scene = {
    add(kind: unknown, options?: unknown): ObjectHandle {
      const primitive = readEnum(kind, PRIMITIVE_KINDS, 'scene.add: kind') as PrimitiveKind;
      // Only the shape options this kind reads: a radius handed to a cube would
      // otherwise be dropped without a word.
      const shapeFields = PRIMITIVE_OPTIONS.filter((field) =>
        (PRIMITIVE_FIELDS[primitive] as readonly string[]).includes(field.name),
      );
      const read = readFields(
        `scene.add("${primitive}")`,
        [...shapeFields, ...PLACEMENT_OPTIONS],
        options,
      );
      const { placement, shape } = split(read);

      store().addPrimitive(primitive, shape as Partial<PrimitiveParams>);
      const id = store().activeObjectId;
      if (!id) throw new Error(`The ${primitive} could not be added.`);
      const handle = handles.object(id);
      place(handle, placement);
      return handle;
    },

    addMesh(data: unknown): ObjectHandle {
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('scene.addMesh takes { verts, faces }, each a list.');
      }
      const { verts, faces, ...rest } = data as Record<string, unknown>;
      const placement = readFields('scene.addMesh', PLACEMENT_OPTIONS, rest);
      if (!Array.isArray(verts) || verts.length < 3) {
        throw new Error('scene.addMesh: verts has to be a list of three or more [x, y, z] points.');
      }
      if (!Array.isArray(faces) || faces.length === 0) {
        throw new Error(
          'scene.addMesh: faces has to be a list of faces, each a list of vertex indices.',
        );
      }

      const mesh = new BMesh();
      const made = verts.map((point, index) =>
        mesh.addVert(readVector(point, `scene.addMesh: verts[${index}]`)),
      );
      faces.forEach((ring, index) => {
        const what = `scene.addMesh: faces[${index}]`;
        if (!Array.isArray(ring) || ring.length < 3) {
          throw new Error(`${what} has to list three or more vertex indices.`);
        }
        const corners = ring.map((corner) => {
          if (!Number.isInteger(corner) || corner < 0 || corner >= made.length) {
            throw new Error(
              `${what} names vertex ${describe(corner)}, and verts runs from 0 to ${made.length - 1}.`,
            );
          }
          return made[corner as number];
        });
        if (new Set(corners).size !== corners.length) {
          throw new Error(`${what} uses the same vertex twice.`);
        }
        mesh.addFace(corners);
      });
      mesh.removeLooseVerts();
      mesh.computeNormals();

      const name = typeof placement.name === 'string' ? placement.name : 'MESH';
      store().addImportedObjects([{ name, mesh, position: vec3() }], name);
      const id = store().activeObjectId;
      if (!id) throw new Error('The mesh could not be added.');
      const handle = handles.object(id);
      place(handle, { ...placement, name });
      return handle;
    },

    get objects(): ObjectHandle[] {
      return store().objects.map((object) => handles.object(object.id));
    },

    find(name: unknown): ObjectHandle | null {
      if (typeof name !== 'string')
        throw new Error(`scene.find takes a name, not ${describe(name)}.`);
      const object = store().objects.find(
        (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
      );
      return object ? handles.object(object.id) : null;
    },

    get active(): ObjectHandle | null {
      const id = store().activeObjectId;
      return id ? handles.object(id) : null;
    },

    set active(item: unknown) {
      if (item === null) {
        store().setActiveObject(null);
        return;
      }
      store().setActiveObject(resolve(item, 'scene.active').id, 'add');
    },

    get selected(): ObjectHandle[] {
      return store().selectedObjectIds.map((id) => handles.object(id));
    },

    select(...items: unknown[]): void {
      const targets = resolveAll(items, 'scene.select');
      if (targets.length === 0) store().setActiveObject(null);
      else store().selectObjects(targets.map((target) => target.id));
    },

    selectAll(): void {
      store().selectAllObjects();
    },

    delete(...items: unknown[]): void {
      const targets = resolveAll(items, 'scene.delete');
      if (targets.length > 0) store().deleteSelected(targets.map((target) => target.id));
    },

    clear(): void {
      const ids = store().objects.map((object) => object.id);
      if (ids.length > 0) store().deleteSelected(ids);
    },

    join(target: unknown, ...others: unknown[]): ObjectHandle {
      const into = resolve(target, 'scene.join');
      const sources = resolveAll(others, 'scene.join').filter((other) => other.id !== into.id);
      if (sources.length === 0)
        throw new Error('scene.join needs at least one object to merge in.');
      for (const object of [into, ...sources]) unlocked(sceneObject(object.id, object.name));

      store().selectObjects([...sources, into].map((object) => object.id));
      store().mergeSelected();
      return into;
    },

    async boolean(op: unknown, target: unknown, ...cutters: unknown[]): Promise<ObjectHandle> {
      const operation = readEnum(op, BOOLEAN_OPS, 'scene.boolean: op');
      const into = resolve(target, 'scene.boolean');
      const tools = resolveAll(cutters, 'scene.boolean').filter((tool) => tool.id !== into.id);
      if (tools.length === 0)
        throw new Error('scene.boolean needs at least one object to cut with.');

      const objects = [into, ...tools].map((object) =>
        unlocked(sceneObject(object.id, object.name)),
      );
      const stacked = objects.filter((object) =>
        object.modifiers.some((modifier) => modifier.enabled),
      );
      if (stacked.length > 0) {
        const names = stacked.map((object) => object.name).join(', ');
        throw new Error(
          `Apply the modifiers on ${names} first: a boolean cuts the mesh under the stack, not the shape you see.`,
        );
      }
      if (store().busy) throw new Error('Another long operation is still running.');

      store().selectObjects([...tools, into].map((object) => object.id));
      await store().booleanWithSelected(operation);
      return into;
    },

    group(items: unknown, name?: unknown): string {
      const members = resolveAll(Array.isArray(items) ? items : [items], 'scene.group');
      if (members.length === 0) throw new Error('scene.group needs at least one object.');
      if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
        throw new Error(`scene.group: name has to be some text, not ${describe(name)}.`);
      }

      store().selectObjects(members.map((member) => member.id));
      store().groupSelected();
      const groupId = sceneObject(members[0].id, members[0].name).groupId;
      const group = store().groups.find((candidate) => candidate.id === groupId);
      if (!group) throw new Error('The group could not be made.');
      if (typeof name === 'string') store().renameGroup(group.id, name);
      return typeof name === 'string' ? name : group.name;
    },

    get cursor(): Vec3 {
      return { ...store().cursor };
    },

    set cursor(value: unknown) {
      store().setCursor(readVector(value, 'scene.cursor'), 'Cursor placed');
    },

    get name(): string {
      return store().projectName;
    },

    set name(value: unknown) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`scene.name has to be some text, not ${describe(value)}.`);
      }
      store().setProjectName(value.trim());
    },
  };

  const view = {
    frameAll(): void {
      store().frameAll();
    },

    frameSelected(): void {
      store().frameSelected();
    },

    get shading(): ShadingMode {
      return store().shading;
    },

    set shading(value: unknown) {
      store().setShading(readEnum(value, SHADING_MODES, 'view.shading'));
    },

    get orthographic(): boolean {
      return store().orthographic;
    },

    set orthographic(value: unknown) {
      if (typeof value !== 'boolean') {
        throw new Error(`view.orthographic has to be true or false, not ${describe(value)}.`);
      }
      store().setViewportSetting({ orthographic: value });
    },
  };

  return { scene: guarded(scene, 'scene', true), view: guarded(view, 'view', true) };
}
