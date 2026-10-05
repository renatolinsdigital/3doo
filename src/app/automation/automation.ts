import {
  type Vec3,
  exportFBX,
  exportOBJ,
  importFBX,
  importOBJ,
  parseProject,
  radToDeg,
  resolveExportOptions,
} from '@kernel/index';
import { evaluatedMesh, useEditorStore } from '@store/index';
import type { ShadingMode } from '@store/types';
import { SNAPSHOT_VIEWS, type SnapshotProjection, renderSnapshots } from '@viewport/snapshot';

import { worldBounds } from '@domain/scripting/api';
import { SCRIPT_EXAMPLES } from '@domain/scripting/examples';
import { runScript } from '@domain/scripting/runScript';
import { exportObjects, exportPictures, hydrateAssets, projectText } from '@domain/services/assets';
import { withoutProjectSuffix } from '@domain/services/download';
import { MAX_SCENE_LINK_LENGTH, sceneLink } from '@domain/services/sceneLink';

import { type DocsBlock, scriptingApiBlocks } from '../../modules/docs/content';

import {
  AUTOMATION_VERSION,
  type AutomationApi,
  type ExportRequest,
  type ExportedFile,
  type ObjectSummary,
  type OpenRequest,
  type RenderRequest,
  type RenderedView,
  type SceneSummary,
  type ShareLink,
  type Vec3Data,
} from './types';

const SHADING_MODES: readonly ShadingMode[] = ['solid', 'solidWire', 'wireframe', 'xray', 'matcap'];
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
    const mesh = evaluatedMesh(object);
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

  const chosen = state.objects.filter((object) => object.visible);
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
  const objects = exportObjects(chosen, pictures);

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

async function render(request: RenderRequest): Promise<RenderedView[]> {
  const asked = request?.views ?? ['perspective'];
  if (!Array.isArray(asked) || asked.length === 0) {
    throw new Error(`views has to be a list of one or more of ${SNAPSHOT_VIEWS.join(', ')}.`);
  }
  const views = asked.map((view) => oneOf(view, SNAPSHOT_VIEWS, 'Each view', 'perspective'));
  const shots = await renderSnapshots([...new Set(views)], {
    width: side(request.width, 'width', 800),
    height: side(request.height, 'height', 600),
    shading: oneOf(request.shading, SHADING_MODES, 'shading', 'solidWire'),
    projection: oneOf(request.projection, PROJECTIONS, 'projection', 'auto'),
    grid: request.grid ?? true,
  });
  return shots.map((shot) => ({
    view: shot.view,
    base64: shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1),
  }));
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

const REFERENCE_INTRO = `# 3DOO scripting reference

A script is the body of an async JavaScript function that gets two globals,
\`scene\` and \`view\`. It runs against the scene as it stands: empty after a
reset, or whatever earlier scripts and opened files left. Everything a script
hands the API is checked, and a mistake stops the run with the reason and the
line, leaving the scene exactly as it was before the run.

- Units are metres. Rotations are degrees. +Y is up.
- The front view looks from +Z towards the origin, the right view from +X,
  and the top view down from +Y.
- \`await\` works at the top level, which \`scene.boolean\` needs.
- \`return 'some text'\` sends that text back as the run's message, which is
  the way to read values out of the scene.
- \`console.log\` output is sent back as well.
- \`view\` moves the editor's own camera, which pictures do not use:
  \`render_views\` frames the model itself and takes the shading as an argument.

## What a script can do

- Add the ten primitives, or build any mesh from a list of points and faces
  (\`scene.add\`, \`scene.addMesh\`), each named, placed, turned, scaled and
  coloured as it is added.
- Move, turn, scale, rename, hide, lock, duplicate (plain or linked) and delete
  objects; join them, split them into loose parts, put them in outliner
  folders, and cut them with booleans.
- Edit a mesh the way edit mode does (\`object.edit\`): select vertices, edges or
  faces with a test function, run any modelling operation on the selection,
  move vertices to computed points with \`mesh.deform\`, and read every vertex,
  edge and face back.
- Stack, set, reorder and apply modifiers: mirror, array, solidify, bend,
  twist, weld, subdivide, subsurf and remesh.
- Colour objects, and give parts of one mesh colours of their own through
  material slots (\`object.addMaterial\`, \`mesh.assignMaterial\`).
- Read the scene back: transforms, world bounds, counts, modifier settings,
  colours and the project name, which exported files are named after.

## How a script works

- An operation acts on the selection, as its button does in edit mode, and
  leaves what it made selected: select the top face, extrude, then inset, and
  the inset lands on the extruded face.
- Inside \`object.edit\`, coordinates are the object's own, before its position,
  rotation and scale. \`object.applyTransform()\` bakes rotation and scale into
  the vertices first, when edit coordinates should match the world's.
- A modifier changes what is drawn and exported, not the mesh \`object.edit\`
  works on, until it is applied. \`scene.boolean\` refuses an object with a
  live modifier, and uses its cutters up: duplicate one first to keep it.
- \`object.bounds\` places one part against another: a lamp stands on a table
  at \`table.bounds.max.y\`.
- Build a model over several short scripts rather than one long one. Each run
  is checked on its own, and a failure takes back only that run.`;

/**
 * The scripting reference as Markdown: the API half of the SCRIPTING section
 * of the in-app docs, which is built from the catalogue the API validates
 * against, followed by the examples the editor ships.
 */
export function scriptingReference(): string {
  const body = scriptingApiBlocks().map(blockMarkdown);
  const examples = SCRIPT_EXAMPLES.map(
    (example) => `### ${example.label}\n\n\`\`\`js\n${example.source.trim()}\n\`\`\``,
  );
  return [REFERENCE_INTRO, '## API', ...body, '## Examples', ...examples].join('\n\n') + '\n';
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
        scene: sceneSummary(),
      };
    },
    open,
    scene: sceneSummary,
    exportFile,
    render,
    shareLink,
    reference: scriptingReference,
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
