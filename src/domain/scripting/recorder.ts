import {
  type Axis,
  type BMesh,
  DEFAULT_PRIMITIVE_PARAMS,
  PRIMITIVE_DEFAULT_OVERRIDES,
  PRIMITIVE_FIELDS,
  type SelectMode,
  type Vec3,
  add,
  axisVector,
  centroid,
  cross,
  dot,
  mulVec,
  radToDeg,
  rotationMatrix,
  sub,
  transformPoint,
  vec3,
} from '@kernel/index';
import {
  type EditorStore,
  type LastOperator,
  type SceneObject,
  activeObject,
  useEditorStore,
} from '@store/index';

import { toHex } from './api';
import { MODIFIER_FIELDS, OPERATOR_SPECS } from './reference';

/*
 * The ACTIONS tab: what the user does, written out as the script that would
 * do it.
 *
 * Every change to the scene goes through a store action, so the store's
 * actions are where it is caught. `installRecorder` wraps the ones a script
 * can repeat, and each wrapper writes its call once the action has run and the
 * scene says what it did. Only the outermost call is written: an action
 * calling another is one thing the user did, and a script run calls them all
 * from inside `transact`.
 *
 * The viewport's gestures in edit mode move vertices in place rather than
 * through an action, so those are read off the undo step each one opens: where
 * the vertices stood when it opened against where they stand when the next
 * thing happens. A gesture that is called off discards its step, and whatever
 * the log gained since goes with it.
 */

// ------------------------------------------------------------------ writing code

/** A number as the log writes it: six places at most, and never `-0`. */
function num(value: number): string {
  const rounded = Number(value.toFixed(6));
  return String(rounded === 0 ? 0 : rounded);
}

function str(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function vec(value: Vec3): string {
  return `[${num(value.x)}, ${num(value.y)}, ${num(value.z)}]`;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Any value an option can hold, as a script would have written it. */
function literal(value: unknown): string {
  if (typeof value === 'number') return num(value);
  if (typeof value === 'string') return str(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Points, directions and axis flags all take [x, y, z] as well, and read
    // shorter that way.
    if (Object.keys(record).length === 3 && 'x' in record && 'y' in record && 'z' in record) {
      return `[${literal(record.x)}, ${literal(record.y)}, ${literal(record.z)}]`;
    }
    return options(record) || '{}';
  }
  return 'null';
}

/** `{ name: value, ... }`, or nothing when there is nothing in it. */
function options(record: Record<string, unknown>): string {
  const fields = Object.entries(record).filter(([, value]) => value !== undefined);
  if (fields.length === 0) return '';
  const written = fields.map(
    ([key, value]) => `${IDENTIFIER.test(key) ? key : str(key)}: ${literal(value)}`,
  );
  return `{ ${written.join(', ')} }`;
}

const find = (name: string) => `scene.find(${str(name)})`;

/** "MOVE selection" as a comment says it: "Move selection". */
function sentence(label: string): string {
  const lower = label.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const MOVE_TOLERANCE = 1e-6;

function near(a: Vec3 | undefined, b: Vec3): boolean {
  return (
    a !== undefined &&
    Math.abs(a.x - b.x) <= MOVE_TOLERANCE &&
    Math.abs(a.y - b.y) <= MOVE_TOLERANCE &&
    Math.abs(a.z - b.z) <= MOVE_TOLERANCE
  );
}

const equal = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;

// ------------------------------------------------------------------- the log

/** One statement, or a few that belong together, at the top level of the script. */
interface LineEntry {
  kind: 'line';
  code: string;
  /**
   * Two entries in a row with the same key are one setting changed again, the
   * way a drag sends a new position on every pointer move: the later one takes
   * the earlier one's place.
   */
  key: string | null;
  /** What a writer needs from the entry it replaces, to say all of it again. */
  data?: unknown;
}

interface EditLine {
  code: string;
  key: string | null;
}

/** Work done on one object's mesh, written inside `object.edit((mesh) => { ... })`. */
interface EditEntry {
  kind: 'edit';
  objectId: string;
  name: string;
  lines: readonly EditLine[];
  /**
   * The selection the lines so far leave behind, so the next operation only
   * selects again when the user picked something else in between.
   */
  selection: string | null;
}

type Entry = LineEntry | EditEntry;

/** Enough to cover a long session without the log growing for ever. */
const MAX_ENTRIES = 1000;

let entries: readonly Entry[] = [];
let text: string | null = '';
const listeners = new Set<() => void>();

function render(entry: Entry): string {
  if (entry.kind === 'line') return entry.code;
  const body = entry.lines
    .flatMap((line) => line.code.split('\n'))
    .map((line) => `  ${line}`)
    .join('\n');
  return `${find(entry.name)}.edit((mesh) => {\n${body}\n});`;
}

function commit(next: readonly Entry[]): void {
  if (next === entries) return;
  entries = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
  text = null;
  for (const listener of listeners) listener();
}

function writeLine(code: string, key: string | null = null, data?: unknown): void {
  const entry: LineEntry = { kind: 'line', code, key, data };
  if (key !== null && lastLine(key)) commit([...entries.slice(0, -1), entry]);
  else commit([...entries, entry]);
}

/** The last entry, when it is a line carrying this key. */
function lastLine(key: string): LineEntry | null {
  const last = entries[entries.length - 1];
  return last?.kind === 'line' && last.key === key ? last : null;
}

function comment(note: string): void {
  writeLine(`// ${note}`);
}

// ----------------------------------------------------------- edit-mode work

/**
 * What is selected, as points: where each vertex stands, or the middle of each
 * edge or face.
 *
 * Not as ids. An undo rebuilds the mesh from its saved form and numbers every
 * element afresh, and so does every bevel, inset or extrude drag, which keeps
 * the copy it previewed on. A script replaying the log does neither, so an id
 * taken here would name some other face by the time it ran.
 */
interface Selection {
  mode: SelectMode;
  points: Vec3[];
  /** Every element of that kind, which reads better as a select with no list. */
  all: boolean;
}

function readSelection(mesh: BMesh, mode: SelectMode): Selection {
  if (mode === 'vertex') {
    const verts = mesh.selectedVerts();
    return {
      mode,
      points: verts.map((vert) => ({ ...vert.co })),
      all: verts.length === mesh.verts.size,
    };
  }
  if (mode === 'edge') {
    const edges = mesh.selectedEdges();
    return {
      mode,
      points: edges.map((edge) => mesh.edgeCenter(edge)),
      all: edges.length === mesh.edges.size,
    };
  }
  const faces = mesh.selectedFaces();
  return {
    mode,
    points: faces.map((face) => mesh.faceCenter(face)),
    all: faces.length === mesh.faces.size,
  };
}

const selectionKey = (selection: Selection) =>
  `${selection.mode} ${selection.all ? 'all' : selection.points.map(vec).join(' ')}`;

const SELECT_CALLS: Record<SelectMode, string> = {
  vertex: 'selectVerts',
  edge: 'selectEdges',
  face: 'selectFaces',
};

function selectionCode(selection: Selection): string {
  const call = `mesh.${SELECT_CALLS[selection.mode]}`;
  // An empty list still says which kind is being picked, which the operations
  // that read the select mode need.
  if (selection.all && selection.points.length > 0) return `${call}();`;

  const points = selection.points.map(vec);
  const inline = `${call}([${points.join(', ')}]);`;
  if (inline.length <= 96) return inline;

  const rows: string[] = [];
  let row = '';
  for (const point of points) {
    if (row !== '' && row.length + point.length > 76) {
      rows.push(`  ${row},`);
      row = point;
    } else {
      row = row === '' ? point : `${row}, ${point}`;
    }
  }
  rows.push(`  ${row}`);
  return `${call}([\n${rows.join('\n')}\n]);`;
}

/** Operations that pay no attention to what is selected. */
const SELECTION_FREE = new Set(['selectAll', 'deselectAll', 'knife']);

/**
 * Adds a line to the edit block of the object it ran on, starting a block when
 * the log's last entry is not that object's. `reads` says the line acts on the
 * selection, which is then selected again first unless it is what the block
 * already left selected.
 */
function writeEdit(
  target: { id: string; name: string },
  before: Selection,
  after: Selection,
  code: string,
  reads: boolean,
  key: string | null = null,
): void {
  const last = entries[entries.length - 1];
  const block: EditEntry =
    last?.kind === 'edit' && last.objectId === target.id
      ? last
      : { kind: 'edit', objectId: target.id, name: target.name, lines: [], selection: null };

  const lines = [...block.lines];
  if (reads && block.selection !== selectionKey(before)) {
    lines.push({ code: selectionCode(before), key: null });
  }
  if (key !== null && lines[lines.length - 1]?.key === key) lines[lines.length - 1] = { code, key };
  else lines.push({ code, key });

  const next: EditEntry = { ...block, lines, selection: selectionKey(after) };
  commit(block === last ? [...entries.slice(0, -1), next] : [...entries, next]);
}

/** `mesh.extrude({ offset: 1 });`, keeping only the parameters the operation takes. */
function operatorCall(operator: { name: string; params: Record<string, unknown> }): string | null {
  const spec = OPERATOR_SPECS.find((candidate) => candidate.name === operator.name);
  if (!spec) return null;
  const known: Record<string, unknown> = {};
  for (const field of spec.params) {
    if (operator.params[field.name] !== undefined) known[field.name] = operator.params[field.name];
  }
  return `mesh.${operator.name}(${options(known)});`;
}

/**
 * The turn about one axis through `pivot` that takes every point of `from` to
 * the same one of `to`, in radians, or null when no such turn does.
 */
function turnAbout(axis: Axis, from: readonly Vec3[], to: readonly Vec3[], pivot: Vec3) {
  const direction = axisVector(axis);
  const flat = (point: Vec3) => {
    const offset = sub(point, pivot);
    return sub(offset, mulVec(offset, direction));
  };

  // Read off the point furthest from the axis, where the angle is surest.
  let reach = 0;
  let angle = 0;
  from.forEach((point, index) => {
    const a = flat(point);
    const b = flat(to[index]);
    const radius = Math.hypot(a.x, a.y, a.z);
    if (radius > reach) {
      reach = radius;
      angle = Math.atan2(dot(direction, cross(a, b)), dot(a, b));
    }
  });
  if (reach <= MOVE_TOLERANCE) return null;

  const matrix = rotationMatrix(direction, angle);
  const fits = from.every((point, index) =>
    near(add(transformPoint(matrix, sub(point, pivot)), pivot), to[index]),
  );
  return fits ? angle : null;
}

/** The factors along each axis about `pivot` that take `from` to `to`, or null. */
function scaleAbout(from: readonly Vec3[], to: readonly Vec3[], pivot: Vec3): Vec3 | null {
  const factor = vec3(1, 1, 1);
  for (const axis of ['x', 'y', 'z'] as const) {
    let reach = 0;
    from.forEach((point, index) => {
      const offset = point[axis] - pivot[axis];
      if (Math.abs(offset) > Math.abs(reach)) {
        reach = offset;
        factor[axis] = (to[index][axis] - pivot[axis]) / offset;
      }
    });
  }
  const fits = from.every((point, index) =>
    near(add(mulVec(sub(point, pivot), factor), pivot), to[index]),
  );
  return fits ? factor : null;
}

/**
 * A hand-made move of the selected vertices as the one operation that repeats
 * it: a translate, a scale or a turn about one axis through their middle, the
 * pivot those operations use. Null for any other move, such as one that
 * carried unselected vertices with it, turned about the view, or measured from
 * the 3D cursor.
 */
function rigidMove(
  selected: ReadonlySet<number>,
  before: ReadonlyMap<number, Vec3>,
  after: ReadonlyMap<number, Vec3>,
): string | null {
  for (const [id, point] of after) {
    if (!selected.has(id) && !near(before.get(id), point)) return null;
  }

  const from: Vec3[] = [];
  const to: Vec3[] = [];
  for (const id of selected) {
    const start = before.get(id);
    const end = after.get(id);
    if (!start || !end) return null;
    from.push(start);
    to.push(end);
  }
  if (from.length === 0) return null;

  const offset = sub(to[0], from[0]);
  if (from.every((point, index) => near(add(point, offset), to[index]))) {
    return `mesh.translate({ offset: ${vec(offset)} });`;
  }

  const pivot = centroid(from);
  const factor = scaleAbout(from, to, pivot);
  if (factor) {
    const uniform = factor.x === factor.y && factor.y === factor.z;
    return `mesh.scale({ scale: ${uniform ? num(factor.x) : vec(factor)} });`;
  }

  for (const axis of ['x', 'y', 'z'] as const) {
    const angle = turnAbout(axis, from, to, pivot);
    if (angle !== null)
      return `mesh.rotate({ axis: ${str(axis)}, angle: ${num(radToDeg(angle))} });`;
  }
  return null;
}

// ------------------------------------------------------- an open undo step

/** The scene as a step tells whether it changed anything. */
const documentOf = (state: EditorStore) =>
  [state.objects, state.groups, state.cursor, state.assets, state.meshVersion] as const;

/**
 * An undo step opened outside any action the recorder writes, which is how a
 * viewport gesture begins, waiting to be described once it has done its work.
 */
interface Step {
  label: string;
  operator: LastOperator | null;
  document: readonly unknown[];
  /** In edit mode: the object, where each of its vertices stood, and what was selected. */
  edit: {
    target: { id: string; name: string };
    positions: Map<number, Vec3>;
    selected: Set<number>;
    selection: Selection;
  } | null;
}

let step: Step | null = null;

/**
 * The log as it stood when the last step opened, to go back to if that step
 * is discarded: the gesture was called off, and what it wrote never happened.
 */
let mark: readonly Entry[] | null = null;

function openStep(label: string): void {
  const state = useEditorStore.getState();
  const object = state.mode === 'edit' ? activeObject(state) : null;
  step = {
    label,
    operator: state.lastOperator,
    document: documentOf(state),
    edit: object
      ? {
          target: { id: object.id, name: object.name },
          positions: new Map(
            [...object.mesh.verts.values()].map((vert) => [vert.id, { ...vert.co }]),
          ),
          selected: new Set(object.mesh.selectedVerts().map((vert) => vert.id)),
          selection: readSelection(object.mesh, state.selectMode),
        }
      : null,
  };
}

function closeStep(): void {
  const open = step;
  step = null;
  if (!open) return;

  const state = useEditorStore.getState();
  const changed = documentOf(state).some((value, index) => value !== open.document[index]);
  if (!changed) return;

  const unscriptable = `// ${sentence(open.label)} (no script equivalent)`;
  if (!open.edit) {
    writeLine(unscriptable);
    return;
  }

  const { target } = open.edit;
  const object = state.objects.find((candidate) => candidate.id === target.id);
  if (!object) return;
  const after = readSelection(object.mesh, state.selectMode);

  // A gesture that ran an operation of its own said which one.
  const operator = state.lastOperator;
  if (operator && operator !== open.operator) {
    const call = operatorCall(operator);
    writeEdit(target, open.edit.selection, after, call ?? unscriptable, call !== null);
    return;
  }

  const positions = new Map([...object.mesh.verts.values()].map((vert) => [vert.id, vert.co]));
  const before = open.edit.positions;
  const rebuilt =
    positions.size !== before.size || [...positions.keys()].some((id) => !before.has(id));
  const moved = [...positions].some(([id, point]) => !near(before.get(id), point));
  if (!rebuilt && !moved) return;

  const call = rebuilt ? null : rigidMove(open.edit.selected, before, positions);
  writeEdit(target, open.edit.selection, after, call ?? unscriptable, call !== null);
}

// ------------------------------------------------------------- the writers

type Action = {
  [K in keyof EditorStore]: EditorStore[K] extends (...args: never[]) => unknown ? K : never;
}[keyof EditorStore];

type Fn<K extends Action> = Extract<EditorStore[K], (...args: never[]) => unknown>;

interface Call<K extends Action, P> {
  args: Parameters<Fn<K>>;
  before: EditorStore;
  after: EditorStore;
  result: Awaited<ReturnType<Fn<K>>>;
  prepared: P;
}

interface Writer<K extends Action, P> {
  /** Reads what the call is about to act on, which may be gone once it has. */
  prepare?: (state: EditorStore, args: Parameters<Fn<K>>) => P;
  write: (call: Call<K, P>) => void;
}

const writers = new Map<Action, Writer<Action, unknown>>();

function writes<K extends Action, P = undefined>(name: K, writer: Writer<K, P>): void {
  writers.set(name, writer as unknown as Writer<Action, unknown>);
}

const byId = (state: EditorStore, id: string | null) =>
  state.objects.find((object) => object.id === id);

const isNew = (before: EditorStore, object: SceneObject) =>
  !before.objects.some((candidate) => candidate.id === object.id);

const names = (objects: readonly SceneObject[]) => objects.map((object) => str(object.name));

const selected = (state: EditorStore) =>
  state.objects.filter((object) => state.selectedObjectIds.includes(object.id));

function addCode(object: SceneObject): string {
  if (!object.primitive) return '';
  const { kind, params } = object.primitive;
  const defaults = { ...DEFAULT_PRIMITIVE_PARAMS, ...PRIMITIVE_DEFAULT_OVERRIDES[kind] };
  const shape: Record<string, unknown> = {};
  for (const field of PRIMITIVE_FIELDS[kind]) {
    if (params[field] !== defaults[field]) shape[field] = params[field];
  }
  const settings = options(shape);
  return `scene.add(${str(kind)}${settings ? `, ${settings}` : ''});`;
}

writes('addPrimitive', {
  write: ({ before, after }) => {
    const object = byId(after, after.activeObjectId);
    if (object?.primitive && isNew(before, object)) {
      writeLine(addCode(object), `primitive:${object.id}`);
    }
  },
});

// The shape stays live until the next edit, so the line that added it is the
// one to change: it is still true that nothing between them touched the mesh.
writes('updatePrimitiveParams', {
  write: ({ before, after }) => {
    const object = activeObject(after);
    if (!object?.primitive || byId(before, object.id)?.primitive === object.primitive) return;
    const key = `primitive:${object.id}`;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.kind === 'line' && entry.key === key) {
        const next = [...entries];
        next[index] = { ...entry, code: addCode(object) };
        commit(next);
        return;
      }
    }
    comment(`${object.name}: shape options changed (no script equivalent)`);
  },
});

function writeTransforms({ before, after }: { before: EditorStore; after: EditorStore }): void {
  const lines: string[] = [];
  const keys: string[] = [];
  for (const object of after.objects) {
    const was = byId(before, object.id);
    if (!was || was.transform === object.transform) continue;
    for (const field of ['position', 'rotation', 'scale'] as const) {
      const value = object.transform[field];
      if (equal(was.transform[field], value)) continue;
      const shown =
        field === 'rotation'
          ? vec3(radToDeg(value.x), radToDeg(value.y), radToDeg(value.z))
          : value;
      lines.push(`${find(object.name)}.${field} = ${vec(shown)};`);
      keys.push(`${object.id}.${field}`);
    }
  }
  if (lines.length > 0) writeLine(lines.join('\n'), `transform ${keys.join(' ')}`);
}

writes('setObjectTransform', { write: writeTransforms });
writes('setObjectTransforms', { write: writeTransforms });

/** The selected objects in the order `scene.select` takes them: the active one last. */
function selectionOrder(state: EditorStore): SceneObject[] {
  const ids = state.selectedObjectIds.filter((id) => id !== state.activeObjectId);
  if (state.activeObjectId && state.selectedObjectIds.includes(state.activeObjectId)) {
    ids.push(state.activeObjectId);
  }
  return ids.flatMap((id) => byId(state, id) ?? []);
}

function writeSelection({ before, after }: { before: EditorStore; after: EditorStore }): void {
  const was = selectionOrder(before).map((object) => object.id);
  const now = selectionOrder(after);
  if (was.length === now.length && now.every((object, index) => object.id === was[index])) return;
  writeLine(`scene.select(${names(now).join(', ')});`, 'select');
}

writes('setActiveObject', { write: writeSelection });
writes('selectObjects', { write: writeSelection });
writes('deselectObject', { write: writeSelection });
writes('clearSelection', { write: writeSelection });
writes('selectAllObjects', { write: writeSelection });

writes('renameObject', {
  write: ({ args: [id], before, after }) => {
    const was = byId(before, id);
    const object = byId(after, id);
    if (!was || !object || was.name === object.name) return;
    const key = `rename ${id}`;
    const from = (lastLine(key)?.data as string | undefined) ?? was.name;
    writeLine(`${find(from)}.name = ${str(object.name)};`, key, from);
  },
});

function writeFlag(field: 'visible' | 'locked') {
  return ({ args: [id], after }: { args: [string]; after: EditorStore }) => {
    const object = byId(after, id);
    if (object) writeLine(`${find(object.name)}.${field} = ${object[field]};`, `${field} ${id}`);
  };
}

writes('toggleObjectVisibility', { write: writeFlag('visible') });
writes('toggleObjectLock', { write: writeFlag('locked') });

writes('duplicateSelected', {
  prepare: (state) => selected(state),
  write: ({ args: [linked], before, after, prepared }) => {
    const copies = after.objects.filter((object) => isNew(before, object));
    if (copies.length === 0) return;
    const lines = prepared.map(
      (object) => `${find(object.name)}.duplicate(${linked ? 'true' : ''});`,
    );
    // One at a time, each copy leaves only itself selected, where the button
    // leaves every copy it made.
    if (copies.length > 1) lines.push(`scene.select(${names(copies).join(', ')});`);
    writeLine(lines.join('\n'));
  },
});

/** The active object, and the other selected objects that will work on it. */
function targetAndTools(state: EditorStore) {
  const target = activeObject(state);
  if (!target) return null;
  const tools = selected(state).filter((object) => object.id !== target.id && !object.locked);
  return { target, tools };
}

writes('mergeSelected', {
  prepare: targetAndTools,
  write: ({ before, after, prepared }) => {
    if (!prepared || before.objects === after.objects) return;
    writeLine(`scene.join(${names([prepared.target, ...prepared.tools]).join(', ')});`);
  },
});

writes('booleanWithSelected', {
  prepare: targetAndTools,
  write: ({ args: [op], before, after, prepared }) => {
    if (!prepared || before.objects === after.objects) return;
    const objects = names([prepared.target, ...prepared.tools]).join(', ');
    writeLine(`await scene.boolean(${str(op)}, ${objects});`);
  },
});

writes('groupSelected', {
  prepare: (state) => selected(state),
  write: ({ before, after, prepared }) => {
    if (before.groups !== after.groups) writeLine(`scene.group([${names(prepared).join(', ')}]);`);
  },
});

writes('separateLooseParts', {
  prepare: (state) => activeObject(state),
  write: ({ before, after, prepared }) => {
    if (prepared && after.objects.length > before.objects.length) {
      writeLine(`${find(prepared.name)}.separate();`);
    }
  },
});

writes('deleteSelected', {
  write: ({ before, after }) => {
    const gone = before.objects.filter((object) => !byId(after, object.id));
    if (gone.length > 0) writeLine(`scene.delete(${names(gone).join(', ')});`);
  },
});

/** A method called on every object the action moved, rotated or scaled. */
function writeEach(method: string) {
  return ({ before, after }: { before: EditorStore; after: EditorStore }) => {
    const lines = after.objects
      .filter((object) => {
        const was = byId(before, object.id)?.transform;
        const now = object.transform;
        return (
          was !== undefined &&
          !(
            equal(was.position, now.position) &&
            equal(was.rotation, now.rotation) &&
            equal(was.scale, now.scale)
          )
        );
      })
      .map((object) => `${find(object.name)}.${method}();`);
    if (lines.length > 0) writeLine(lines.join('\n'));
  };
}

writes('applyTransformToSelected', { write: writeEach('applyTransform') });
writes('originToGeometry', { write: writeEach('originToGeometry') });
writes('originToCursor', { write: writeEach('originToCursor') });

function writeCursor({ before, after }: { before: EditorStore; after: EditorStore }): void {
  if (!equal(before.cursor, after.cursor))
    writeLine(`scene.cursor = ${vec(after.cursor)};`, 'cursor');
}

writes('setCursor', { write: writeCursor });
writes('snapCursor', { write: writeCursor });
writes('cursorToSelection', { write: writeCursor });
writes('cursorToSelectionOrigin', { write: writeCursor });

writes('addMaterial', {
  prepare: (state) => activeObject(state),
  write: ({ after, prepared }) => {
    const object = prepared && byId(after, prepared.id);
    if (prepared && object && object.materials.length > prepared.materials.length) {
      writeLine(`${find(object.name)}.addMaterial();`);
    }
  },
});

writes('updateMaterial', {
  prepare: (state) => activeObject(state),
  write: ({ args: [index], after, prepared }) => {
    const was = prepared?.materials[index];
    const object = prepared && byId(after, prepared.id);
    const material = object?.materials[index];
    if (!object || !was || !material) return;

    const slot = `${find(object.name)}.materials[${index}]`;
    const lines: string[] = [];
    const fields: string[] = [];
    if (material.name !== was.name) {
      lines.push(`${slot}.name = ${str(material.name)};`);
      fields.push('name');
    }
    if (toHex(material.color) !== toHex(was.color)) {
      lines.push(`${slot}.color = ${str(toHex(material.color))};`);
      fields.push('color');
    }
    if (lines.length > 0) {
      writeLine(lines.join('\n'), `material ${object.id} ${index} ${fields.join(' ')}`);
    }
  },
});

writes('removeMaterial', {
  prepare: (state) => activeObject(state),
  write: ({ args: [index], after, prepared }) => {
    const object = prepared && byId(after, prepared.id);
    if (prepared && object && object.materials.length < prepared.materials.length) {
      writeLine(`${find(object.name)}.materials[${index}].remove();`);
    }
  },
});

writes('assignMaterialToSelection', {
  prepare: (state) => {
    const object = activeObject(state);
    if (!object || object.mesh.selectedFaces().length === 0) return null;
    return { object, selection: readSelection(object.mesh, state.selectMode) };
  },
  write: ({ after, prepared }) => {
    if (!prepared) return;
    const { object, selection } = prepared;
    const now = readSelection(object.mesh, after.selectMode);
    writeEdit(object, selection, now, `mesh.assignMaterial(${object.activeMaterial});`, true);
  },
});

writes('addModifier', {
  prepare: (state) => activeObject(state),
  write: ({ args: [type], after, prepared }) => {
    const object = prepared && byId(after, prepared.id);
    if (prepared && object && object.modifiers.length > prepared.modifiers.length) {
      writeLine(`${find(object.name)}.addModifier(${str(type)});`);
    }
  },
});

/** The modifier an action names, where it sat in the stack, and the object it is on. */
function modifierOf(state: EditorStore, id: string) {
  const object = activeObject(state);
  const index = object?.modifiers.findIndex((modifier) => modifier.id === id) ?? -1;
  return object && index >= 0 ? { object, index, modifier: object.modifiers[index] } : null;
}

writes('updateModifier', {
  write: ({ args: [id, patch], after }) => {
    const found = modifierOf(after, id);
    if (!found) return;
    const { object, index, modifier } = found;

    const settable = new Set([
      'name',
      'enabled',
      ...MODIFIER_FIELDS[modifier.type].map((f) => f.name),
    ]);
    const key = `modifier ${id}`;
    // A slider sends a new value on every move: the line it replaces may have
    // been about another setting, so it keeps saying that one too.
    const fields = new Set([
      ...((lastLine(key)?.data as string[] | undefined) ?? []),
      ...Object.keys(patch).filter((field) => settable.has(field)),
    ]);
    if (fields.size === 0) return;

    const values = modifier as unknown as Record<string, unknown>;
    const settings = Object.fromEntries([...fields].map((field) => [field, values[field]]));
    writeLine(`${find(object.name)}.modifiers[${index}].set(${options(settings)});`, key, [
      ...fields,
    ]);
  },
});

/** A call on the modifier as it stood before the action, once the action changed the stack. */
function writeModifier(method: (direction: number) => string) {
  return {
    prepare: (state: EditorStore, args: [string, ...unknown[]]) => modifierOf(state, args[0]),
    write: ({
      args,
      after,
      prepared,
    }: {
      args: [string, ...unknown[]];
      after: EditorStore;
      prepared: ReturnType<typeof modifierOf>;
    }) => {
      const object = prepared && byId(after, prepared.object.id);
      if (!prepared || !object || object.modifiers === prepared.object.modifiers) return;
      const call = method(typeof args[1] === 'number' ? args[1] : 0);
      writeLine(`${find(object.name)}.modifiers[${prepared.index}].${call}();`);
    },
  };
}

writes(
  'removeModifier',
  writeModifier(() => 'remove'),
);
writes(
  'moveModifier',
  writeModifier((direction) => (direction < 0 ? 'moveUp' : 'moveDown')),
);
writes(
  'applyModifierToMesh',
  writeModifier(() => 'apply'),
);

writes('exec', {
  prepare: (state) => {
    const object = activeObject(state);
    if (!object || object.locked) return null;
    return { object, selection: readSelection(object.mesh, state.selectMode) };
  },
  write: ({ args: [name, params = {}, label, settings], after, prepared, result }) => {
    if (!prepared || !result || result.refused) return;
    const object = byId(after, prepared.object.id);
    if (!object) return;
    const now = readSelection(object.mesh, after.selectMode);
    const call = operatorCall({ name, params });
    // A scrubbed field runs the operation again on every move without a step
    // of its own, each run replacing the last.
    const key = settings?.record === false ? `run ${name}` : null;
    writeEdit(
      prepared.object,
      prepared.selection,
      now,
      call ?? `// ${sentence(label ?? name)} (no script equivalent)`,
      call !== null && !SELECTION_FREE.has(name),
      key,
    );
  },
});

writes('setShading', {
  write: ({ before, after }) => {
    if (before.shading !== after.shading)
      writeLine(`view.shading = ${str(after.shading)};`, 'shading');
  },
});

writes('setViewportSetting', {
  write: ({ before, after }) => {
    if (before.orthographic !== after.orthographic) {
      writeLine(`view.orthographic = ${after.orthographic};`, 'orthographic');
    }
  },
});

writes('frameAll', { write: () => writeLine('view.frameAll();', 'frame') });
writes('frameSelected', { write: () => writeLine('view.frameSelected();', 'frame') });

function writeHistoryMove({ before, after }: { before: EditorStore; after: EditorStore }): void {
  if (before.historyUndo.length !== after.historyUndo.length) comment(after.status);
}

writes('undoTimes', { write: writeHistoryMove });
writes('redoTimes', { write: writeHistoryMove });

writes('transact', {
  write: ({ before, after }) => {
    const was = documentOf(before);
    if (documentOf(after).some((value, index) => value !== was[index])) comment('Ran a script');
  },
});

writes('loadProjectDocument', {
  write: ({ after }) => comment(`Opened ${str(after.projectName)}`),
});

writes('resetScene', {
  write: () => writeLine('// New project\nscene.clear();'),
});

// ------------------------------------------------------------- installing

type AnyFn = (...args: unknown[]) => unknown;

/** Where a wrapper keeps the action it wraps, so a second install wraps that and not itself. */
const ORIGINAL = Symbol.for('3doo.recorder.original');

let depth = 0;

function report(error: unknown): void {
  console.warn('The ACTIONS log could not write that down:', error);
}

/** Runs `original`, writing it down when nothing around it is being written down already. */
function wrap(original: AnyFn, writer: Writer<Action, unknown>): AnyFn {
  return (...args) => {
    if (depth > 0) return original(...args);

    closeStep();
    const before = useEditorStore.getState();
    let prepared: unknown;
    try {
      prepared = writer.prepare?.(before, args as never);
    } catch (error) {
      report(error);
    }

    const finish = (result: unknown) => {
      const after = useEditorStore.getState();
      // A new step stands between the mark and anything discarded from here on.
      if (before.historyUndo !== after.historyUndo || before.historyRedo !== after.historyRedo) {
        mark = null;
      }
      try {
        writer.write({ args: args as never, before, after, result: result as never, prepared });
      } catch (error) {
        report(error);
      }
    };

    depth += 1;
    let result: unknown;
    try {
      result = original(...args);
    } catch (error) {
      depth -= 1;
      throw error;
    }

    if (result instanceof Promise) {
      return result.then(
        (value: unknown) => {
          depth -= 1;
          finish(value);
          return value;
        },
        (error: unknown) => {
          depth -= 1;
          throw error;
        },
      );
    }

    depth -= 1;
    finish(result);
    return result;
  };
}

/** `recordHistory` and `recordHistoryDocument`: the start of a gesture, when nothing else is. */
function wrapRecord(original: AnyFn): AnyFn {
  return (...args) => {
    if (depth > 0) return original(...args);
    closeStep();
    mark = entries;
    openStep(String(args[0]));
    depth += 1;
    try {
      return original(...args);
    } finally {
      depth -= 1;
    }
  };
}

/** `discardHistory`: the gesture was called off, so the log goes back to where it began. */
function wrapDiscard(original: AnyFn): AnyFn {
  return (...args) => {
    if (depth > 0) return original(...args);
    step = null;
    if (mark) commit(mark);
    mark = null;
    depth += 1;
    try {
      return original(...args);
    } finally {
      depth -= 1;
    }
  };
}

let unsubscribe: (() => void) | null = null;

/**
 * Starts writing down what the user does. Called once, before anything is
 * done; calling it again replaces the wrappers rather than stacking them.
 */
export function installRecorder(): void {
  const state = useEditorStore.getState() as unknown as Record<string, AnyFn>;
  const unwrapped = (name: string) => {
    const action = state[name] as AnyFn & { [ORIGINAL]?: AnyFn };
    return action[ORIGINAL] ?? action;
  };
  const marked = (name: string, wrapper: AnyFn) =>
    Object.assign(wrapper, { [ORIGINAL]: unwrapped(name) });

  const patch: Record<string, AnyFn> = {};
  for (const [name, writer] of writers) {
    patch[name] = marked(name, wrap(unwrapped(name), writer));
  }
  for (const name of ['recordHistory', 'recordHistoryDocument']) {
    patch[name] = marked(name, wrapRecord(unwrapped(name)));
  }
  patch.discardHistory = marked('discardHistory', wrapDiscard(unwrapped('discardHistory')));
  useEditorStore.setState(patch as Partial<EditorStore>);

  // A gesture is only described once the next thing happens, and opening the
  // log to read it is the next thing.
  unsubscribe?.();
  unsubscribe = useEditorStore.subscribe(
    (current) => current.dialog,
    (dialog) => {
      if (dialog === 'script') closeStep();
    },
  );
}

// --------------------------------------------------------------- reading

export function subscribeActionLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The log as a script, oldest action first. */
export function actionLogText(): string {
  text ??= entries.map(render).join('\n');
  return text;
}

/** Cheap enough to read on every change, which the whole text is not during a drag. */
export function actionLogIsEmpty(): boolean {
  return entries.length === 0;
}

/** The log with the gesture in progress written down too, for a reader that will not wait. */
export function readActionLog(): string {
  closeStep();
  return actionLogText();
}

export function clearActionLog(): void {
  step = null;
  mark = null;
  commit([]);
}
