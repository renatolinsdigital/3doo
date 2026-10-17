import {
  type Vec3,
  exportFBX,
  exportOBJ,
  importFBX,
  importOBJ,
  STRAIGHT_VIEWS,
  VIEW_PLANES,
  parseProject,
  radToDeg,
  resolveExportOptions,
} from '@kernel/index';
import { evaluatedMesh, useEditorStore } from '@store/index';
import type { ShadingMode } from '@store/types';
import {
  SNAPSHOT_VIEWS,
  type SnapshotAngle,
  type SnapshotProjection,
  type SnapshotShading,
  renderSnapshots,
} from '@viewport/snapshot';

import {
  addReference,
  compareWithModel,
  getReference,
  referenceFrame,
  summarize,
  traceReference,
} from '@domain/references/references';
import { readFields, worldBounds } from '@domain/scripting/api';
import { SCRIPT_EXAMPLES } from '@domain/scripting/examples';
import { runScript } from '@domain/scripting/runScript';
import { exportObjects, exportPictures, hydrateAssets, projectText } from '@domain/services/assets';
import { withoutProjectSuffix } from '@domain/services/download';
import { MAX_SCENE_LINK_LENGTH, sceneLink } from '@domain/services/sceneLink';

import {
  API_ENTRIES,
  type ApiOwner,
  MODIFIER_TYPES,
  OPERATOR_SPECS,
  PRIMITIVE_KINDS,
  REFERENCE_OPTIONS,
} from '@domain/scripting/reference';

import { type DocsBlock, scriptingApiBlocks } from '../../modules/docs/content';

import {
  composeSheet,
  decodePicture,
  drawComparison,
  drawReference,
  rasterOf,
  sheetLayout,
  silhouetteMask,
} from './pictures';
import {
  AUTOMATION_VERSION,
  type AutomationApi,
  type CompareRequest,
  type ComparisonData,
  type ExportRequest,
  type ExportedFile,
  type LoadReferenceRequest,
  type LoadedReference,
  type ObjectSummary,
  type OpenRequest,
  type ReferenceRequest,
  type ReferenceTraceData,
  type RenderRequest,
  type RenderedView,
  type SceneSummary,
  type ShareLink,
  type TraceRequest,
  type Vec3Data,
} from './types';

const SHADING_MODES: readonly ShadingMode[] = ['solid', 'solidWire', 'wireframe', 'xray', 'matcap'];
const SHADINGS: readonly SnapshotShading[] = [...SHADING_MODES, 'silhouette'];
const PROJECTIONS: readonly SnapshotProjection[] = ['auto', 'perspective', 'orthographic'];
const PRESETS = ['unity', 'unreal', 'blender', 'maya'] as const;
const MAX_PICTURE_SIDE = 2048;

const store = () => useEditorStore.getState();

// ------------------------------------------------------------------ bytes

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const textBase64 = (text: string) => bytesToBase64(new TextEncoder().encode(text));

// ---------------------------------------------------------------- summary

const round = (value: number) => Math.round(value * 1e4) / 1e4;
const vec = (v: Vec3): Vec3Data => ({ x: round(v.x), y: round(v.y), z: round(v.z) });

function hex(color: { r: number; g: number; b: number }): string {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** What is in the scene, in the terms a script uses: names, metres and degrees. */
export function sceneSummary(): SceneSummary {
  const state = store();
  let vertices = 0;
  let faces = 0;

  const objects = state.objects.map((object): ObjectSummary => {
    const mesh = evaluatedMesh(object, undefined, undefined, state.objects);
    if (object.visible) {
      vertices += mesh.verts.size;
      faces += mesh.faces.size;
    }
    const { rotation } = object.transform;
    return {
      name: object.name,
      vertices: mesh.verts.size,
      edges: mesh.edges.size,
      faces: mesh.faces.size,
      position: vec(object.transform.position),
      rotation: vec({ x: radToDeg(rotation.x), y: radToDeg(rotation.y), z: radToDeg(rotation.z) }),
      scale: vec(object.transform.scale),
      dimensions: vec(worldBounds([object])?.size ?? { x: 0, y: 0, z: 0 }),
      color: hex((object.materials[0] ?? { color: { r: 0.8, g: 0.8, b: 0.8 } }).color),
      modifiers: object.modifiers.map((modifier) => modifier.type),
      visible: object.visible,
      group: state.groups.find((group) => group.id === object.groupId)?.name ?? null,
    };
  });

  const bounds = worldBounds(state.objects.filter((object) => object.visible));
  return {
    name: state.projectName,
    objects,
    totals: { objects: objects.length, vertices, faces },
    bounds: bounds ? { min: vec(bounds.min), max: vec(bounds.max), size: vec(bounds.size) } : null,
  };
}

// --------------------------------------------------------------- checking

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  what: string,
  fallback: T,
): T {
  if (value === undefined || value === null) return fallback;
  const match = values.find((candidate) => candidate === value);
  if (match) return match;
  throw new Error(`${what} has to be one of ${values.join(', ')}, not ${JSON.stringify(value)}.`);
}

function side(value: unknown, what: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 16 ||
    value > MAX_PICTURE_SIDE
  ) {
    throw new Error(`${what} has to be a whole number of pixels from 16 to ${MAX_PICTURE_SIDE}.`);
  }
  return value;
}

/** A file name without folders or the extension the format adds. */
function fileStem(name: unknown, extension: string): string {
  const raw =
    typeof name === 'string' && name.trim() !== '' ? name : store().projectName || 'model';
  const base = raw.split(/[\\/]/).pop() ?? raw;
  const stem = base.replace(new RegExp(`\\.${extension}$`, 'i'), '').trim();
  return stem.replace(/[<>:"|?*]/g, '_') || 'model';
}

// ------------------------------------------------------------------ files

async function exportFile(request: ExportRequest): Promise<ExportedFile[]> {
  const format = oneOf(request?.format, ['3doo', 'obj', 'fbx'] as const, 'format', '3doo');
  const state = store();

  if (format === '3doo') {
    const name = fileStem(request.name, '3doo');
    const document = { ...state.snapshotDocument(), name };
    const text = await projectText(document, state.assets);
    return [{ name: `${name}.3doo`, mimeType: 'application/json', base64: textBase64(text) }];
  }

  const chosen = state.objects.filter((object) => object.visible && !object.lattice);
  if (chosen.length === 0) {
    throw new Error('Nothing to export: the scene is empty or every object is hidden.');
  }

  const preset =
    request.preset === undefined ? undefined : oneOf(request.preset, PRESETS, 'preset', 'unity');
  if (request.triangulate !== undefined && typeof request.triangulate !== 'boolean') {
    throw new Error('triangulate has to be true or false.');
  }
  const options = resolveExportOptions({
    ...state.exportOptions,
    ...(preset ? { preset } : {}),
    ...(request.triangulate !== undefined ? { triangulate: request.triangulate } : {}),
  });

  const name = fileStem(request.name, format).replace(/\s+/g, '_');
  const pictures = await exportPictures(chosen, state.assets);
  const objects = exportObjects(chosen, pictures, state.objects);

  if (format === 'fbx') {
    return [
      {
        name: `${name}.fbx`,
        mimeType: 'application/octet-stream',
        base64: bytesToBase64(exportFBX(objects, options)),
      },
    ];
  }

  const library = `${name}.mtl`;
  const { obj, mtl } = exportOBJ(objects, options, library);
  return [
    { name: `${name}.obj`, mimeType: 'text/plain', base64: textBase64(obj) },
    { name: library, mimeType: 'text/plain', base64: textBase64(mtl) },
    ...[...pictures.values()].map((picture) => ({
      name: picture.fileName,
      mimeType: picture.type,
      base64: bytesToBase64(picture.data),
    })),
  ];
}

async function open(request: OpenRequest): Promise<SceneSummary> {
  const name = typeof request?.name === 'string' ? request.name : '';
  if (typeof request?.base64 !== 'string') throw new Error('open needs the file as base64.');
  const bytes = base64ToBytes(request.base64);
  const lower = name.toLowerCase();
  const state = store();

  if (lower.endsWith('.3doo')) {
    const document = parseProject(new TextDecoder().decode(bytes));
    state.loadProjectDocument(
      { ...document, name: withoutProjectSuffix(name.split(/[\\/]/).pop() ?? name) },
      true,
      hydrateAssets(document.assets ?? []),
    );
    state.clearHistory();
    return sceneSummary();
  }

  if (lower.endsWith('.obj') || lower.endsWith('.fbx')) {
    const imported = lower.endsWith('.fbx')
      ? await importFBX(bytes)
      : importOBJ(new TextDecoder().decode(bytes));
    if (imported.length === 0) throw new Error(`No geometry found in ${name}.`);
    state.addImportedObjects(imported, name);
    return sceneSummary();
  }

  throw new Error(`${name || 'That file'} is not a .3doo, .obj or .fbx file.`);
}

/** A number in a range, as a request field. */
function within(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(
      `${what} has to be a number from ${min} to ${max}, not ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function readCameras(value: unknown): SnapshotAngle[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('cameras has to be a list of { yaw, pitch } angles, in degrees.');
  }
  return value.map((camera, index) => {
    const what = `cameras[${index}]`;
    if (camera === null || typeof camera !== 'object' || Array.isArray(camera)) {
      throw new Error(`${what} has to be { yaw, pitch } in degrees, with fov if wanted.`);
    }
    const { yaw, pitch, fov, ...rest } = camera as Record<string, unknown>;
    const extra = Object.keys(rest)[0];
    if (extra) throw new Error(`${what} has no "${extra}": it takes yaw, pitch and fov.`);
    return {
      yaw: within(yaw, `${what}.yaw`, -360, 360),
      pitch: within(pitch, `${what}.pitch`, -90, 90),
      ...(fov === undefined ? {} : { fov: within(fov, `${what}.fov`, 5, 120) }),
    };
  });
}

const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);

async function render(request: RenderRequest): Promise<RenderedView[]> {
  const cameras = readCameras(request?.cameras);
  const asked = request?.views ?? (cameras.length > 0 ? [] : ['perspective']);
  if (!Array.isArray(asked) || asked.length + cameras.length === 0) {
    throw new Error(`views has to be a list of one or more of ${SNAPSHOT_VIEWS.join(', ')}.`);
  }
  const views = asked.map((view) => oneOf(view, SNAPSHOT_VIEWS, 'Each view', 'perspective'));
  const shots = [...new Set(views), ...cameras];
  const width = side(request.width, 'width', 800);
  const height = side(request.height, 'height', 600);
  const shading = oneOf(request.shading, SHADINGS, 'shading', 'solidWire');
  if (request.sheet !== undefined && typeof request.sheet !== 'boolean') {
    throw new Error('sheet has to be true or false.');
  }

  // A sheet's views share its size, each drawn at the size of its cell.
  const { columns, rows } = request.sheet ? sheetLayout(shots.length) : { columns: 1, rows: 1 };
  const cell = { width: Math.floor(width / columns), height: Math.floor(height / rows) };
  if (cell.width < 16 || cell.height < 16) {
    throw new Error(
      `A sheet ${width} by ${height} is too small for ${shots.length} views: make it larger.`,
    );
  }

  const pictures = await renderSnapshots(shots, {
    ...cell,
    shading,
    projection: oneOf(request.projection, PROJECTIONS, 'projection', 'auto'),
    grid: request.grid ?? true,
  });
  if (!request.sheet) {
    return pictures.map((picture) => ({ view: picture.view, base64: base64Of(picture.dataUrl) }));
  }
  const background = shading === 'silhouette' ? '#ffffff' : store().viewportBackground;
  const sheet = await composeSheet(
    pictures.map((picture) => ({ label: picture.view, dataUrl: picture.dataUrl })),
    width,
    height,
    background,
  );
  return [{ view: pictures.map((picture) => picture.view).join(', '), base64: sheet }];
}

// ------------------------------------------------------------- references

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

async function loadReference(request: LoadReferenceRequest): Promise<LoadedReference> {
  if (typeof request?.id !== 'string' || request.id.trim() === '') {
    throw new Error('A reference needs an id to be called by, such as "front".');
  }
  if (typeof request.base64 !== 'string')
    throw new Error('loadReference needs the picture as base64.');
  if (request.view === undefined) {
    throw new Error(`view is required: one of ${STRAIGHT_VIEWS.join(', ')}.`);
  }
  const view = oneOf(request.view, STRAIGHT_VIEWS, 'view', 'front');
  const { height, width } = request;
  if ((height === undefined) === (width === undefined)) {
    throw new Error(
      'Give the subject one size in metres: height (how tall it is in the picture) or width (how wide).',
    );
  }
  const size = (value: unknown, what: string) => within(value, what, 1e-4, 1e5);
  const crop = request.crop;
  if (
    crop !== undefined &&
    (!Array.isArray(crop) || crop.length !== 4 || !crop.every((n) => Number.isFinite(n)))
  ) {
    throw new Error("crop has to be [x, y, width, height] in the picture's pixels.");
  }
  const background = request.background ?? 'auto';
  if (background !== 'auto' && (typeof background !== 'string' || !HEX.test(background))) {
    throw new Error(`background has to be "auto" or "#rrggbb", not ${JSON.stringify(background)}.`);
  }
  if (request.holes !== undefined && typeof request.holes !== 'boolean') {
    throw new Error('holes has to be true or false.');
  }

  const raster = await decodePicture(
    base64ToBytes(request.base64),
    crop?.map((n) => Math.round(n)),
  );
  const reference = addReference({
    id: request.id.trim(),
    view,
    source: typeof request.name === 'string' && request.name ? request.name : 'the picture',
    raster,
    height: height === undefined ? undefined : size(height, 'height'),
    width: width === undefined ? undefined : size(width, 'width'),
    background,
    tolerance:
      request.tolerance === undefined ? undefined : within(request.tolerance, 'tolerance', 0, 1),
    holes: request.holes,
  });
  return { summary: summarize(reference), base64: drawReference(reference) };
}

function traceReferenceData(request: TraceRequest): ReferenceTraceData {
  if (typeof request?.id !== 'string') throw new Error('Name the reference to trace by its id.');
  const options = readFields('trace_reference', REFERENCE_OPTIONS, {
    points: request.points,
    rows: request.rows,
  });
  return traceReference(getReference(request.id), options);
}

/** The ids of the objects, and of the objects in the folders, these names name. */
function namedObjects(names: unknown): Set<string> {
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
    throw new Error('objects has to be a list of object or folder names.');
  }
  const state = store();
  const ids = new Set<string>();
  for (const name of names as string[]) {
    const wanted = name.toLowerCase();
    const group = state.groups.find((candidate) => candidate.name.toLowerCase() === wanted);
    const found = state.objects.filter(
      (object) => object.name.toLowerCase() === wanted || (group && object.groupId === group.id),
    );
    if (found.length === 0) throw new Error(`There is no object or folder called "${name}".`);
    for (const object of found) ids.add(object.id);
  }
  return ids;
}

async function compareReference(request: CompareRequest): Promise<ComparisonData> {
  if (typeof request?.id !== 'string')
    throw new Error('Name the reference to compare with by its id.');
  const reference = getReference(request.id);
  const objects = request.objects === undefined ? undefined : namedObjects(request.objects);
  const [shot] = await renderSnapshots([{ view: reference.view, ...referenceFrame(reference) }], {
    width: reference.raster.width,
    height: reference.raster.height,
    shading: 'silhouette',
    projection: 'orthographic',
    grid: false,
    objects,
  });
  const model = silhouetteMask(await rasterOf(shot.dataUrl));
  return {
    id: reference.id,
    view: reference.view,
    axes: VIEW_PLANES[reference.view],
    ...compareWithModel(reference, model),
    base64: drawComparison(reference, model),
  };
}

async function shareLink(appUrl: string): Promise<ShareLink> {
  let parsed: URL;
  try {
    parsed = new URL(appUrl);
  } catch {
    throw new Error(
      `The app address has to be a full http(s) address, not ${JSON.stringify(appUrl)}.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The app address has to start with http:// or https://.');
  }
  const state = store();
  const url = await sceneLink(appUrl, await projectText(state.snapshotDocument(), state.assets));
  if (url.length > MAX_SCENE_LINK_LENGTH) {
    throw new Error(
      `The scene is too big for a link (${url.length} characters, the limit is ${MAX_SCENE_LINK_LENGTH}). Export a .3doo instead.`,
    );
  }
  return { url, length: url.length };
}

// -------------------------------------------------------------- reference

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function blockMarkdown(block: DocsBlock): string {
  if (block.kind === 'prose') return block.text;
  if (block.kind === 'note') return `> ${block.text}`;
  if (block.kind === 'steps') return block.items.map((item, i) => `${i + 1}. ${item}`).join('\n');
  return [
    `| ${cell(block.head[0])} | ${cell(block.head[1])} |`,
    '| --- | --- |',
    ...block.rows.map((row) => `| \`${cell(row[0])}\` | ${cell(row[1])} |`),
  ].join('\n');
}

const CONVENTIONS = `A script is the body of an async JavaScript function that gets two globals,
\`scene\` and \`view\`. It runs against the scene as it stands: empty after a
reset, or whatever earlier scripts and opened files left. Everything a script
hands the API is checked, and a mistake stops the run with the reason and the
line, leaving the scene exactly as it was before the run.

- Units are metres. Rotations are degrees. +Y is up.
- The front view looks from +Z towards the origin, the right view from +X,
  and the top view down from +Y.
- \`await\` works at the top level, which \`scene.boolean\` needs.
- \`return\` hands a value back as the run's message: text as it is, anything
  else as JSON. \`return box.bounds\` reads where an object sits, and
  \`return box.modifiers\` its stack with every setting.
- \`console.log\` lines come back too, one per call, values as JSON the same way.
- \`view\` moves the editor's own camera, which pictures do not use:
  \`render_views\` frames the model itself and takes the shading as an argument.`;

const WHAT_A_SCRIPT_CAN_DO = `- Add the ten primitives, or build any mesh from a list of points and faces
  (\`scene.add\`, \`scene.addMesh\`), each named, placed, turned, scaled and
  coloured as it is added.
- Build solids from points: turn a profile round the Y axis (\`scene.lathe\`),
  or make a flat outline solid (\`scene.extrudeOutline\`).
- Read a picture loaded with \`load_reference\` (\`scene.reference\`): its
  outline, how wide it is at each height and its colours, in world metres.
- Move, turn, scale, rename, hide, lock, duplicate (plain or linked) and delete
  objects; join them, split them into loose parts, put them in outliner
  folders, and cut them with booleans.
- Edit a mesh the way edit mode does (\`object.edit\`): select vertices, edges or
  faces with a test function, run any modelling operation on the selection,
  move vertices to computed points with \`mesh.deform\`, and read every vertex,
  edge and face back.
- Stack, set, reorder and apply modifiers: mirror, array, solidify, bend,
  twist, lattice, weld, subdivide, subsurf, quadify, triangulate and remesh.
- Colour objects, and give parts of one mesh colours of their own through
  material slots (\`object.addMaterial\`, \`mesh.assignMaterial\`).
- Read the scene back: transforms, world bounds, counts, modifier settings,
  colours and the project name, which exported files are named after.`;

const HOW_A_SCRIPT_WORKS = `- An operation acts on the selection, as its button does in edit mode, and
  leaves what it made selected: select the top face, extrude, then inset, and
  the inset lands on the extruded face.
- Inside \`object.edit\`, coordinates are the object's own, before its position,
  rotation and scale. \`object.applyTransform()\` bakes rotation and scale into
  the vertices first, when edit coordinates should match the world's.
- A modifier changes what is drawn and exported, not the mesh \`object.edit\`
  works on, until it is applied. \`scene.boolean\` refuses an object with a
  live modifier, and uses its cutters up: duplicate one first to keep it.
- \`addModifier('lattice')\` also adds a cage around the mesh, an object named
  after it with \`.CAGE\` on the end. Move that object's vertices with
  \`mesh.deform\` to shape the mesh; a cage takes no other mesh operation.
- \`object.bounds\` places one part against another: a lamp stands on a table
  at \`table.bounds.max.y\`.
- \`scene.reference(id)\` is a loaded picture in world metres, its subject
  standing at the origin. Its \`outline\` goes straight into
  \`scene.extrudeOutline(ref.outline, { view: ref.view })\`, and its \`profile\`
  rows \`{ at, from, to }\` give \`scene.lathe\` its radii. With the 3D cursor at
  the origin, what you build lines up with the picture.
- Build a model over several short scripts rather than one long one. Each run
  is checked on its own, and a failure takes back only that run.`;

/** Runs as it is written: a test holds it to the API. */
export const QUICKSTART_SCRIPT = `const top = scene.add('cube', { name: 'TOP', position: [0, 0.75, 0], scale: [1.6, 0.06, 0.8], color: '#b8452f' });
const leg = scene.add('cylinder', { name: 'LEG', radius: 0.04, height: 0.72, position: [0.7, 0.36, 0.3], color: '#3a2a20' });
top.edit((mesh) => {
  mesh.selectFaces((face) => face.normal.y > 0.9);
  mesh.inset({ thickness: 0.05 });
});
scene.group([top, leg], 'TABLE');
return top.bounds;`;

const OWNERS: readonly ApiOwner[] = ['scene', 'object', 'mesh', 'modifier', 'material', 'view'];

/** Every name a script can reach as a signature, with what each does left to the `api` topic. */
function nameIndex(): string {
  const operations = new Set(OPERATOR_SPECS.map((spec) => spec.name));
  const lines = OWNERS.map((owner) => {
    const signatures = API_ENTRIES.filter(
      (entry) => entry.owner === owner && !(owner === 'mesh' && operations.has(entry.name)),
    ).map((entry) => entry.signature);
    return `- ${signatures.map((signature) => `\`${signature}\``).join(', ')}`;
  });
  const operationList = OPERATOR_SPECS.map((spec) => {
    const params = spec.params.map((field) => field.name).join(', ');
    return `\`mesh.${spec.name}(${params ? `{ ${params} }` : ''})\``;
  });
  return [
    ...lines,
    `- Operations, on the selection: ${operationList.join(', ')}`,
    `- Primitives for \`scene.add\`: ${PRIMITIVE_KINDS.join(', ')}`,
    `- Modifier types for \`object.addModifier\`: ${MODIFIER_TYPES.join(', ')}`,
  ].join('\n');
}

const exampleMarkdown = (example: { label: string; source: string }) =>
  `### ${example.label}\n\n\`\`\`js\n${example.source.trim()}\n\`\`\``;

const apiMarkdown = () => ['## API', ...scriptingApiBlocks().map(blockMarkdown)];
const examplesMarkdown = () => ['## Examples', ...SCRIPT_EXAMPLES.map(exampleMarkdown)];

const REFERENCE_TOPICS = ['quickstart', 'api', 'examples', 'all'];

function quickstart(): string {
  const ids = SCRIPT_EXAMPLES.map((example) => `${example.id} (${example.label})`).join(', ');
  return (
    [
      '# 3DOO scripting quickstart',
      CONVENTIONS,
      '## A first script',
      `\`\`\`js\n${QUICKSTART_SCRIPT}\n\`\`\``,
      '## Every name',
      nameIndex(),
      '## How a script works',
      HOW_A_SCRIPT_WORKS,
      '## Going further',
      [
        'This page is enough to write a script. Ask for more only when a name or option is unclear:',
        '- `topic: "api"`: what every name does, with its options, ranges and the values a choice takes.',
        `- \`example: "<id>"\`: one finished model to copy from. The ids are ${ids}.`,
        '- `topic: "all"`: everything at once, which is long.',
      ].join('\n'),
    ].join('\n\n') + '\n'
  );
}

/**
 * The scripting reference as Markdown. With no request it is the quickstart:
 * the conventions, a script that runs, every name and the rules a table does
 * not say. `api` adds what each name does, from the catalogue the API validates
 * against, and the finished examples the editor ships come with `examples` or
 * one at a time with `example`.
 */
export function scriptingReference(request: ReferenceRequest = {}): string {
  const { topic = 'quickstart', example } = request;
  if (example !== undefined) {
    const wanted = example.trim().toLowerCase();
    const found = SCRIPT_EXAMPLES.find(
      (candidate) => candidate.id === wanted || candidate.label.toLowerCase() === wanted,
    );
    if (!found) {
      const ids = SCRIPT_EXAMPLES.map((candidate) => candidate.id).join(', ');
      throw new Error(`There is no example "${example}". The examples are ${ids}.`);
    }
    return `${exampleMarkdown(found)}\n`;
  }
  if (!REFERENCE_TOPICS.includes(topic)) {
    throw new Error(`There is no topic "${topic}". The topics are ${REFERENCE_TOPICS.join(', ')}.`);
  }
  if (topic === 'quickstart') return quickstart();
  if (topic === 'api')
    return ['# 3DOO scripting API', ...apiMarkdown().slice(1)].join('\n\n') + '\n';
  if (topic === 'examples')
    return ['# 3DOO scripting examples', ...examplesMarkdown().slice(1)].join('\n\n') + '\n';
  return (
    [
      '# 3DOO scripting reference',
      CONVENTIONS,
      '## What a script can do',
      WHAT_A_SCRIPT_CAN_DO,
      '## How a script works',
      HOW_A_SCRIPT_WORKS,
      ...apiMarkdown(),
      ...examplesMarkdown(),
    ].join('\n\n') + '\n'
  );
}

// ---------------------------------------------------------------- install

export function createAutomationApi(): AutomationApi {
  return {
    version: AUTOMATION_VERSION,
    reset: () => store().resetScene(),
    run: async (source) => {
      if (typeof source !== 'string') throw new Error('run needs the script as text.');
      const outcome = await runScript(source);
      return {
        ok: outcome.ok,
        message: outcome.message,
        line: outcome.ok ? null : outcome.line,
        logs: outcome.logs,
        scene: sceneSummary(),
      };
    },
    open,
    scene: sceneSummary,
    exportFile,
    render,
    shareLink,
    reference: scriptingReference,
    loadReference,
    traceReference: traceReferenceData,
    compareReference,
  };
}

declare global {
  interface Window {
    threedoo?: AutomationApi;
  }
}

/** Puts the API on `window.threedoo`, where the MCP server's headless browser finds it. */
export function installAutomation(): void {
  window.threedoo = createAutomationApi();
}
