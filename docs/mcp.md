# The MCP server: 3DOO for AI assistants

An AI assistant that speaks the [Model Context Protocol](https://modelcontextprotocol.io)
can build models in 3DOO with the scripting API, look at them, and hand them
back as a `.3doo` file, an OBJ or FBX, PNG pictures, or a page that opens the
hosted editor on the result. This page is the technical side: how the server is
built, how to run it, and every payload that crosses it. The user-facing side
is the MCP dialog behind the top bar's MCP button ([below](#the-mcp-dialog))
and the AI ASSISTANTS section of the in-app docs (`src/modules/docs/content.ts`).

## In short

```text
 assistant (Claude Code, Claude Desktop, any MCP client)
     │  JSON-RPC over stdio
     ▼
 mcp/server.ts ── Node ── writes files and pages, returns images
     │  Playwright
     ▼
 headless Chromium ── the built app, on its home page
     │  page.evaluate
     ▼
 window.threedoo ── src/app/automation ── runScript · exporters · snapshot renderer
```

- The server does no 3D work itself. It passes each tool call to a headless
  browser that has the 3DOO app open, and the app does the work through
  `window.threedoo`, an automation API that `main.tsx` installs on the page
  when the app starts.
- So a script runs in the same engine as a script typed into the SCRIPT dialog:
  the same store, the same checks, the same boolean worker, the same
  exporters. Nothing is reimplemented for Node, so the two cannot drift apart.
- Pictures are drawn offscreen with the editor's own object views, lights and
  grid, from the cameras that the Shift+number keys select.
- The page `share_link` saves holds the whole project and hands it to the
  editor's tab in the browser, so the hosted editor needs nothing but a static
  host serving the built files.

## How the parts work together

The hosted setup, which is the one the MCP dialog's hosted commands give, from
end to end:

```text
┌─ your computer ──────────────────────────────┐  ┌─ online ────────────┐
│                                              │  │                     │
│  Claude Code or Claude Desktop               │  │                     │
│     │ starts the server as a child process   │  │                     │
│     │ and speaks JSON-RPC on its stdio       │  │                     │
│     ▼                                        │  │                     │
│  MCP server, a Node process ◀────────────────┼──┤ npm registry        │
│     │ writes files to ~/3doo-output          │  │ 3doo-mcp and        │
│     │ drives the browser with                │  │ playwright-core     │
│     │ playwright-core                        │  │                     │
│     ▼                                        │  │                     │
│  headless Chromium, a private tab ◀──────────┼──┤ Vercel              │
│     │ page.evaluate                          │  │ the built app,      │
│     ▼                                        │  │ static files only   │
│  3DOO app, the same code as the site:        │  │                     │
│  window.threedoo, the store, the             │  │                     │
│  scripting API, renderer, exporters          │  │                     │
│                                              │  │                     │
└──────────────────────────────────────────────┘  └─────────────────────┘
```

| Part | What it is | Where it runs |
| --- | --- | --- |
| Claude Code, Claude Desktop | The MCP client. It starts the server and calls its tools | Your computer |
| `3doo-mcp` | The server, bundled into one file (`dist/server.mjs`) and published to npm | Your computer, as a Node process the client starts |
| `mcp/server.ts` | The same server as plain source files, in a copy of the repository | Your computer, started the same way |
| `playwright-core` | A Node library that launches a browser and runs code in its pages | Inside the server's process |
| Chromium | A headless browser: Playwright's own, else Chrome, else Edge | Your computer, started by the server |
| The 3DOO app | The static files `npm run build` makes: `index.html`, JavaScript, CSS | Downloaded from Vercel, run in the Chromium tab |
| npm registry | Where `npx` fetches the server from | Online. Hands out code, runs none |
| Vercel | The static host of https://3doo.vercel.app | Online. Hands out code, runs none |

The two arrows from the online side carry code to your computer. Your scene
never travels back: there is no 3DOO backend. Vercel serves the same files a
visitor's browser gets, and the scene lives only in the headless tab.

### A session, step by step

1. **Registering.** `claude mcp add 3doo -e THREEDOO_APP_URL=... -- npx -y 3doo-mcp`
   saves a command and its environment variables in Claude's configuration.
   Nothing is downloaded or started yet.
2. **Starting the server.** When a session starts, Claude runs that command as
   a child process. The first time, `npx` fetches `3doo-mcp` and its one
   dependency, `playwright-core`, from the npm registry (later runs use its
   cache). It then runs the package's `bin`, `dist/server.mjs`, with Node. From
   a copy of the repository the command is `node mcp/server.ts` instead.
   Either way the server reads JSON-RPC requests on stdin, answers on stdout
   and logs to stderr. MCP needs no network port: stdio is the whole transport.
3. **The handshake.** Claude sends `initialize` and `tools/list`. The server
   answers both from its own code, with its instructions and its list of seven
   tools. No browser starts yet, so a session that never calls a tool never
   launches one.
4. **The first tool call starts the browser.** `BrowserEngine`
   (`mcp/engine.ts`) has to choose which page to drive, and `engineSource`
   (`mcp/config.ts`) decides: `THREEDOO_ENGINE_URL` if it is set, else `dist/`
   if there is one, else `THREEDOO_APP_URL`. The npm package has no `dist/`
   beside it, so in this setup the page is `THREEDOO_APP_URL`, which points at
   Vercel. `playwright-core` then launches Chromium headless, with software
   WebGL, and opens the home page `/` in a browser context of its own.
5. **The app loads in that tab.** Vercel answers with the built files, as it
   would for any visitor. In the tab, `main.tsx` calls `installAutomation()`,
   which puts `window.threedoo` on the page. The server waits for it, then
   compares the page's `version` with its own `AUTOMATION_VERSION`. A mismatch
   stops the server with a message naming the side to update.
6. **Each call is one `page.evaluate`.** For `run_script`, Claude writes
   JavaScript against the scripting API and sends it as the `script` argument.
   The server passes it into the page, where `window.threedoo.run(script)` runs
   it with the same `runScript` the SCRIPT dialog uses, against the same store.
   Every other tool works the same way, calling `render`, `exportFile` or
   another page method. What comes back is JSON: reports and
   summaries as they are, pictures and files as base64.
7. **The server turns results into MCP content.** A page cannot write to disk,
   so files come back to the server, which writes them to the output folder and
   returns their paths. Pictures go to Claude as image content, which the model
   can look at. Calls run one at a time, in order, because there is one scene.
8. **A page opens the model in your own browser.** `share_link` exports the
   scene as a `.3doo`, packs it into an `.html` page in the output folder, and
   with `open` opens that page in your default browser. Its OPEN IN 3DOO button
   opens `/modeling#receive` on the hosted editor in a new tab: Vercel answers
   with `index.html` through `vercel.json`, the app asks the page that opened
   it for the scene, and the page sends it across with `postMessage`. The scene
   goes from one tab to the other inside the browser, so it never reaches
   Vercel.
9. **The end.** When the session ends, Claude closes the server's stdin, and
   the server closes the browser. The scene goes with the tab, so anything that
   was not exported or shared is gone.

From a copy of the repository with a build, both online boxes drop out. The
server runs from the clone (`node mcp/server.ts`), and in step 4 it serves
`dist/` itself on a free port of `127.0.0.1`, which the browser then loads.
Only shared models still need a hosted address, see
[Local or hosted](#local-or-hosted).

## What you run, and when

For a local setup, from a copy of the repository:

| Command | When |
| --- | --- |
| `npm run build` | Once, and again after changing the code. The server draws models from `dist/`. Optional when `THREEDOO_APP_URL` names a hosted 3DOO ([below](#local-or-hosted)). |
| `claude mcp add 3doo ...` | Once, to register the server with the assistant. |
| `npm run dev` | Not needed to build models. Only a shared model that opens on `localhost` needs it, and it opens only while it runs. |
| `npm run mcp` | Never in normal use. It starts the server by hand, for debugging. |

The assistant starts `node mcp/server.ts` itself, over stdio, when it connects,
and the server opens its own headless browser on `dist/`. That is why an
assistant can build models with no dev server running. It is also why the scene
it works on is private to the server: it never touches a tab you have open.

Shared models are the one place a running app matters. `share_link` points
each page at `THREEDOO_APP_URL`. When that is `http://localhost:5173`, which the
MCP dialog fills in when it is opened from `npm run dev`, the page opens the
model only on that computer, and only while the dev server is up. The tool's
result and the page both say so. Point `THREEDOO_APP_URL` at a hosted 3DOO for
pages that work anywhere.

## Local or hosted

The editor is also hosted (for example https://3doo.vercel.app), and the server
works with either copy. What cannot be hosted is the server itself: it speaks
stdio to a client on the user's machine, writes files there, and needs a
Chromium, so it always runs locally. Only the 3DOO it draws in, and the 3DOO
shared models open in, can be online.

| Setup | Variables | Models drawn in | Shared models open in |
| --- | --- | --- | --- |
| Local build | `THREEDOO_APP_URL` optional | `dist/`, served by the server | `THREEDOO_APP_URL`, if set |
| Hosted, from npm | `THREEDOO_APP_URL=https://3doo.vercel.app` | the hosted editor | the hosted editor |
| Hosted, from the repository | `THREEDOO_APP_URL=https://3doo.vercel.app` | the hosted editor (no `dist/` is built) | the hosted editor |
| Hosted, build present | `THREEDOO_ENGINE_URL=https://3doo.vercel.app` | the hosted editor | `THREEDOO_APP_URL`, else the engine address |

- The hosted setup needs no copy of the code: the server is published as
  `3doo-mcp` on npm, and the client runs it with `npx -y 3doo-mcp`. It needs
  Node, a Chromium and an internet connection to load the app. The hosted
  app's version must match the server's `AUTOMATION_VERSION`, or the server
  stops at the first call and says which side to update.
- The package is the server bundled by `npm run build:mcp` into
  `mcp-package/`. It has no `dist/` beside it, so it always draws in
  `THREEDOO_APP_URL` or `THREEDOO_ENGINE_URL`. [mcp-package.md](mcp-package.md)
  covers how to release it, bump its version and keep it in step with the app.
- The page is loaded fresh for each session, so a hosted scene is as private as
  a local one: it lives in the server's own headless tab.
- `vercel.json` rewrites every path that is not a file to `index.html`.
  Without it the `/modeling` tab a shared model opens would be a 404 on
  Vercel, because the app routes by path in the browser.
- A page `share_link` saved needs a hosted app that knows the hand-over
  (`#receive`). Deploy the app before publishing a server that writes such
  pages. An older app opens on the cube, and the page says so after 20 seconds
  and offers its DOWNLOAD .3DOO button instead.

## Running it

### Requirements

- Node 22.18 or newer. The server is TypeScript that Node runs as it is,
  through its built-in type stripping: no build step, no `tsx`.
- A Chromium, from any one of these: `npx playwright-core install chromium`; a
  Chrome or Edge that is already installed (found through Playwright's
  `chrome` and `msedge` channels); or any Chromium build, named by
  `THREEDOO_CHROMIUM`.
- The app, in one of two forms. Built with `npm run build`: the server serves
  `dist/` itself, on a free local port, so the page it drives is always the
  same version as the server. Or a hosted 3DOO, see
  [Local or hosted](#local-or-hosted).

### Connecting a client

Hosted, with nothing to download. In Claude Code:

```bash
claude mcp add 3doo \
  -e THREEDOO_APP_URL=https://3doo.vercel.app \
  -- npx -y 3doo-mcp
```

A client that is configured with JSON takes this entry:

```json
{
  "command": "npx",
  "args": ["-y", "3doo-mcp"],
  "env": { "THREEDOO_APP_URL": "https://3doo.vercel.app" }
}
```

From a copy of the repository, which draws in its own build. Here
`THREEDOO_APP_URL` is only the address shared models open in, so it is optional.
In Claude Code:

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
| `THREEDOO_APP_URL` | none | Where 3DOO is hosted. Pages from `share_link` open the model there, and the server drives it when there is no `dist/` |
| `THREEDOO_ENGINE_URL` | none | A 3DOO to drive instead of `dist/`, such as `http://localhost:5173` while developing |
| `THREEDOO_OUTPUT_DIR` | `~/3doo-output` | Where exports and saved pictures go, and what relative paths are read against |
| `THREEDOO_CHROMIUM` | none | Path to a Chrome or Chromium to launch |
| `THREEDOO_TIMEOUT_MS` | `60000` | How long one call may take before its page is thrown away (at least 1000) |

The page to drive is chosen in this order: `THREEDOO_ENGINE_URL`, then
`dist/index.html` if it exists, then `THREEDOO_APP_URL`. A shared model
follows a different rule. The server's own copy of `dist/` exists only while
the server runs, so a page never points at it. It opens the model in the
`app_url` the call names, else `THREEDOO_APP_URL`, else `THREEDOO_ENGINE_URL`,
and that address has to start with `http://` or `https://`.

## The tools

Seven tools. Their descriptions in `mcp/tools.ts` are written for the model and
say when to use each one, so the model learns the workflow from the tool list.
The server's `instructions`, sent with `initialize`, repeat that workflow in one
paragraph.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `scripting_reference` | `topic`, `example` | The quickstart by default; `api`, `examples`, `all` or one example on request, as Markdown |
| `run_script` | `script` (required), `reset` | What the run did, console output, the scene summary |
| `render_views` | `views`, `width`, `height`, `shading`, `projection`, `grid`, `save`, `name` | One PNG image per view |
| `export_model` | `format` (required), `name`, `preset`, `triangulate`, `directory`, `embed` | The path of each file written, a resource link to each, and the files themselves with `embed` |
| `share_link` | `app_url`, `name`, `open` | The path of an `.html` page that carries the scene and opens it in the hosted editor, and a resource link to it |
| `open_file` | `path` (required) | The scene summary after opening |
| `get_scene` | none | The scene summary |

A failure inside a tool, a bad argument included, comes back as an ordinary
result with `isError: true` and the reason as text, which the model reads and
acts on. Only a tool name that does not exist is a JSON-RPC error.

Calls run one at a time, in the order they arrive (`createHandlers` in
`mcp/server.ts`). There is one scene, and a render that started before a script
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
  scope. Those two are the API of the SCRIPT dialog ([scripting.md](scripting.md)).
- A run is one transaction. A script that throws, on any line, leaves the scene
  as it was, and the result names the line:
  `The script failed on line 2: scene.add("cube") has no option "sise". Did you mean "size"?`
- `return` and `console.log` are the two ways a script reads values out. The
  returned value becomes the run's message, and each `console` call becomes one
  line under `Console:`. Text comes back as it is and anything else as JSON. An
  object handle is written as its name, transform and colour, and a modifier as
  its type and settings, so `return box.bounds` gives
  `{"min":{...},"max":{...},"size":{...},"center":{...}}`. See
  [What a run hands back](scripting.md#what-a-run-hands-back).
- The summary is the totals on one line, then each object on its own line, in
  script terms: metres, degrees and `#rrggbb`. The counts are of the shape as
  drawn and exported, with modifiers applied. Each line is compact JSON,
  because indented JSON took several times the tokens to say the same.

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
| `views` | any of `perspective`, `front`, `back`, `right`, `left`, `top`, `bottom` | `["perspective"]` |
| `width`, `height` | 16 to 2048 pixels each | 800 by 600 |
| `shading` | `solid`, `solidWire`, `wireframe`, `xray`, `matcap` | `solidWire`, the editor's own default |
| `projection` | `auto`, `perspective`, `orthographic` | `auto` |
| `grid` | `true` or `false`: draw the ground grid and its centre lines | `true` |
| `save` | `true` or `false`: also write each picture to the output folder as `<name>_<view>.png` | `false` |
| `name` | the file name stem for saved pictures | the project name |

The views are the editor's cameras:

| View | Shortcut in the editor | Camera |
| --- | --- | --- |
| `perspective` | none: it is the view a fresh tab opens on | from the front right corner, 30 degrees above the ground |
| `front` | Shift+1 | on +Z, looking towards -Z |
| `right` | Shift+3 | on +X |
| `top` | Shift+7 | above, on +Y |
| `back` | Ctrl+Shift+1 | on -Z |
| `left` | Ctrl+Shift+3 | on -X |
| `bottom` | Ctrl+Shift+7 | below, on -Y |

`auto` projection draws `perspective` in perspective and the six straight-on
views in orthographic projection. That is how a set of views is read: with no
perspective shrinking, proportions can be compared from one view to the next.
The details are under [the snapshot renderer](#the-snapshot-renderer).

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
- `preset` (`unity`, `unreal`, `blender`, `maya`) and `triangulate` override
  the editor's export settings for this call. Without them, the settings of a
  fresh install apply: Unity's axes, metres.
- `name` defaults to the project name. Any folder in it is dropped, so a name
  chosen by the model cannot write outside the folder the files go to.
- Files go to the output folder, or to `directory` (absolute, or relative to
  the output folder), and replace files of the same name there. An assistant
  that is iterating on `chair.obj` is expected to write it many times.
- Resource links are sent to clients on protocol `2025-06-18` or later, the
  version that added them. Older clients get the paths as text.
- `embed: true` adds each file as an embedded resource: `text` for `.3doo`,
  `.obj` and `.mtl`, and a base64 `blob` for FBX and images. That is for a
  client with no access to the server's disk.

The EXPORT dialog and this tool share two functions in
`src/domain/services/assets.ts`. `exportPictures` decides which pictures go out
under which names, and `exportObjects` shapes the objects the way the exporters
take them.

### `share_link`

```json
{ "name": "share_link", "arguments": { "name": "dining_set", "open": true } }
```

```json
{ "content": [
  { "type": "text", "text": "Saved /home/me/3doo-output/dining_set.html (20.9 KB). It opens the model in 3DOO at https://3doo.example.com, in any browser: double-click it, or send it to someone, and press OPEN IN 3DOO.\nOpened it in the user's browser, where they press OPEN IN 3DOO.\n\nGive the user the path of the file." },
  { "type": "resource_link", "uri": "file:///home/me/3doo-output/dining_set.html", "name": "dining_set.html", "mimeType": "text/html", "size": 21402 }
] }
```

| Argument | Means | Default |
| --- | --- | --- |
| `app_url` | The address the model opens in, overriding `THREEDOO_APP_URL` for this call | `THREEDOO_APP_URL` |
| `name` | The file name of the `.html`, and of the `.3doo` its download saves, without extension | the project name |
| `open` | Open the page in the user's default browser now | `false` |

The page is styled like the app: the 3DOO plate, YOUR MODEL IS READY, the
model's name, its object, vertex and face counts and its size, and two buttons.

- **OPEN IN 3DOO** opens the hosted editor in a new tab and hands it the scene
  ([the hand-over](#the-hand-over)). It works at any size: a 400-object scene,
  39 MB as a `.3doo`, opens in under two seconds.
- **DOWNLOAD .3DOO** unpacks the scene and saves it as a file, for FILE > OPEN
  in any 3DOO, or for an editor too old to take the hand-over.
- A line under the buttons says what happened: the tab opened, the model
  arrived, the browser blocked the tab, or the editor sent no answer within 20
  seconds.

Why a page, and not a link: a link has to carry the whole scene in its address.
That makes it thousands of characters for a small model and millions for a big
one, past the two million a browser will open. It also has to reach the user
through the model, which retypes it into its reply and gets characters wrong.
The page holds the scene itself, and a file path is short enough to pass on
intact, so the result names the path and carries none of the scene.

- `launcherPage` in `mcp/tools.ts` writes the page. Everything is inline but
  the two Google Fonts, which fall back to Arial Black and Consolas offline.
  The model's name is escaped, and the data the script reads is JSON with `<`
  escaped, so no name can close the `<script>`.
- The scene is `exportFile({ format: '3doo' })`, deflated with Node's
  `deflateRawSync` and written in base64url: the payload a scene link carries.
  `mcp/` cannot import the app's `sceneLink.ts`, so a test decodes the page's
  payload with it instead.
- The tab is opened with `window.open` from the button's click. A browser
  blocks a tab opened on load, and a link with `target="_blank"` cuts the new
  tab off from the page that has to answer it.
- `open` runs the system's own opener on the file's URL: `rundll32
  url.dll,FileProtocolHandler` on Windows, `open` on macOS, `xdg-open`
  elsewhere. A machine with no opener, or no desktop, gets a result that says
  the browser could not be opened and still names the file.
- The file replaces one of the same name, as exports do, and is sent as a
  resource link to clients on protocol `2025-06-18` or later.

### `open_file`

`path` is absolute or relative to the output folder. A `.3doo` replaces the
scene and clears its history, as FILE > OPEN does. An `.obj` or `.fbx` is
imported into the scene beside what is there, as IMPORT MESH does. The file is
read by the server and handed to the page as base64.

### `scripting_reference` and the resource

The reference is built in the page by `scriptingReference()`
(`src/app/automation/automation.ts`). The whole of it is about 50 KB, and three
quarters of that is the six examples. A model took a long time to read all of
it before building anything, so it is served in pieces, and the default piece
is small (about 6 KB):

| Request | Gives |
| --- | --- |
| none, or `topic: "quickstart"` | The conventions (units, axes, `await`, `return`, `console.log`), a first script that runs, every name the API has as a signature, the rules that are not obvious from a table, and how to ask for more |
| `topic: "api"` | The API half of the SCRIPTING docs section (`scriptingApiBlocks` in `src/modules/docs/content.ts`) as Markdown: what each name does, with its options and ranges |
| `topic: "examples"` | Every example in the EXAMPLE menu |
| `example: "axe"` | One example, by id or label. Wins over `topic` |
| `topic: "all"` | Everything. This is what the resource below serves |

The quickstart states the rules that a table of names cannot show:

- An operation acts on the selection and leaves what it made selected.
- Coordinates inside `edit` are the object's own, not the world's.
- A modifier changes what is drawn and exported, not the mesh `edit` works on.
- `scene.boolean` refuses an object that still has a live modifier, and uses
  its cutters up, so duplicate one first to keep it.
- `object.bounds` places one part against another.
- A model is better built over several short scripts, because each run is
  checked on its own and a failure takes back only that run.

The name lists are generated from the same catalogue as the API, and a test
runs the first script, so neither can fall out of date.

The API half is generated from the catalogue the API validates against
(`src/domain/scripting/reference.ts`), so the model reads the same names and
ranges that the checks enforce, and every choice lists the values it takes. The
docs section keeps its blocks about the SCRIPT dialog itself (buttons, keys,
toasts) in a separate function, so the reference never includes them and
nothing has to be filtered out by matching text.

The same text is offered as the resource `3doo://reference/scripting`
(`text/markdown`), for clients that let a user attach resources.

## The MCP dialog

The MCP button beside `<>` in the top bar opens `McpDialog`
(`src/domain/components/McpDialog`), a short guide to connecting: how a call
travels from the assistant to the scripting API, what a local and a hosted
setup each mean, and the commands for both with COPY buttons. It holds no
tables. The tool and setting tables live in the AI ASSISTANTS docs section.

The local commands put the page's own `window.location.origin` in
`THREEDOO_APP_URL`. The hosted ones always use `HOSTED_URL`
(`src/domain/mcp/guide.ts`), so they work whichever address the dialog was
opened from.

The app cannot import `mcp/`, which is Node, so the docs read their lists from
a catalogue of their own: `MCP_TOOLS` and `MCP_SETTINGS` in
`src/domain/mcp/guide.ts`. Tests in `mcp/tools.test.ts` hold that catalogue to
the server: the same tools in the same order as `TOOLS`, the same arguments as
each input schema, and the same variables as `config.ts` reads. A tool or a
setting added to the server without its line in the catalogue fails the suite
rather than going missing from the dialog.

## The page API: `window.threedoo`

`installAutomation()` puts it on `window` before React mounts. The types are in
`src/app/automation/types.ts`. That file imports nothing, so the server can
read the types and `AUTOMATION_VERSION` straight from the source, without
resolving the app's path aliases.

```ts
interface AutomationApi {
  readonly version: number;                         // AUTOMATION_VERSION
  reset(): void;                                     // empty scene, no history
  run(source: string): Promise<RunReport>;           // runScript: message, line, logs, summary
  open(file: { name: string; base64: string }): Promise<SceneSummary>;
  scene(): SceneSummary;
  exportFile(request: ExportRequest): Promise<ExportedFile[]>;  // { name, mimeType, base64 }[]
  render(request: RenderRequest): Promise<RenderedView[]>;      // { view, base64 }[]
  shareLink(appUrl: string): Promise<{ url: string; length: number }>;  // see below
  reference(): string;
}
```

The server no longer calls `shareLink`: `share_link` builds its page from
`exportFile`. The method stays because `3doo-mcp` 1.0.2 and earlier drive the
hosted app and still ask for it. It can go once no published server does,
with a bump of `AUTOMATION_VERSION`.

It is usable from a browser's console too: open the editor, then
`await threedoo.run("scene.add('torus')")`.

The page checks every argument, because the page is the boundary that matters:
the server only checks that its own arguments have the right types. An unknown
view, shading or format gets an error that lists the values it accepts. The
server compares `version` when the browser starts, and a mismatch stops it with
an instruction naming the side to update, rather than letting calls fail one by
one in ways that are hard to read.

### Why on the home page

The server opens `/`, not `/modeling`. The home page mounts no viewport, so
nothing renders behind the calls, and it adds no starter cube, so a session
starts on an empty scene. The store is module-level state, so it works on any
page.

## The snapshot renderer

`renderSnapshots` in `src/viewport/snapshot.ts` draws the store's scene
offscreen:

- One `WebGLRenderer` on a detached canvas, with `preserveDrawingBuffer` so
  the canvas can be read back after each view.
- An `ObjectView` per visible object. That is the class that holds the three.js
  side of one scene object, and the one the viewport draws with. Here it is in
  object mode with nothing selected. The cursor, origins, gizmo and selection
  outline belong to working on a model, so a picture leaves them out.
- The viewport's lights (`addViewportLights`, shared with `Viewport.ts`), its
  background colour preference and its grid.
- Image planes wait up to five seconds for their picture to decode, so it is in
  the shot.

The camera angles come from `CameraController`: `OPENING_VIEW` for
`perspective`, and `axisViewAngles` for the six others, which is also what
`setAxisView` uses. A picture of the front view is taken from exactly where
Shift+1 puts the editor's camera, and a test holds the two together.

Framing is tighter than Frame All, which leaves room to work round the model.
`snapshotCamera` measures the corners of the scene's bounding box along the
camera's own right and up axes, rather than through a bounding sphere, so a
long thin model seen end on does not leave the frame mostly empty:

- orthographic: the half height of the frame is the largest offset of any
  corner from the box's centre along the camera's up axis, or the largest
  offset along its right axis divided by the aspect ratio when that is larger,
  plus a 12% margin;
- perspective: the camera stands at the nearest distance at which every corner
  is inside the field of view, with the same margin.

An empty scene frames a two-metre box at the origin, so the picture shows the
grid rather than failing.

Rendering needs WebGL. Headless Chromium on a machine with no GPU gets it from
SwiftShader, a software renderer, which the server asks for with
`--use-angle=swiftshader` and `--enable-unsafe-swiftshader`. An 800 by 600 view
takes about a quarter of a second that way.

## Scene links

```text
https://3doo.example.com/modeling#scene=<payload>
payload = base64url( deflate-raw( the .3doo text ) )
```

`src/domain/services/sceneLink.ts` encodes and decodes it with the browser's
`CompressionStream`. The app still opens these links, and the pages older
servers saved are made of one, but `share_link` no longer hands them out: its
page passes the same payload over [the hand-over](#the-hand-over) instead.
Nothing else is needed on the host:

- **The hash never reaches the server.** A static host serving `dist/` with
  its SPA fallback serves the link, and the scene goes nowhere but the tab
  that opens it.
- **Compression keeps links short enough for a browser, not for a chat.**
  Mesh JSON is repetitive: a table of six objects (a top, four legs and a
  torus) is 156 KB as a `.3doo` and a link of about 10,000 characters, and a
  table with four chairs, 37 boxes, is 114 KB and a link of about 3,300. Any
  address bar takes that, but a model cannot retype it without mistakes.
- **There is a ceiling.** Chromium refuses to navigate to a URL of more than
  about two million characters, so `window.threedoo.shareLink` refuses past
  `MAX_SCENE_LINK_LENGTH` and says to export a `.3doo` instead. An imported
  picture fills that fast: deflate cannot shrink a PNG or JPEG, and base64
  grows it by a third twice over.

On the app side, `useAutosave` (which owns what the editor opens on) checks the
hash on its first mount:

- With a payload it opens that scene instead of the starter cube, through
  `loadProjectDocument` and `clearHistory`, the path FILE > OPEN takes.
- The hash is removed from the address bar before anything else, whatever
  happens next. Otherwise a reload would open the link again and replace any
  work done since.
- The scene is in no file, so it counts as unsaved work (`dirty`, not
  `savedToFile`).
- A payload that will not decode falls back to the cube, with a toast saying
  the link was cut short.
- When a link is pasted into the address bar of a tab that is already on
  `/modeling`, only the hash changes, so the browser reloads nothing. A
  `hashchange` listener reloads the page itself, after the RELOAD THE PAGE
  dialog that F5 also gets when there is unsaved work.

## The hand-over

The page `share_link` saves carries the scene, and gives it to the editor's
tab inside the browser, with no address to fit it in:

```text
 page (file on disk)                       editor tab (/modeling#receive)
     │ window.open, on OPEN IN 3DOO              │
     ├──────────────────────────────────────────▶│ loads, useAutosave mounts
     │◀──────────────────── { type: '3doo:ready' }│ to window.opener
     │ { type: '3doo:scene', payload } ─────────▶│ decodes, opens the scene
     │◀──── { type: '3doo:opened' } or '3doo:failed', reason
```

- The payload is the one a scene link carries. The tab decodes it with
  `decodeScenePayload` and opens it the way a link opens, through
  `openArrivedDocument`: unsaved work, nothing to undo into.
- `SCENE_HANDOVER` in `sceneLink.ts` names the hash and the four message
  types. `mcp/tools.ts` keeps a copy, `HANDOVER`, for the page it writes, and
  a test in `mcp/tools.test.ts` holds the two together.
- The page takes messages only from the editor's origin, and sends the scene
  only to it, so a tab that went anywhere else gets nothing.
- The tab takes the scene only from `window.opener`, and posts to it with any
  origin, since a file on disk has none that can be named. The tab's own
  messages carry nothing but how it went.
- The hash is cleared first, as a link's is, so a reload opens on the cube
  rather than asking a page that may be gone.
- The tab falls back to the cube, with a toast saying why, when the page is
  already closed, when it sends nothing within `HANDOVER_TIMEOUT_MS` (10
  seconds), or when its payload is damaged. The page hears `3doo:failed` with
  the reason, wherever it can still be reached.
- The page says so when the browser blocks the tab, and when no answer comes
  within 20 seconds, which is what an editor older than the hand-over does: it
  opens on its cube and stays quiet.

Any page that opens the editor on `#receive` can hand it a scene, the same way
any page can link to one. Either way the scene only replaces the starting
cube of a fresh tab, never work in progress.

## Time limits and isolation

A script runs on the page's thread, so `while (true) {}` freezes the page for
good. To stop that, every call has a time limit, `THREEDOO_TIMEOUT_MS`. When a
call runs past it, the server closes the page's browser context, which takes
its renderer process with it, and reports:

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
| `src/domain/hooks/useAutosave.test.tsx` | Opening a link, taking it off the address bar, the fallback, a pasted link; taking a scene handed over by the page that opened the tab, only from that page, and the cube when the page is gone, silent or damaged |
| `mcp/protocol.test.ts` | The JSON-RPC transport |
| `mcp/tools.test.ts` | Each tool against a fake engine, the call queue, protocol negotiation, configuration, and the editor's catalogue of tools, arguments and settings against the server's. The page `share_link` saves is run in jsdom: it opens the tab, answers only the editor's origin, reports blocked tabs and downloads its `.3doo` |
| `src/domain/components/McpDialog/McpDialog.test.tsx` | The dialog explains local and hosted, fills in the page's address and the hosted one, and copies a command |

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
  library. A local stdio server answers only seven JSON-RPC methods
  (`initialize`, `notifications/initialized`, `ping`, `tools/list`,
  `tools/call`, `resources/list` and `resources/read`), and `mcp/protocol.ts`
  is all of the protocol those need, in about a hundred lines.
- **No Node port of the engine.** The store, the boolean worker and the
  renderer all assume a browser, and the scripting checks live in the app.
  Running the real app in a real browser means a model behaves in the MCP
  server exactly as in the editor, and a new modelling operator reaches
  assistants the moment it reaches the SCRIPT dialog.
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
