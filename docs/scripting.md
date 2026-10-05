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

### Modelling

| Name | Parameters | Notes |
| --- | --- | --- |
| `extrude` | `offset`, `individual`, `alongNormals` | Falls back to edge extrude when no faces are selected |
| `inset` | `thickness`, `depth`, `individual` | |
| `bevel` | `width`, `segments`, `clampOverlap` | Needs an edge selection |
| `loopCut` | `cuts`, `slide` | Starts from the first selected edge |
| `knife` | `cuts`: runs of points, each `{ kind: 'vert', vert }`, `{ kind: 'edge', edge, t }` or `{ kind: 'face', face, co }` | Needs no selection. Leaves the cut selected and reports the new vertices; a malformed point is dropped on its own |
| `subdivide` | `cuts`, `smooth` | Splits edges in edge select mode, faces otherwise; reports the new vertices |
| `relax` | `factor`, `iterations`, `keepShape` | Straightens and spaces a selected loop, keeping it on the surface |
| `circle` | `factor` | Rounds each selected loop onto the circle that fits it best |
| `space` | `factor` | Evens the gaps along each selected loop, leaving its shape alone |
| `shrinkFatten` | `distance` | Moves along vertex normals |
| `vertexSlide` | `direction` (1 to 3), `distance` (world metres) | Runs the selected vertices down an edge leaving them; the direction numbers the edges of the first one |
| `edgeSlide` | `direction` (1 or 2), `distance` (world metres) | Runs the selected edges across the faces on that side; a border offers the one side it has |

### Cleanup

| Name | Parameters |
| --- | --- |
| `connect` | none (acts on exactly two selected vertices) |
| `mergeByDistance` | `threshold` |
| `merge` | `mode`: `center` \| `cursor` \| `first` \| `last` \| `collapse` |
| `delete` | `mode`: `verts` \| `edges` \| `faces` \| `onlyFaces` \| `edgesAndFaces` |
| `dissolve` | `mode`: `verts` \| `edges` \| `faces` \| `limited`, `angle` (edges: max fold in degrees, default 40; limited: default 5) |
| `triangulate`, `trisToQuads` | `angle` (tris-to-quads only) |

### Topology and normals

| Name | Parameters |
| --- | --- |
| `fill` | `bridge` |
| `bridge` | none |
| `recalculateNormals` | `outside` |
| `flipNormals` | none |
| `shade` | `smooth` |
| `markSharp` | `clear` (marks the selected edges sharp, or with `clear: true` takes the mark off) |

### Transform and selection

| Name | Parameters |
| --- | --- |
| `translate` | `offset: {x, y, z}` |
| `rotate` | `axis`, `angle` (degrees) |
| `scale` | `scale: {x, y, z}` |
| `selectAll`, `deselectAll`, `invertSelection`, `growSelection`, `shrinkSelection` | none |
| `selectFaceLoop` | none (needs two adjacent selected faces to name the loop) |

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

The `<>` button in the top bar opens the SCRIPT dialog, where a user writes
JavaScript against the scene and runs it. The user-facing reference is the
SCRIPTING section of the in-app docs, generated from the same catalogue the
editor reads; this section is about how the layer is built.

```text
src/domain/scripting/
  reference.ts   the catalogue: every API name, operator spec and modifier field
  api.ts         the scene and view globals, object, mesh and modifier handles
  runScript.ts   compile, run as one transaction, map an error to a script line
  syntax.ts      tokenizer, bracket check and completion, for the editor
  examples.ts    the starter script and the EXAMPLE menu, all run by a test
src/domain/components/
  ScriptEditor/  textarea over a highlighted layer, hovers, suggestions
  ScriptDialog/  the modal: toolbar, editor, RUN, toasts, the saved draft
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
