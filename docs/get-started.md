# Get started

A first read for developers new to 3DOO: what the software is, how the code is
laid out, and the handful of ideas you need before changing anything. Each
section ends with a link to the document that goes deeper.

## What 3DOO is

A polygon mesh editor that runs in the browser. You start from a primitive,
shape it with modelling operations (extrude, inset, bevel, loop cut, knife,
dissolve and the rest), stack non-destructive modifiers on top, and export the
result as OBJ or FBX for a game engine.

Its keymap, camera and tool behaviour follow Blender's, so a Blender user finds
their way around quickly. The app itself never names Blender (see
[House rules](#house-rules)).

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # every suite
npm run test:kernel  # kernel only, fastest feedback
npm run build        # typecheck + production bundle
npm run lint
```

Open `/modeling`, press <kbd>Tab</kbd> to enter edit mode on the starting cube,
<kbd>3</kbd> for face select, click a face and press <kbd>E</kbd>. You have
just run the path every operation takes.

## The code at a glance

```text
/src
  /kernel          pure TypeScript: mesh structure, operations, modifiers, file formats
  /bridge          kernel mesh → GPU buffers → Three.js objects
  /viewport        renderer, camera, gizmo, picking, grid (imperative Three.js)
  /store           Zustand store, split into slices
  /domain          panels, hooks, keymap, file services: what the app *is*
  /shared          presentation-only component library
  /global-styles   Sass design system
  /modules         home, modeling and docs, one per path
  /app             shell: module registry, router, brand switcher
```

Imports use path aliases: `@kernel`, `@store`, `@domain`, `@shared`,
`@viewport`, `@bridge`, `@app`.

Dependencies point inward, and one rule matters above the rest: **the kernel
never imports React, Three.js or any browser API.** That is why every topology
operation can be tested in Node in milliseconds. If you want `window` or
`THREE` inside `/src/kernel`, the data you need belongs in the caller.

Two more rules complete the split:

- **Three.js is mounted once and driven imperatively.** React never reconciles
  scene objects or vertices. The viewport reads the store directly.
- **React owns the chrome only**: panels, forms, toolbars, dialogs, status.

Deeper: [architecture.md](architecture.md).

## Core concepts

### Modules

The app is a set of modules, each at its own path: Home (`/`), Modeling
(`/modeling`) and Docs (`/docs`). A module owns its layout and its lifecycle
hooks, so the keymap and autosave only run inside Modeling. The user manual is
the Docs module, written in
[content.ts](../src/modules/docs/content.ts), not in this folder.

### Objects, modes and select modes

A scene is a flat list of **objects**, each with a transform and a mesh.

- **Object mode** works on whole objects: move, duplicate, merge, booleans.
- **Edit mode** (<kbd>Tab</kbd>) works on the active object's geometry.
- Inside edit mode, the **select mode** decides what a click picks: vertices
  (<kbd>1</kbd>), edges (<kbd>2</kbd>) or faces (<kbd>3</kbd>). Several tools
  change what they do with it, so check the select mode when a tool surprises
  you.

### The mesh is a BMesh, not triangles

The kernel stores a half-edge structure in the style of Blender's BMesh:

| Element | Is |
| --- | --- |
| Vertex | A point, with the edges that use it |
| Edge | Two vertices, with the loops of every face that uses it (its *radial set*) |
| Loop | One corner of one face. `loop.next` walks the face's winding |
| Face | A ring of loops, any number of sides (an n-gon) |

Those links answer "which faces share this edge?" and "what is the next edge
around this vertex?", which loop cut, bevel and dissolve depend on. Triangles
appear only at the display and export boundary.

`mesh.validate()` returns a list of broken invariants. Every topology test ends
by expecting it to be empty.

Deeper: [mesh-kernel.md](mesh-kernel.md) and [math.md](math.md) for winding,
normals and the coordinate system.

### Selection lives on the mesh

Selected flags sit on the vertex, edge and face objects themselves, not in the
store, because that is where operators look for them.
`mesh.flushSelection(mode)` propagates a selection from the select mode's
element type to the other two.

### Every change is an operator

All mutations go through one named registry:

```ts
useEditorStore.getState().exec('extrude', { offset: 1 }, 'Extrude');
```

`exec` records an undo step, runs the kernel operator against the active
object, bumps `meshVersion` and writes a status string. Buttons, keys, tests
and scripts share this one entry point. Parameters are coerced to a
safe default rather than trusted.

Deeper: [scripting.md](scripting.md).

### Meshes mutate in place, so `meshVersion` exists

Operators rewrite the same `BMesh` instance rather than returning a new one.
That is fast, but it gives Zustand no new reference to compare. `meshVersion`
is a counter bumped on every mutation. Anything that depends on geometry,
React selector or viewport subscription alike, reads it.

Select narrowly at the call site, `useEditorStore((s) => s.shading)`, so a
component re-renders only on what it shows.

Deeper: [state-management.md](state-management.md).

### Undo is whole-document snapshots

History stores serialized snapshots, not `do`/`undo` pairs, because inverting a
bevel step by step is a project of its own. The rule is **snapshot before
mutating**, and `exec` does it for you. The same serialization backs project
files, autosave and `cloneMesh`.

### Modifiers are non-destructive

Mirror, array, solidify, bend, twist, weld, subdivision and remesh run on a
clone of the base mesh each time it changes. The mesh you edit is never touched
until you press Apply.

### The viewport draws what the store holds

The bridge turns a kernel mesh into GPU buffers and picking maps. The viewport
subscribes to `meshVersion` and rebuilds only the objects that changed. It
never writes state itself: even a gizmo drag goes through store actions, so
undo stays correct.

Deeper: [rendering.md](rendering.md).

### Origin, 3D cursor and pivot

- An object's **origin** is the point its vertex coordinates are measured from.
- The **3D cursor** is where new primitives appear, and can serve as a pivot or
  a mirror plane.
- The **pivot** setting picks what rotate and scale turn around: the origin,
  the selection's median, or the cursor.

Deeper: [features.md](features.md).

### Project versus preferences

A project is a `.3doo` file (JSON, with imported images inside). The browser
keeps no copy of it. Preferences belong to the person, not the project, and
live in localStorage.

Deeper: [saving.md](saving.md) and [export.md](export.md).

## One operation, end to end

Pressing <kbd>E</kbd> to extrude:

1. `useKeymap` matches the binding in
   [keymap.ts](../src/domain/keymap/keymap.ts) and calls `exec('extrude', ...)`.
2. `exec` snapshots the document into the undo history.
3. `execOperator` finds `extrude` in the kernel registry and mutates the mesh.
4. `exec` bumps `meshVersion` and writes the status line.
5. The viewport's subscription fires and rebuilds that object's buffers.
6. Panels that read counts re-render; the rest do not.

## Common tasks

| To | Do |
| --- | --- |
| Add a modelling operation | Write it in `src/kernel/ops/` with tests, register it in `OPERATORS` in `src/kernel/commands/operators.ts`, describe it in `OPERATOR_SPECS` for scripts, then call it from a button or key through `exec`. See [scripting.md](scripting.md#adding-an-operator) |
| Add or change a key | Edit `DEFAULT_KEYMAP` in [keymap.ts](../src/domain/keymap/keymap.ts) and handle its id in `useKeymap`. Then update [keymap.md](keymap.md) |
| Add a UI component | Presentation-only goes in `src/shared/components/`, anything that reads the store in `src/domain/components/`. See [design-system.md](design-system.md#adding-a-component) |
| Add a module | One entry in `APP_MODULES` in `src/app/modules.ts` and one branch in `App`. See [architecture.md](architecture.md) |
| Change file output | See [export.md](export.md) for OBJ and FBX, [saving.md](saving.md) for `.3doo` |

## Testing

Test the kernel, not screenshots. A topology test asserts exact counts, an
empty `validate()`, the Euler characteristic and, for convex solids, outward
normals. Two traps: never compare a `BMesh` with `toBe` or `toEqual` (the diff
walks the cyclic graph and exhausts memory), and wrap direct store calls in
`act` while a component is mounted.

Deeper: [testing.md](testing.md).

## House rules

These live in `.claude/rules/` and apply to every change:

- **Writing**: no em or en dashes, and no spaced hyphen standing in for one.
  Use a colon, a comma, brackets or a second sentence.
- **Nothing in the app names Blender.** Labels, hints, status messages and the
  Docs module say what a feature does. The lineage belongs in `README.md` and
  `docs/`. The one exception is Blender as an export target.
- **Code**: edit existing files before creating new ones, comment only a
  non-obvious why, and add no speculative abstractions.
- **Versioning**: record user-facing changes under `## [Unreleased]` in
  `CHANGELOG.md`. Version bumps are never made without asking first.

## What to read next

1. [architecture.md](architecture.md): how the layers fit and why.
2. [mesh-kernel.md](mesh-kernel.md): the data structure and every operation.
3. [state-management.md](state-management.md): slices, `meshVersion`, undo.
4. [features.md](features.md) and [keymap.md](keymap.md): what the user sees.
5. The rest as you need it: [rendering.md](rendering.md),
   [export.md](export.md), [saving.md](saving.md), [math.md](math.md),
   [design-system.md](design-system.md), [testing.md](testing.md).
