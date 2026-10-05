/**
 * What `window.threedoo` speaks: the editor driven from outside the page.
 *
 * The MCP server in `mcp/` drives it through a headless browser, so these
 * types are the payloads that cross that boundary. They import nothing: the
 * server reads them with `import type`, and Node runs it without resolving the
 * app's path aliases.
 */

/** Bumped when a payload changes shape, so a server can refuse an app it cannot drive. */
export const AUTOMATION_VERSION = 2;

export type Vec3Data = { x: number; y: number; z: number };

export interface ObjectSummary {
  name: string;
  /** Counts of the shape as drawn and exported, with the modifiers applied. */
  vertices: number;
  edges: number;
  faces: number;
  position: Vec3Data;
  /** Degrees, as a script writes them. */
  rotation: Vec3Data;
  scale: Vec3Data;
  /** World-space size of the shape as drawn, in metres. */
  dimensions: Vec3Data;
  /** The first material slot's colour, as `#rrggbb`. */
  color: string;
  modifiers: string[];
  visible: boolean;
  /** The outliner folder the object sits in, or null. */
  group: string | null;
}

export interface SceneSummary {
  /** The project name, which the exported files are named after by default. */
  name: string;
  objects: ObjectSummary[];
  totals: { objects: number; vertices: number; faces: number };
  /** Around every visible object, in world space, or null for an empty scene. */
  bounds: { min: Vec3Data; max: Vec3Data; size: Vec3Data } | null;
}

export interface RunReport {
  ok: boolean;
  /** What the run did, what the script returned (as JSON unless it was text), or why it failed. */
  message: string;
  /** The script line that failed, counted from 1, when it can be told. */
  line: number | null;
  /** One line per `console` call the script made, values as JSON. */
  logs: string[];
  scene: SceneSummary;
}

export type ExportFormat = '3doo' | 'obj' | 'fbx';

export interface ExportRequest {
  format: ExportFormat;
  /** File name without extension. Defaults to the project name. */
  name?: string;
  /** Axis and unit preset for OBJ and FBX. Defaults to the editor's export setting. */
  preset?: 'unity' | 'unreal' | 'blender' | 'maya';
  triangulate?: boolean;
}

export interface ExportedFile {
  name: string;
  mimeType: string;
  base64: string;
}

export interface RenderRequest {
  views?: string[];
  width?: number;
  height?: number;
  shading?: string;
  projection?: string;
  grid?: boolean;
}

export interface RenderedView {
  view: string;
  /** PNG bytes in base64, without a `data:` prefix. */
  base64: string;
}

export interface OpenRequest {
  /** The file's name, whose extension says how to read it. */
  name: string;
  base64: string;
}

export interface ShareLink {
  url: string;
  length: number;
}

export interface AutomationApi {
  /** `AUTOMATION_VERSION` of the app this is. */
  readonly version: number;
  /** Empties the scene and its undo history. */
  reset(): void;
  /** Runs a script against the scene, as one undo step that a failure takes back. */
  run(source: string): Promise<RunReport>;
  /** Opens a `.3doo` in place of the scene, or imports an OBJ or FBX into it. */
  open(request: OpenRequest): Promise<SceneSummary>;
  scene(): SceneSummary;
  exportFile(request: ExportRequest): Promise<ExportedFile[]>;
  render(request: RenderRequest): Promise<RenderedView[]>;
  /** A link that opens the scene in the editor served from `appUrl`. */
  shareLink(appUrl: string): Promise<ShareLink>;
  /** The scripting reference and the worked examples, as Markdown. */
  reference(): string;
}
