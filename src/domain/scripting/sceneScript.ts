import {
  type BMesh,
  type Material,
  type Modifier,
  type ModifierType,
  type Vec3,
  DEFAULT_PRIMITIVE_PARAMS,
  PRIMITIVE_DEFAULT_OVERRIDES,
  PRIMITIVE_FIELDS,
  PRIMITIVE_LABELS,
  createModifier,
  createPrimitive,
  radToDeg,
  serializeMesh,
  vec3,
} from '@kernel/index';
import { DEFAULT_MATERIAL_COLOR, type EditorStore, type SceneObject } from '@store/index';

import { toHex } from './api';
import { MODIFIER_FIELDS } from './reference';

/*
 * The SCENE tab: the scene on screen, written as the script that builds it.
 *
 * Read off the scene every time rather than kept as a log of what was done, so
 * the two cannot disagree: a cube added and deleted again writes nothing, and
 * an undo takes its lines away with it. Run on a new project, the script builds
 * this scene again.
 *
 * It writes what the scene is, not how it is being looked at: what is selected,
 * the shading and the camera are left out, and so are UVs, which nothing on
 * screen shows. Images and lattices have no script form yet, so each is noted
 * in a comment instead and counted, for COPY to say a run leaves them out.
 */

// ------------------------------------------------------------------ writing code

/** The widest line the script is laid out to, as the project's own code is. */
const WIDTH = 100;

/** A number as the script writes it: six places at most, and never `-0`. */
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

/** Any value a setting can hold, as a script would have written it. */
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
    const fields = Object.entries(record).filter(([, field]) => field !== undefined);
    if (fields.length === 0) return '{}';
    const written = fields.map(
      ([key, field]) => `${IDENTIFIER.test(key) ? key : str(key)}: ${literal(field)}`,
    );
    return `{ ${written.join(', ')} }`;
  }
  return 'null';
}

/** One option of a call, already written as code. */
type Field = readonly [key: string, code: string];

/** `items` in rows of as many as fit, each row indented by `indent` and ending in a comma. */
function rows(items: readonly string[], indent: string): string {
  const lines: string[] = [];
  let row = '';
  for (const item of items) {
    const next = row === '' ? item : `${row}, ${item}`;
    if (row !== '' && `${indent}${next},`.length > WIDTH) {
      lines.push(`${indent}${row},`);
      row = item;
    } else {
      row = next;
    }
  }
  lines.push(`${indent}${row},`);
  return lines.join('\n');
}

/** A list option: on its own line when it fits there, otherwise in rows beneath its name. */
function list(key: string, items: readonly string[]): Field {
  const inline = `[${items.join(', ')}]`;
  if (items.length === 0 || `  ${key}: ${inline},`.length <= WIDTH) return [key, inline];
  return [key, `[\n${rows(items, '    ')}\n  ]`];
}

/** `callee(args, { options });` on one line when it fits, or one option a line when not. */
function invoke(prefix: string, callee: string, args: readonly string[], fields: readonly Field[]) {
  const lead = `${prefix}${callee}(${args.map((arg) => `${arg}, `).join('')}`;
  if (fields.length === 0) return `${lead.replace(/, $/, '')});`;
  const inline = `${lead}{ ${fields.map(([key, code]) => `${key}: ${code}`).join(', ')} });`;
  if (inline.length <= WIDTH && !inline.includes('\n')) return inline;
  return `${lead}{\n${fields.map(([key, code]) => `  ${key}: ${code},`).join('\n')}\n});`;
}

const sameColor = (a: Material['color'], b: Material['color']) =>
  a.r === b.r && a.g === b.g && a.b === b.b;

/** A colour as `'#rrggbb'` when that is exactly it, as a colour picker leaves it, else as [r, g, b]. */
function color(value: Material['color']): string {
  const hex = toHex(value);
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
  return sameColor(value, { r: channel(1), g: channel(3), b: channel(5) })
    ? str(hex)
    : `[${num(value.r)}, ${num(value.g)}, ${num(value.b)}]`;
}

/**
 * The name a slot is given when it is made: numbered from a count kept for the
 * whole session, so one is no more the scene's than an id is, and a run makes
 * another.
 */
const MADE_NAME = /^Material \d+$/;

/** What a new slot starts as, with a name of the kind every new slot gets. */
const NEW_SLOT: Material = { id: '', name: 'Material 0', color: DEFAULT_MATERIAL_COLOR };

/** Names a script cannot give a variable, or would lose a global to. */
const RESERVED = (
  'arguments await break case catch class const console continue debugger default delete do ' +
  'else enum eval export extends false finally for function if implements import in ' +
  'instanceof interface let new null package private protected public return scene static ' +
  'super switch this throw true try typeof var view void while with yield'
).split(' ');

/** `UV SPHERE` as a variable: `uvSphere`, or `uvSphere2` once that is taken. */
function variableFor(name: string, taken: Set<string>): string {
  const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const joined = words
    .map((word, index) => (index === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('');
  const base = /^[a-z]/.test(joined)
    ? joined
    : `object${joined.charAt(0).toUpperCase()}${joined.slice(1)}`;
  let variable = base;
  for (let count = 2; taken.has(variable); count++) variable = `${base}${count}`;
  taken.add(variable);
  return variable;
}

// --------------------------------------------------------------- what to write

/** An object's name, place, turn and size as `scene.add` and `scene.addMesh` take them. */
function placement(object: SceneObject, defaultName: string): { name: Field[]; place: Field[] } {
  const { position, rotation, scale } = object.transform;
  const place: Field[] = [];
  if (vec(position) !== '[0, 0, 0]') place.push(['position', vec(position)]);
  const turn = degrees(rotation);
  if (turn !== '[0, 0, 0]') place.push(['rotation', turn]);
  const size = scaleCode(scale);
  if (size !== '1') place.push(['scale', size]);
  return { name: object.name === defaultName ? [] : [['name', str(object.name)]], place };
}

const degrees = (rotation: Vec3) =>
  vec(vec3(radToDeg(rotation.x), radToDeg(rotation.y), radToDeg(rotation.z)));

function scaleCode(scale: Vec3): string {
  const [x, y, z] = [scale.x, scale.y, scale.z].map(num);
  return x === y && y === z ? x : `[${x}, ${y}, ${z}]`;
}

/** The parts of a mesh a script can build it again from: no selection and no UVs. */
function geometry(mesh: BMesh) {
  const { positions, faces, materialIndices, smooth, wireEdges, sharpEdges } = serializeMesh(mesh);
  return { positions, faces, materialIndices, smooth, wireEdges, sharpEdges };
}

/**
 * Whether the object is still the primitive it was added as, so `scene.add`
 * makes it again. Checked against a fresh one rather than taken on trust:
 * every path that edits a mesh has to let go of the parameters, and one that
 * forgot would otherwise be written as the shape from before the edit.
 */
function isLivePrimitive(object: SceneObject): boolean {
  if (!object.primitive) return false;
  const { kind, params } = object.primitive;
  const fresh = JSON.stringify(geometry(createPrimitive(kind, params)));
  return fresh === JSON.stringify(geometry(object.mesh));
}

function shapeFields({ kind, params }: NonNullable<SceneObject['primitive']>): Field[] {
  const defaults = { ...DEFAULT_PRIMITIVE_PARAMS, ...PRIMITIVE_DEFAULT_OVERRIDES[kind] };
  return PRIMITIVE_FIELDS[kind]
    .filter((field) => params[field] !== defaults[field])
    .map((field) => [field, literal(params[field])]);
}

function meshFields(mesh: BMesh): Field[] {
  const { positions, faces, materialIndices, smooth, wireEdges, sharpEdges } = geometry(mesh);
  const pair = ([a, b]: [number, number]) => `[${a}, ${b}]`;
  const verts: string[] = [];
  for (let index = 0; index < positions.length; index += 3) {
    verts.push(vec(vec3(positions[index], positions[index + 1], positions[index + 2])));
  }

  const fields: Field[] = [
    list('verts', verts),
    list(
      'faces',
      faces.map((ring) => `[${ring.join(', ')}]`),
    ),
  ];
  if (wireEdges.length > 0) fields.push(list('edges', wireEdges.map(pair)));
  if (smooth.every(Boolean) && smooth.length > 0) fields.push(['smooth', 'true']);
  else if (smooth.some(Boolean)) fields.push(list('smooth', smooth.map(String)));
  if (materialIndices.some((slot) => slot !== 0)) {
    fields.push(list('faceMaterials', materialIndices.map(String)));
  }
  if (sharpEdges.length > 0) fields.push(list('sharp', sharpEdges.map(pair)));
  return fields;
}

const modifierDefaults = new Map<ModifierType, Record<string, unknown>>();

/** A modifier's settings that differ from a new one's, as `addModifier` takes them. */
function modifierFields(modifier: Modifier): Field[] {
  let defaults = modifierDefaults.get(modifier.type);
  if (!defaults) {
    defaults = createModifier(modifier.type) as unknown as Record<string, unknown>;
    modifierDefaults.set(modifier.type, defaults);
  }
  const values = modifier as unknown as Record<string, unknown>;
  const fields: Field[] = [];
  if (modifier.name !== defaults.name) fields.push(['name', str(modifier.name)]);
  if (!modifier.enabled) fields.push(['enabled', 'false']);
  for (const { name } of MODIFIER_FIELDS[modifier.type]) {
    const value = values[name];
    if (value !== undefined && literal(value) !== literal(defaults[name])) {
      fields.push([name, literal(value)]);
    }
  }
  return fields;
}

const sameModifiers = (a: readonly Modifier[], b: readonly Modifier[]) =>
  a.length === b.length &&
  a.every(
    (modifier, index) =>
      literal({ ...modifier, id: undefined }) === literal({ ...b[index], id: undefined }),
  );

// ------------------------------------------------------------------- the script

/** The statement that makes an object, written once it is known whether anything names it. */
interface Creation {
  object: SceneObject;
  code: (prefix: string) => string;
}

type Statement = string | Creation;

export interface SceneScript {
  source: string;
  /** What the scene holds that no call makes, each noted in the source by a comment. */
  gaps: number;
}

export type SceneState = Pick<EditorStore, 'objects' | 'groups' | 'cursor'>;

/** The scene as the script that builds it, run on a new project. Empty for an empty scene. */
export function sceneScript({ objects, groups, cursor }: SceneState): SceneScript {
  const variables = new Map<string, string>();
  const taken = new Set(RESERVED);
  /** The object's variable, which also says its creation has to declare one. */
  const variableOf = (object: SceneObject) => {
    let variable = variables.get(object.id);
    if (!variable) {
      variable = variableFor(object.name, taken);
      variables.set(object.id, variable);
    }
    return variable;
  };

  let gaps = 0;
  const gap = (note: string) => {
    gaps += 1;
    return `// ${note}`;
  };

  /** The objects written, by id, with the modifiers their lines leave on them. */
  const written = new Map<string, Modifier[]>();

  function materialLines(object: SceneObject, from: readonly Material[]): string[] {
    const lines: string[] = [];
    const slot = (index: number) => `${variableOf(object)}.materials[${index}]`;
    object.materials.forEach((material, index) => {
      const was = from[index];
      if (!was) {
        const fields: Field[] = [];
        if (!MADE_NAME.test(material.name)) fields.push(['name', str(material.name)]);
        if (!sameColor(material.color, DEFAULT_MATERIAL_COLOR)) {
          fields.push(['color', color(material.color)]);
        }
        lines.push(invoke('', `${variableOf(object)}.addMaterial`, [], fields));
        return;
      }
      const renamed = !(MADE_NAME.test(material.name) && MADE_NAME.test(was.name));
      if (material.name !== was.name && renamed) {
        lines.push(`${slot(index)}.name = ${str(material.name)};`);
      }
      if (!sameColor(material.color, was.color)) {
        lines.push(`${slot(index)}.color = ${color(material.color)};`);
      }
    });
    // From the end, so no face is moved off a slot it keeps.
    for (let index = from.length - 1; index >= object.materials.length; index--) {
      lines.push(`${slot(index)}.remove();`);
    }
    return lines;
  }

  function modifierLines(object: SceneObject, from: readonly Modifier[]): string[] {
    const scriptable = object.modifiers.filter((modifier) => modifier.type !== 'lattice');
    written.set(object.id, scriptable);
    const rebuild = !sameModifiers(from, scriptable);
    const lines: string[] = [];
    if (rebuild) {
      for (let index = from.length - 1; index >= 0; index--) {
        lines.push(`${variableOf(object)}.modifiers[${index}].remove();`);
      }
    }
    for (const modifier of object.modifiers) {
      if (modifier.type === 'lattice') {
        lines.push(
          gap(
            `${object.name}: its ${modifier.name} modifier needs a lattice cage, which a script cannot add`,
          ),
        );
      } else if (rebuild) {
        lines.push(
          invoke(
            '',
            `${variableOf(object)}.addModifier`,
            [str(modifier.type)],
            modifierFields(modifier),
          ),
        );
      }
    }
    return lines;
  }

  function newObject(object: SceneObject): Statement[] {
    const live = isLivePrimitive(object) ? object.primitive : null;
    const { name, place } = placement(object, live ? PRIMITIVE_LABELS[live.kind] : 'MESH');
    const first = object.materials[0];
    const painted = first && !sameColor(first.color, DEFAULT_MATERIAL_COLOR);
    if (painted) place.push(['color', color(first.color)]);

    const creation: Creation = {
      object,
      code: (prefix) =>
        live
          ? invoke(prefix, 'scene.add', [str(live.kind)], [...shapeFields(live), ...name, ...place])
          : invoke(prefix, 'scene.addMesh', [], [...name, ...meshFields(object.mesh), ...place]),
    };
    const slot = painted ? { ...NEW_SLOT, color: first.color } : NEW_SLOT;
    return [creation, ...materialLines(object, [slot]), ...modifierLines(object, [])];
  }

  /**
   * A linked duplicate, which shares its mesh with `owner`. It starts as a copy
   * of everything the owner's lines left, and says only how it differs.
   */
  function linkedCopy(object: SceneObject, owner: SceneObject): Statement[] {
    const source = variableOf(owner);
    const variable = () => variableOf(object);
    const lines: Statement[] = [
      { object, code: (prefix) => `${prefix}${source}.duplicate(true);` },
    ];
    if (object.name !== `${owner.name}.COPY`) {
      lines.push(`${variable()}.name = ${str(object.name)};`);
    }
    const was = owner.transform;
    const now = object.transform;
    if (vec(now.position) !== vec(was.position)) {
      lines.push(`${variable()}.position = ${vec(now.position)};`);
    }
    if (degrees(now.rotation) !== degrees(was.rotation)) {
      lines.push(`${variable()}.rotation = ${degrees(now.rotation)};`);
    }
    if (scaleCode(now.scale) !== scaleCode(was.scale)) {
      lines.push(`${variable()}.scale = ${scaleCode(now.scale)};`);
    }
    return [
      ...lines,
      ...materialLines(object, owner.materials),
      ...modifierLines(object, written.get(owner.id) ?? []),
    ];
  }

  const blocks: Statement[][] = [];
  const owners = new Map<BMesh, SceneObject>();
  for (const object of objects) {
    if (object.image) {
      blocks.push([gap(`${object.name}: an image, which a script cannot add`)]);
      continue;
    }
    if (object.lattice) {
      blocks.push([gap(`${object.name}: a lattice cage, which a script cannot add`)]);
      continue;
    }
    const owner = owners.get(object.mesh);
    if (!owner) owners.set(object.mesh, object);
    blocks.push(owner ? linkedCopy(object, owner) : newObject(object));
  }

  const included = objects.filter((object) => written.has(object.id));
  const folders = groups.flatMap((group) => {
    const members = included.filter((object) => object.groupId === group.id).map(variableOf);
    if (members.length === 0) return [];
    const inline = `scene.group([${members.join(', ')}], ${str(group.name)});`;
    return inline.length <= WIDTH
      ? inline
      : `scene.group([\n${rows(members, '  ')}\n], ${str(group.name)});`;
  });
  // Last, so nothing above meets an object it cannot change.
  const flags = included.flatMap((object) => [
    ...(object.visible ? [] : [`${variableOf(object)}.visible = false;`]),
    ...(object.locked ? [`${variableOf(object)}.locked = true;`] : []),
  ]);
  // Last of all: an object added without a position goes where the cursor is.
  const place = vec(cursor) === '[0, 0, 0]' ? [] : [`scene.cursor = ${vec(cursor)};`];

  const render = (statement: Statement) => {
    if (typeof statement === 'string') return statement;
    const variable = variables.get(statement.object.id);
    return statement.code(variable ? `const ${variable} = ` : '');
  };
  // One-line objects sit together; anything longer stands apart, as does each
  // part after the objects.
  const objectTexts = blocks.map((block) => block.map(render).join('\n'));
  const parts = [
    objectTexts.reduce((text, block, index) => {
      if (index === 0) return block;
      const apart = block.includes('\n') || objectTexts[index - 1].includes('\n');
      return `${text}${apart ? '\n\n' : '\n'}${block}`;
    }, ''),
    ...[folders, flags, place].map((lines) => lines.join('\n')),
  ];
  return { source: parts.filter((part) => part !== '').join('\n\n'), gaps };
}
