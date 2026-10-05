# The operator API and scripting

Every mutation the UI performs goes through one named registry. That single
surface gives the test harness, the undo stack and the SCRIPT editor the same
entry point. The first half of this page is the registry; the second half is
the scripting layer built on it, which is what a user's script talks to.

## Shape

```ts
import { execOperator } from '@kernel/index';

execOperator(
  { mesh, selectMode: 'face', cursor: vec3() },
  'extrude',
  { offset: 1.0 },
);
```

In the app, the store wraps it so history and re-rendering are handled:

```ts
useEditorStore.getState().exec('extrude', { offset: 1 }, 'Extrude');
```

`exec` snapshots the document for undo, runs the operator against the active
object, bumps `meshVersion`, and writes a status string. A failure is caught,
surfaced as a toast, and leaves the mesh untouched.

## Parameters are coerced, not trusted

The registry is a genuine external boundary and can be called with anything,
so every value is read through a coercing accessor with a documented default:

```ts
const offset = readNumber(params, 'offset', 1);
const mode = readString(params, 'mode', ['center', 'cursor', 'first'], 'center');
```

A malformed parameter falls back to its default rather than throwing or producing
`NaN` geometry. An unknown operator name throws with the list of valid names:

```text
Unknown operator "extrud". Available: bevel, bridge, delete, deselectAll, ...
```

## Operators

Every operator is listed once, with its parameters, their types, ranges and
defaults, and what it needs selected: `OPERATOR_SPECS` in
`src/domain/scripting/reference.ts`. The SCRIPTING section of the in-app
docs is generated from it, and a test fails when an operator in `OPERATORS`
has no entry there. Read the parameters there rather than in a copy here.

A few behaviours the parameter list does not show:

- `extrude` falls back to an edge extrude when no face is selected.
- `loopCut` starts from the first selected edge, and `selectFaceLoop` needs
  two adjacent selected faces to name the loop.
- `subdivide` splits edges in edge select mode and faces otherwise. It and
  `knife` report the new vertices.
- `knife` needs no selection and leaves the cut selected. The registry drops
  a point it cannot read on its own; a script's points are checked first
  ([below](#a-script-is-checked-not-coerced)).
- `dissolve` reads `angle` as the sharpest fold it still dissolves: 40
  degrees for edges, 5 for `limited`.
- `vertexSlide` numbers the edges leaving the first selected vertex from 1.
  `edgeSlide` takes side 1 or 2, and a border offers the one side it has.
  Both measure `distance` in world metres.

## Driving the kernel from a test

Because the kernel has no browser dependency, an operator sequence runs in Node:

```ts
import { createBox, execOperator, vec3 } from '@kernel/index';

const mesh = createBox(2);
for (const face of mesh.faces.values()) {
  if (face.normal.y > 0.99) face.selected = true;
}
mesh.flushSelection('face');

execOperator({ mesh, selectMode: 'face', cursor: vec3() }, 'extrude', { offset: 1 });

expect(mesh.verts.size).toBe(12);
expect(mesh.faces.size).toBe(10);
expect(mesh.validate()).toEqual([]);
```

## Adding an operator

1. Implement the geometry in `src/kernel/ops/`, taking a `BMesh` and returning
   what it created. Add tests asserting exact counts, `validate()` and, for
   closed results, the Euler characteristic.
2. Register it in `OPERATORS` in `src/kernel/commands/operators.ts`, reading
   parameters through the coercing accessors and returning a status string.
3. Describe it in `OPERATOR_SPECS` in `src/domain/scripting/reference.ts`: its
   parameters with their types and ranges, and what it `needs` selected. A test
   compares the two lists, so an operator left out of the specs fails the
   suite instead of being missing from scripts and from the docs.
4. Add a button or key binding. Both go through `store.exec`, so undo and status
   reporting come for free.

The status string is user-visible: `Extruded 1 face(s) by 1` is useful,
`ok` is not.

## The scripting API

The `<>` button in the top bar opens the SCRIPT dialog. Its EDITOR tab is where
a user writes JavaScript against the scene and runs it; its ACTIONS tab shows
what the user did in the viewport, written as that JavaScript. The user-facing
reference is the SCRIPTING section of the in-app docs, generated from the same
catalogue the editor reads; this section is about how the layer is built.

```text
src/domain/scripting/
  reference.ts   the catalogue: every API name, operator spec and modifier field
  api.ts         the scene and view globals, object, mesh and modifier handles
  runScript.ts   compile, run as one transaction, map an error to a script line
  recorder.ts    the ACTIONS log: store actions written as the calls that repeat them
  syntax.ts      tokenizer, bracket check and completion, for the editor
  examples.ts    the starter script and the EXAMPLE menu, all run by a test
src/domain/components/
  ScriptEditor/  textarea over a highlighted layer, hovers, suggestions
  ScriptDialog/  the modal: ACTIONS and EDITOR tabs, RUN, toasts, the saved draft
```

### One catalogue, five readers

`reference.ts` holds data rather than code: `API_ENTRIES` (every name, its
signature and a one-line summary), `OPERATOR_SPECS` (each operator's
parameters and selection needs), `MODIFIER_FIELDS`, `MATERIAL_OPTIONS` and the
primitive and placement options. The API validates against it, the tokenizer
marks names from it, the hover balloons and the suggestion list read from it,
and the docs section is built from it. The fifth reader is an assistant: the
MCP server's `scripting_reference` is the API half of that docs section
(`scriptingApiBlocks` in `src/modules/docs/content.ts`), so a model reads the
names and ranges the checks enforce. A name added to the API without an entry
has no hover, no suggestion, no docs row and no line in the reference, which
is why the entries are written first.

The docs write each option from its spec, not only its description: a choice
lists the values it takes (`Takes "center", "cursor", "first", "last" or
"collapse"`) and a set of switches says how it is written, so neither has to
be repeated by hand in a description that could drift from the spec.

### A script is checked, not coerced

The operator registry coerces bad parameters to defaults because the panels
can only send good ones. A script can send anything, and `ofset: 2` quietly
running at offset 1 is a bug its author never sees. So the scripting layer
reads every options object against its spec and throws on an unknown name, a
wrong type or a value outside the panel's range, suggesting the nearest real
name. Handles are wrapped in a `Proxy` that refuses an assignment to a property
that does not exist, for the same reason: `cube.positon = [0, 1, 0]` would
otherwise create a property nothing reads.

Several operators answer an empty selection with a status line and no
`refused` flag. The panels never reach those paths, since their buttons are
disabled, but a script would run straight past them. `OPERATOR_SPECS` gives
those operators a `needs`, and the API checks it before running the operator.

The knife's cuts are the one parameter the kernel parses itself, and it drops
a point it cannot read so that one stray click in the viewport does not cost
the whole cut. A script's points are read first instead (`readKnifeCuts` in
`api.ts`): each must have a known `kind` and the fields that kind needs, and a
face point's `co` is written `[x, y, z]` or `{ x, y, z }` like every other
point in the API. Without the check, `co: [0, 1, 0]` would be dropped without
a word, and the cut would run straight past the point the script asked for.

Errors raised inside the store's `exec` reach the script too: it takes
`throws: true`, which turns a failure or a refusal into a thrown error instead
of a toast, so a script stops on its first one and reports it once.

### A run is one transaction

`runScript` hands the compiled script to the store's `transact`, which:

- snapshots the document before the script starts,
- holds history while it runs, so the actions it calls record no steps of
  their own (and drop none: `discardHistory` is held too),
- records one `Run script` step at the end, only if the scene changed,
- and on a throw, loads the snapshot back and rethrows, so a failed run leaves
  the scene exactly as it was.

The project name is not part of undo, so the snapshot loaded back after a throw
keeps whatever name is current. `runScript` puts back a name the failed run
set through `scene.name`, which the rollback would otherwise leave behind.

### What a run hands back

A run reports values in two ways, and both write them through `valueText` in
`runScript.ts`: text as it is, anything else as JSON.

- What the script returns becomes the run's message: the toast and status
  line in the editor, the result text over MCP. When it returns nothing, the
  message says what the run changed.
- `console` is a parameter of the compiled function, not the browser's own.
  Each call is kept as one line in the outcome's `logs`, and still reaches the
  browser console. The SCRIPT dialog leaves the lines there; the MCP server
  sends them back under `Console:`.

Handles define `toJSON`: an object reads as its name, transform and colour, a
modifier as its type and settings, a material as its name, colour and index.
Without it, `JSON.stringify` showed the ids a handle keeps inside, and Chrome
previewed `console.log(box)` as `Proxy(QS)`, so an assistant could read
nothing it logged.

Store actions that work on the active object are pointed at another object for
the length of one call by `onObject`, which puts the active object back
afterwards. A script that colours or edits one object does not change which
object the panels show.

### Handles follow ids

An object, modifier or material handle holds an id, not the thing itself, and
looks it up on every use, so a handle stays good through edits that replace
the store's objects. A material handle matters most here: slots are addressed
by position, removing one renumbers the rest, and `material.index` reads the
slot's place afresh each time. Material ids are copied with a duplicate, so
the handle cache keys a material by object and id together. `mesh.assignMaterial`
writes each selected face's `materialIndex` directly and clears the object's
`primitive`, as the panel's ASSIGN does, because a primitive rebuilt from its
parameters would lose what its faces wear.

`object.bounds` measures the evaluated mesh, modifiers and all, through the
object's transform. `worldBounds` in `api.ts` is the one function for it: the
MCP scene summary reads each object's size and the scene's bounds from it too.

### Finding the failing line

The script is compiled with `new AsyncFunction('scene', 'view', body)`, where
the body starts with `'use strict'` and ends with a `//# sourceURL` comment.
The source URL names the script's frames in a stack trace, so an error thrown
deep inside `api.ts` is still reported on the line of the script that made the
call. Engines wrap the body in a header of their own and disagree on its
length, so the offset is measured once from a body that throws on its first
line, rather than assumed.

Chrome reports no line at all for a syntax error in a function body. The
bracket check in `syntax.ts` stands in: it names the first bracket left open,
closed twice or closed by the wrong one, and the first string or comment never
closed, which covers most scripts that will not compile.

### The editor

`ScriptEditor` is a transparent textarea over a layer that draws the same text
in colour, moved with every scroll. The browser's own field keeps native undo,
IME input and accessibility. Every edit the editor makes for the user
(indenting, closing a bracket, accepting a suggestion, loading an example) goes
through `document.execCommand('insertText')`, so Ctrl+Z takes it back in one
step; where that command is missing, the text is still changed without undo.

Hover balloons find the name under the pointer with `elementsFromPoint`, which
sees through the textarea to the coloured spans below it. Each span carries the
ids of the entries it may mean: after `scene.` or `view.` there is one, after
any other variable there may be several (`delete` is on objects and meshes),
and whether the name is being called settles `scale`, which is a property of an
object and an operation on a mesh. Each balloon links to the entry's row in the
docs module, as `/docs#scripting/<id>`, opened in a new tab so the script stays
where it is.

The draft is kept in `localStorage` under `3doo:script`, not in the project: a
script is a tool for making the scene rather than a part of it.

The API is built per run by `createScriptApi()`. Outside the editor it is
reached through `window.threedoo`, the automation API in `src/app/automation`:
`threedoo.run(source)` runs a script exactly as RUN does and returns the scene
afterwards. That is what the MCP server drives, and it works from the browser
console too. See [mcp.md](mcp.md).

### The action log

The ACTIONS tab works like Blender's Info editor: what the user does is written
out as the call that would do it. `installRecorder()` in `recorder.ts` runs once
from `main.tsx`, before the first render, and wraps the store actions a script
can repeat. Each wrapper lets the action run, then compares the store before and
after and writes the call: `addPrimitive` becomes `scene.add(...)`,
`setObjectTransform` an assignment to `position`, `exec` a line inside
`object.edit((mesh) => { ... })`. Store actions are the only mutation path (see
[state-management.md](state-management.md#store-actions-are-the-only-mutation-path)),
so this one place sees everything.

Only the outermost call is written. An action that calls another is one thing
the user did, and a script run calls every action from inside `transact`, so a
run is written as one `// Ran a script` comment, not as a copy of its source.

A few rules keep the log readable and true:

- **Repeated settings merge.** Each line can carry a key, and a line with the
  same key as the one before it replaces it. A drag sends a position on every
  pointer move and leaves one line; so does a slider on a modifier.
- **Edit mode moves say what they did.** A move, turn or scale in the viewport
  applies its whole amount on every pointer move, from where the vertices
  stood when it began, rather than adding the step since the last move on top
  (`EditMoveDrag` in `src/viewport/editMove.ts`). The result is then exactly
  one `mesh.translate`, `mesh.rotate` or `mesh.scale` with the settings the
  drag ended on: the axis as a letter or a direction, the pivot when it is not
  the middle of the selection, and the radius and falloff when proportional
  editing was on. Steps stacked on top could not be written as one call: a
  proportional scale multiplies the falloff into every step, and a radius
  changed with the wheel mid-drag only reached what came after it. Now the
  wheel spreads the whole move again. On confirm the viewport calls
  `noteOperator` with that call, which sets `lastOperator` the way `exec`
  does, and the step is written as that operation.
- **Proportional editing is a parameter.** The three transform operations take
  `proportional` (the radius) and `falloff` and never read the editor's toggle,
  so a line replays the same whether it was left on or not.
- **The bevel, inset and extrude drags say what they ran** in the same way.
  They preview on a copy of the mesh, so the vertices alone cannot tell the
  recorder the distance.
- **A step that names its operation is written there and then.** A click in
  edit mode changes the selection without any store action, so a step left for
  the next action to close would take a selection clicked after the gesture
  for the one the gesture left. `noteOperator` closes the step at once.
- **Anything else is read off its undo step.** The recorder snapshots the
  vertices when `recordHistory` opens a step, and describes it when the next
  action runs or the dialog opens: one offset for every selected vertex is
  `mesh.translate`, a factor or a turn about one axis through their middle is
  `mesh.scale` or `mesh.rotate`. The selection it leaves is read off the
  elements it started with, by id, for the reason above. A slide, or a move
  that auto merge welded on the way out, is written as a comment saying it has
  no script equivalent.
- **A gesture called off takes its lines with it.** The log is marked when a
  step opens and goes back to the mark on `discardHistory`, which is what every
  cancel calls.
- **Selections are points, not ids.** `cloneMesh` and every undo rebuild the
  mesh from its saved form and number its elements afresh, and the drags above
  keep a copy. A replay does neither, so an id would name a different face by
  then. The log writes `mesh.selectFaces([[0, 0.5, 0]])` instead: the select
  calls take a list of points and pick the elements standing on them (vertex
  positions, edge and face middles) within `POINT_TOLERANCE`. A selection is
  only written again when it differs from what the last line left.

The knife is the exception: its cuts name vertices, edges and faces by id,
because that is the form `mesh.knife` takes, so a knife line replays correctly
only on a mesh that has not been rebuilt since. Changes with no script call at
all, an import or an outliner folder removed, are comments with the undo
step's label.

**An undo takes its lines off the log.** `recordHistoryDocument`, which every
step goes through, keeps the log as the step found it, and an undo puts that
back; a redo puts back the log the undo replaced. So the log is always the
script for the scene on screen, not a record of everything tried. The kept logs
line up with the history from its newest end and are cut to its length before
they are read, which follows the history through its size limit, a new project
and a file opened. CLEAR forgets them, so an undo of a step from before it is
noted as a comment instead.

**COPY and OPEN IN EDITOR hand over `actionScript()`**, the log with a header
when it began on an empty scene: `scene.clear()` and the cursor where it stood.
Every primitive is named after its kind, so the bare log run over the scene it
was written from would add a second `CUBE` and send its edits to the first one.
With the header the run ends on the scene the log describes, whatever it runs
on. `actionScript()` also counts the comments that note something no call
repeats, and says when the log began on objects none of its lines made (CLEAR
on a full scene, or the first lines lost to the size limit). The dialog warns on
either, since a run will not rebuild the scene then.

`recorder.test.ts` holds the log to its promise: each test does something
through the store, runs the copied script on the scene as it stands, edit mode
included, and expects the same objects, transforms and vertex positions back.
