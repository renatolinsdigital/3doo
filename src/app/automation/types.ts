/**
 * What `window.threedoo` speaks: the editor driven from outside the page.
 *
 * The MCP server in `mcp/` drives it through a headless browser, so these
 * types are the payloads that cross that boundary. They import nothing: the
 * server reads them with `import type`, and Node runs it without resolving the
 * app's path aliases.
 */

/** Bumped when a payload changes shape, so a server can refuse an app it cannot drive. */
export const AUTOMATION_VERSION = 3;

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
  /** Cameras at any angle, drawn after the named views. */
  cameras?: CameraAngle[];
  width?: number;
  height?: number;
  shading?: string;
  projection?: string;
  grid?: boolean;
  /** Every view in one picture, labelled, `width` by `height` in all. */
  sheet?: boolean;
}

/** Degrees: yaw round from the front toward the right, pitch up from level. */
export interface CameraAngle {
  yaw: number;
  pitch: number;
  /** The field of view, in degrees. */
  fov?: number;
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
  /**
   * A link that opens the scene in the editor served from `appUrl`.
   *
   * The server no longer calls it: `share_link` builds its page from
   * `exportFile`. It stays for servers already published, which drive the
   * hosted app and still ask for it.
   */
  shareLink(appUrl: string): Promise<ShareLink>;
  /** The scripting reference as Markdown: the quickstart unless the request asks for more. */
  reference(request?: ReferenceRequest): string;
  /** Measures a picture of the subject and keeps it, for scripts and comparisons. */
  loadReference(request: LoadReferenceRequest): Promise<LoadedReference>;
  /** A loaded picture's outline, profile and colours, in world metres. */
  traceReference(request: TraceRequest): ReferenceTraceData;
  /** The model's silhouette against a loaded picture, seen from the picture's view. */
  compareReference(request: CompareRequest): Promise<ComparisonData>;
}

export interface ReferenceRequest {
  /** `quickstart` (the default), `api`, `examples` or `all`. */
  topic?: string;
  /** One finished example, by id or label. Wins over `topic`. */
  example?: string;
}

export interface LoadReferenceRequest {
  /** What scripts and later calls name it by. */
  id: string;
  /** The file's name, for messages. */
  name: string;
  base64: string;
  /** The straight-on view it is seen from: front, back, right, left, top or bottom. */
  view: string;
  /** The subject's height in the picture, in metres. Give this or `width`. */
  height?: number;
  /** The subject's width in the picture, in metres. */
  width?: number;
  /** The part of the picture to use, in its pixels: `[x, y, width, height]`. */
  crop?: number[];
  /** `"auto"`, or the colour behind the subject as `#rrggbb`. */
  background?: string;
  /** How far a colour may stray from the background and still count as it, 0 to 1. */
  tolerance?: number;
  /** Count background-coloured gaps inside the subject as background too. */
  holes?: boolean;
}

/** Two world values, on the two axes a view spans, across then up. */
export type PlanePoint = [number, number];

export interface ReferenceSummaryData {
  id: string;
  view: string;
  /** The world axes the picture spans, across then up: `["x", "y"]` from the front. */
  axes: readonly [string, string];
  /** The picture as measured, in pixels. */
  pixels: [number, number];
  metresPerPixel: number;
  /** The subject's width and height in the picture, in metres. */
  size: [number, number];
  bounds: { min: PlanePoint; max: PlanePoint };
  /** Where the whole picture reaches. */
  covers: { min: PlanePoint; max: PlanePoint };
  background: string;
  pieces: number;
  /** Pieces left out as not the subject: frames, rules, text and specks. */
  ignored: number;
}

export interface LoadedReference {
  summary: ReferenceSummaryData;
  /** The picture as measured, with the outline found and a metre grid drawn on: PNG, base64. */
  base64: string;
}

export interface TraceRequest {
  id: string;
  /** The most points the outline may have. */
  points?: number;
  /** How many heights the profile is measured at. */
  rows?: number;
}

export interface ReferenceTraceData extends ReferenceSummaryData {
  outline: PlanePoint[];
  /** False when cutting the outline down made it cross itself. */
  simple: boolean;
  profile: { at: number; from: number; to: number }[];
  colours: { color: string; share: number; at: PlanePoint }[];
}

export interface CompareRequest {
  id: string;
  /** Compare only these objects or folders, by name. Default: everything visible. */
  objects?: string[];
}

export interface ComparisonData {
  id: string;
  view: string;
  axes: readonly [string, string];
  /** Shared pixels over pixels in either: 1 is a perfect match. */
  score: number;
  reference: { min: PlanePoint; max: PlanePoint };
  model: { min: PlanePoint; max: PlanePoint } | null;
  mismatches: string[];
  /** The reference and the model's silhouette over each other: PNG, base64. */
  base64: string;
}
