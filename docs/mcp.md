# The MCP server: 3DOO for AI assistants

An AI assistant that speaks the [Model Context Protocol](https://modelcontextprotocol.io)
can build models in 3DOO with the scripting API, look at them, and hand them
back as a `.3doo`, an OBJ or FBX, PNG pictures, or a link that opens the hosted
editor on the result. This page is the technical side: how the layer is built,
how to run it, and every payload that crosses it. The user-facing side is the
MCP dialog behind the top bar's MCP button ([below](#the-mcp-dialog)) and the
AI ASSISTANTS section of the in-app docs (`src/modules/docs/content.ts`).

## In short

```text
 assistant (Claude Code, Claude Desktop, any MCP client)
     │  JSON-RPC over stdio
     ▼
 mcp/server.ts ── Node ── writes files, returns images and links
     │  Playwright
     ▼
 headless Chromium ── the built app, on its home page
     │  page.evaluate
     ▼
 window.threedoo ── src/app/automation ── runScript · exporters · snapshot renderer
```

- The server is a thin transport. Every call lands on `window.threedoo`, the
  automation API the app installs in `main.tsx`, inside a headless browser.
- So a script runs in exactly the engine a user's script runs in: the same
  store, the same checks, the same boolean worker, the same exporters. Nothing
  is reimplemented for Node, and nothing can drift.
- Pictures are drawn with the viewport's own object views, lights and grid,
  offscreen, from the cameras the Shift+number keys use.
- A link carries the whole project in its hash, so a static host serving the
  built files is all the hosted editor needs.

## Running it

### Requirements

- Node 22.18 or newer. The server is TypeScript that Node runs as it is,
  through its built-in type stripping: no build step, no `tsx`.
- A Chromium. Either `npx playwright-core install chromium`, a Chrome or Edge
  already installed (found through Playwright's `chrome` and `msedge`
  channels), or any build named by `THREEDOO_CHROMIUM`.
- The app, built: `npm run build`. The server serves `dist/` itself, on a free
  local port, so the page it drives is the same version as the server.

### Connecting a client

Claude Code:

```bash
claude mcp add 3doo \
  -e THREEDOO_APP_URL=https://3doo.example.com \
  -- node /path/to/3doo/mcp/server.ts
```

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "3doo": {
      "command": "node",
      "args": ["/path/to/3doo/mcp/server.ts"],
      "env": { "THREEDOO_APP_URL": "https://3doo.example.com" }
    }
  }
}
```

Any other client launches `node mcp/server.ts` (or `npm run mcp` from the
repository) and speaks MCP over its stdin and stdout. Logs go to stderr.

### Configuration

Everything is an environment variable, read once at start (`mcp/config.ts`).

| Variable | Default | Means |
| --- | --- | --- |
| `THREEDOO_APP_URL` | none | Where 3DOO is hosted. `share_link` builds links to it, and the server drives it when there is no `dist/` |
| `THREEDOO_ENGINE_URL` | none | A 3DOO to drive instead of `dist/`, such as `http://localhost:5173` while developing |
| `THREEDOO_OUTPUT_DIR` | `~/3doo-output` | Where exports and saved pictures go, and what relative paths are read against |
| `THREEDOO_CHROMIUM` | none | Path to a Chrome or Chromium to launch |
| `THREEDOO_TIMEOUT_MS` | `60000` | How long one call may take before its page is thrown away (1000 or more) |

The page to drive is chosen in this order: `THREEDOO_ENGINE_URL`, then
`dist/index.html` if it exists, then `THREEDOO_APP_URL`. A link never points at
the server's own local copy, which dies with the server: it goes to the
`app_url` the call names, else `THREEDOO_APP_URL`, else `THREEDOO_ENGINE_URL`.

## The tools

Seven tools. Their descriptions in `mcp/tools.ts` are written for the model:
they say when to use each one, so the model reads the workflow off the tool
list. The server's `instructions` (sent with `initialize`) repeat it in a
paragraph.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `scripting_reference` | none | The scripting API and examples, as Markdown |
| `run_script` | `script` (required), `reset` | What the run did, console output, the scene summary |
| `render_views` | `views`, `width`, `height`, `shading`, `projection`, `grid`, `save`, `name` | One PNG image per view |
| `export_model` | `format` (required), `name`, `preset`, `triangulate`, `directory`, `embed` | The path of each file written, a resource link to each, and the files themselves with `embed` |
| `share_link` | `app_url` | A link that opens the hosted editor on the scene |
| `open_file` | `path` (required) | The scene summary after opening |
| `get_scene` | none | The scene summary |

A failure inside a tool, a bad argument included, comes back as a normal
result with `isError: true` and the reason as text, which the model reads and
acts on. Only a tool name that does not exist is a JSON-RPC error.

Calls run one at a time, in the order they arrive (`createHandlers` in
`mcp/server.ts`): there is one scene, and a render that started before a script
finished would picture half of it.

### `run_script`

```json
{
  "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": {
    "name": "run_script",
    "arguments": {
      "reset": true,
      "script": "const top = scene.add('cube', { name: 'TOP', position: [0, 1, 0], scale: [2, 0.1, 1] });\ntop.color = '#b8452f';"
    }
  }
}
```

```json
{
  "jsonrpc": "2.0", "id": 3,
  "result": {
    "content": [{
      "type": "text",
      "text": "Script ran: 1 object added\n\nScene: {\"name\":\"untitled\",\"totals\":{\"objects\":1,\"vertices\":8,\"faces\":6},\"bounds\":{\"min\":{\"x\":-1,\"y\":0.95,\"z\":-0.5},\"max\":{\"x\":1,\"y\":1.05,\"z\":0.5},\"size\":{\"x\":2,\"y\":0.1,\"z\":1}}}\nObjects (1):\n{\"name\":\"TOP\",\"vertices\":8,\"edges\":12,\"faces\":6,\"position\":{\"x\":0,\"y\":1,\"z\":0},\"rotation\":{\"x\":0,\"y\":0,\"z\":0},\"scale\":{\"x\":2,\"y\":0.1,\"z\":1},\"dimensions\":{\"x\":2,\"y\":0.1,\"z\":1},\"color\":\"#b8452f\",\"modifiers\":[],\"visible\":true,\"group\":null}"
    }],
    "isError": false
  }
}
```

- The scene persists between calls. `reset: true` empties it, and its undo
  history, before the script runs.
- The script is the body of an async function with `scene` and `view` in
  scope, the API of the SCRIPT dialog ([scripting.md](scripting.md)).
- A run is one transaction. A script that throws, on any line, leaves the scene
  as it was, and the result says so with the line:
  `The script failed on line 2: scene.add("cube") has no option "sise". Did you mean "size"?`
- `return` and `console.log` are the two ways a script reads values out. The
  returned value becomes the run's message, and each `console` call one line
  under `Console:`. Text comes back as it is and anything else as JSON, the
  handles as their names and settings: `return box.bounds` gives
  `{"min":{...},"max":{...},"size":{...},"center":{...}}`. See
  [What a run hands back](scripting.md#what-a-run-hands-back).
- The summary is the totals on one line and each object on its own line, in
  script terms: metres, degrees, `#rrggbb`. Counts are of the shape as drawn
  and exported, with modifiers applied. Indented JSON took several times the
  tokens to say the same.

### `render_views`

```json
{ "name": "render_views",
  "arguments": { "views": ["front", "right", "top"], "width": 640, "height": 480, "shading": "solid" } }
```

The result is a text label and an image for each view:

```json
{ "content": [
  { "type": "text", "text": "front view" },
  { "type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo..." },
  { "type": "text", "text": "right view" },
  { "type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo..." }
] }
```

| Argument | Values | Default |
| --- | --- | --- |
| `views` | `perspective`, `front`, `back`, `right`, `left`, `top`, `bottom` | `["perspective"]` |
| `width`, `height` | 16 to 2048 pixels | 800 by 600 |
| `shading` | `solid`, `solidWire`, `wireframe`, `xray`, `matcap` | `solidWire`, the editor's own default |
| `projection` | `auto`, `perspective`, `orthographic` | `auto` |
| `grid` | the ground grid and its centre lines | `true` |
| `save` | also write `<name>_<view>.png` to the output folder | `false` |

The views are the editor's cameras:

| View | Key in the editor | Camera |
| --- | --- | --- |
| `perspective` | the view a fresh tab opens on | above the ground, a quarter turn round from the front |
| `front` | Shift+1 | on +Z, looking towards -Z |
| `right` | Shift+3 | on +X |
| `top` | Shift+7 | above, on +Y |
| `back` | Ctrl+Shift+1 | on -Z |
| `left` | Ctrl+Shift+3 | on -X |
| `bottom` | Ctrl+Shift+7 | below, on -Y |

`auto` projection draws `perspective` in perspective and the six straight-on
views orthographic, which is how a set of views is read: proportions can be
compared between them. The details are under
[the snapshot renderer](#the-snapshot-renderer).

### `export_model`

```json
{ "name": "export_model", "arguments": { "format": "obj", "name": "table", "preset": "unity" } }
```

```json
{ "content": [
  { "type": "text", "text": "Wrote /home/me/3doo-output/table.obj (37.2 KB)\nWrote /home/me/3doo-output/table.mtl (564 bytes)" },
  { "type": "resource_link", "uri": "file:///home/me/3doo-output/table.obj", "name": "table.obj", "mimeType": "text/plain", "size": 38051 },
  { "type": "resource_link", "uri": "file:///home/me/3doo-output/table.mtl", "name": "table.mtl", "mimeType": "text/plain", "size": 564 }
] }
```

| Format | Files | Built by |
| --- | --- | --- |
| `3doo` | `name.3doo` | `projectText`, the same text SAVE writes, images inlined |
| `obj` | `name.obj`, `name.mtl`, and the picture of each image plane | `exportOBJ` |
| `fbx` | `name.fbx`, binary FBX 7.4 with pictures embedded | `exportFBX` |

- Only visible objects go into OBJ and FBX, with their modifiers applied, the
  way EXPORT does. A `.3doo` holds the whole project.
- `preset` (`unity`, `unreal`, `blender`, `maya`) and `triangulate` are laid
  over the editor's export settings. Without them, the settings of a fresh
  install apply: Unity's axes, metres.
- `name` defaults to the project name. Folders in it are dropped, so a file
  name from the model cannot climb out of the folder it is written to.
- Files go to the output folder, or `directory` (absolute, or relative to the
  output folder), and replace files of the same name there. An assistant
  iterating on `chair.obj` is expected to write it many times.
- Resource links are sent to clients on protocol `2025-06-18` or later, which
  added them. Older clients get the paths as text.
- `embed: true` adds each file as an embedded resource: `text` for `.3doo`,
  `.obj` and `.mtl`, base64 `blob` for FBX and images. That is for a client
  with no access to the server's disk.

The shared pieces of an export (which pictures go out under which names, and
the objects in the shape the exporters take) live in `exportPictures` and
`exportObjects` in `src/domain/services/assets.ts`, which the EXPORT dialog's
hook uses too.

### `share_link`

```json
{ "name": "share_link", "arguments": {} }
```

```json
{ "content": [{ "type": "text", "text": "https://3doo.example.com/modeling#scene=7V1NbxxJcr3rVzR4VjcqPyqzSrc1MDAG..." }] }
```

See [scene links](#scene-links) for what is in the link.

### `open_file`

`path` is absolute or relative to the output folder. A `.3doo` replaces the
scene and clears its history, as FILE > OPEN does. An `.obj` or `.fbx` is
imported into the scene beside what is there, as IMPORT MESH does. The file is
read by the server and handed to the page as base64.

### `scripting_reference` and the resource

The reference is built in the page by `scriptingReference()`
(`src/app/automation/automation.ts`), in four parts:

1. The conventions a model needs that a person in the editor does not: the
   units and axes, `await`, `return` and `console.log`, and that `view` moves
   the editor's camera rather than the pictures'.
2. **What a script can do**: the whole of the API in six lines, so the model
   knows before it reads the tables that it can colour single faces or read
   an object's world bounds.
3. **How a script works**: the rules that are not obvious from a table. An
   operation acts on the selection and leaves what it made selected; `edit`
   coordinates are local; modifiers do not change the mesh `edit` sees;
   booleans refuse a live stack and use their cutters up; `object.bounds`
   places one part against another; and short runs fail on their own.
4. The API half of the SCRIPTING docs section (`scriptingApiBlocks` in
   `src/modules/docs/content.ts`) turned into Markdown, then every example in
   the EXAMPLE menu.

The API half is generated from the catalogue the API validates against
(`src/domain/scripting/reference.ts`), so the model reads the same names and
ranges the checks enforce, and every choice lists the values it takes. The
docs section keeps its blocks about the SCRIPT dialog (buttons, keys, toasts)
in a separate function, so the reference takes none of them and nothing has
to be filtered out by matching on text.

The same text is offered as the resource `3doo://reference/scripting`
(`text/markdown`), for clients that let a user attach resources.

## The MCP dialog

The MCP button beside `<>` in the top bar opens `McpDialog`
(`src/domain/components/McpDialog`), the user's guide to this server: how a
call travels from the assistant to the scripting API, the commands to set it
up with COPY buttons, every tool with its arguments and what it returns, a
sample `run_script` result, and the environment variables. The commands put
the page's own `window.location.origin` in `THREEDOO_APP_URL`, so someone
setting up from the hosted editor gets links that open back on it.

The app cannot import `mcp/`, which is Node, so the dialog reads its lists from
a catalogue of its own: `MCP_TOOLS` and `MCP_SETTINGS` in
`src/domain/mcp/guide.ts`, which the AI ASSISTANTS docs section reads too. Tests
in `mcp/tools.test.ts` hold it to the server: the same tools in the same order
as `TOOLS`, the same arguments as each input schema, and the same variables as
`config.ts` reads. A tool or a setting added to the server without its line in
the catalogue fails the suite rather than going missing from the dialog.

## The page API: `window.threedoo`

`installAutomation()` puts it on `window` before React mounts. The types are in
`src/app/automation/types.ts`, which imports nothing, so the server reads them
(and `AUTOMATION_VERSION`) straight from the source without resolving the
app's path aliases.

```ts
interface AutomationApi {
  readonly version: number;                         // AUTOMATION_VERSION
  reset(): void;                                     // empty scene, no history
  run(source: string): Promise<RunReport>;           // runScript: message, line, logs, summary
  open(file: { name: string; base64: string }): Promise<SceneSummary>;
  scene(): SceneSummary;
  exportFile(request: ExportRequest): Promise<ExportedFile[]>;  // { name, mimeType, base64 }[]
  render(request: RenderRequest): Promise<RenderedView[]>;      // { view, base64 }[]
  shareLink(appUrl: string): Promise<{ url: string; length: number }>;
  reference(): string;
}
```

It is usable from a browser's console too: open the editor, then
`await threedoo.run("scene.add('torus')")`.

Every argument is checked in the page, which is the boundary that matters:
the server only checks the types of its own arguments. An unknown view,
shading or format names the values it takes. `version` is compared on start,
and a mismatch stops the server with the instruction to rebuild, rather than
calls failing one by one in ways that are hard to read.

### Why on the home page

The server opens `/`, not `/modeling`. The home page mounts no viewport, so
nothing renders behind the calls, and adds no starter cube, so a session
starts on an empty scene. The store is module state and works on any page.

## The snapshot renderer

`renderSnapshots` in `src/viewport/snapshot.ts` draws the store's scene
offscreen:

- One `WebGLRenderer` on a detached canvas, with `preserveDrawingBuffer` so
  the canvas can be read back after each view.
- An `ObjectView` per visible object, the bridge class the viewport draws with,
  in object mode with nothing selected. The cursor, origins, gizmo and
  selection outline belong to working on a model, so a picture leaves them out.
- The viewport's lights (`addViewportLights`, shared with `Viewport.ts`), its
  background colour preference and its grid.
- Image planes wait up to five seconds for their picture to decode, so it is in
  the shot.

The camera angles come from `CameraController`: `OPENING_VIEW` for
`perspective` and `axisViewAngles` for the six others, the function
`setAxisView` itself calls. A picture of the front view is taken from exactly
where Shift+1 puts the editor's camera, and a test holds the two together.

Framing is tighter than Frame All, which leaves room to work round the model.
`snapshotCamera` measures the box's corners in the camera's own right and up
axes rather than through its bounding sphere, so a long thin model seen end on
does not leave the frame mostly empty:

- orthographic: the half height is the largest corner offset (the width
  divided by the aspect, when that is larger), plus 12%;
- perspective: the distance is the nearest one at which every corner is inside
  the field of view, plus the same margin.

An empty scene frames a two-metre box at the origin, so the picture shows the
grid rather than failing.

Rendering needs WebGL. Headless Chromium on a machine with no GPU gets it from
SwiftShader, which the server asks for with `--use-angle=swiftshader` and
`--enable-unsafe-swiftshader`. An 800 by 600 view takes about a quarter of a
second that way.

## Scene links

```text
https://3doo.example.com/modeling#scene=<payload>
payload = base64url( deflate-raw( the .3doo text ) )
```

`src/domain/services/sceneLink.ts` encodes and decodes it with the browser's
`CompressionStream`. Nothing else is needed on the host:

- **The hash never reaches the server.** A static host serving `dist/` with
  its SPA fallback serves the link, and the scene goes nowhere but the tab
  that opens it.
- **Compression keeps links short enough to paste.** Mesh JSON is repetitive:
  a table of six objects (a top, four legs and a torus) is 156 KB as a
  `.3doo` and a link of about 10,000 characters.
- **There is a ceiling.** Chromium refuses to navigate to a URL of more than
  about two million characters, so `shareLink` refuses past
  `MAX_SCENE_LINK_LENGTH` and says to export a `.3doo` instead.

On the app side, `useAutosave` (which owns what the editor opens on) checks the
hash on its first mount:

- With a payload it opens that scene instead of the starter cube, through
  `loadProjectDocument` and `clearHistory`, the path FILE > OPEN takes.
- The hash is taken off the address bar first, whatever happens next. A reload
  is a fresh tab, and opening the link a second time over work done since
  would throw that work away.
- The scene is in no file, so it counts as unsaved work (`dirty`, not
  `savedToFile`).
- A payload that will not decode falls back to the cube, with a toast saying
  the link was cut short.
- A link pasted into the address bar of a tab already on `/modeling` changes
  only the hash, which reloads nothing. A `hashchange` listener reloads the
  page, behind the same RELOAD THE PAGE dialog F5 gets when there is unsaved
  work.

## Time limits and isolation

A script runs on the page's thread, so `while (true) {}` freezes the page for
good. Every call races `THREEDOO_TIMEOUT_MS`. On a timeout the server closes
the page's browser context, which takes its renderer process with it, and
reports:

```text
The script ran for more than 60 seconds and was stopped. The scene was lost
with it: the next call starts on an empty one.
```

The next call opens a fresh page in the same browser.

A script runs in a browser page, not in Node. It cannot reach the file system
or the server's process. It can do what any page can, network requests
included. The server is meant to run on the user's own machine, for their own
assistant, and is not a sandbox for scripts from strangers.

## Testing

| Test | Covers |
| --- | --- |
| `src/app/automation/automation.test.ts` | Every page API method against the real store: summaries, failing lines, exports, opening, links, render argument checks, the reference |
| `src/viewport/snapshot.test.ts` | The cameras match the editor's, look from the right side, and fit every corner of a box in frame from every view, projection and aspect |
| `src/domain/services/sceneLink.test.ts` | The link codec, its compression and its errors |
| `src/domain/hooks/useAutosave.test.tsx` | Opening a link, taking it off the address bar, the fallback, a pasted link |
| `mcp/protocol.test.ts` | The JSON-RPC transport |
| `mcp/tools.test.ts` | Each tool against a fake engine, the call queue, protocol negotiation, configuration, and the editor's catalogue of tools, arguments and settings against the server's |
| `src/domain/components/McpDialog/McpDialog.test.tsx` | The dialog lists every tool and setting, fills in the page's address, and copies a command |

The browser engine itself (`mcp/engine.ts`) has no unit test: what it does is
launch Chromium. To check it end to end, build, then drive the server by hand:

```bash
npm run build
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"me","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_script","arguments":{"script":"scene.add(\"torus\")"}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"export_model","arguments":{"format":"obj"}}}' \
  | node mcp/server.ts
```

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
(`npx @modelcontextprotocol/inspector node mcp/server.ts`) shows the pictures.

## Why it is built this way

- **No MCP SDK.** It brings an HTTP server, an OAuth client and a schema
  library. A local stdio server answers seven methods, and `mcp/protocol.ts` is
  all of the protocol those need, in about a hundred lines.
- **No Node port of the engine.** The store, the boolean worker and the
  renderer all assume a browser, and the scripting checks live in the app.
  Running the real app in a real browser means a model behaves in the MCP
  server exactly as in the editor, and a new operator reaches assistants the
  moment it reaches the SCRIPT dialog.
- **TypeScript without a build.** Node strips the types itself, so the server
  is typechecked, linted and tested with the rest of the code and still runs
  with `node mcp/server.ts`. The constraint is that `mcp/` imports nothing
  through the app's path aliases, and from `src/` only `types.ts`.

## Adding a tool

1. If the page has to do the work, add a method to `AutomationApi` in
   `types.ts`, implement it in `createAutomationApi`, check its arguments
   there, and test it in `automation.test.ts`. Bump `AUTOMATION_VERSION` if an
   existing payload changes shape.
2. Add the method to the `Engine` interface and `BrowserEngine` in
   `mcp/engine.ts`. `call()` does the round trip.
3. Add the tool to `TOOLS` in `mcp/tools.ts`, with a description that tells the
   model when to use it, and test it against the fake engine in
   `tools.test.ts`.
4. Describe it in `MCP_TOOLS` in `src/domain/mcp/guide.ts`, with its
   arguments, what it is for and what it returns. The MCP dialog and the AI
   ASSISTANTS docs list it from there, and a test fails until it is added.
5. Say what to ask for in the AI ASSISTANTS section of the in-app docs, in
   words a user would use.
