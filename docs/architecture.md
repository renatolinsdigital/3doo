# Architecture

How the four layers fit together, and the reasoning behind the boundaries.

## The core split

A mesh editor mutates geometry dozens of times per second: dragging a gizmo
re-runs a solve every frame. Reconciling a scene graph on every vertex change
fights the framework, so the responsibilities are separated by what changes at
what rate.

| Layer | Changes at | Owns |
| --- | --- | --- |
| React UI | User interaction | Modules, panels, forms, toolbars, outliner, dialogs, status |
| Zustand | Per action | Scene objects, tool state, viewport settings, UI state |
| Three.js | Per frame | Rendering, camera, gizmos, picking, GPU resources |
| Kernel | Per operation | Topology, modifiers, import/export, commands |

## Dependency direction

Dependencies point inward. The kernel knows nothing about anything else.

```text
app ──► modules ──► domain ──► shared ──► global-styles
            │          │
            │          └──► store ──► kernel
            │                  ▲
            └──► viewport ─────┘──► bridge ──► kernel
```

The rule that matters most: **the kernel must never import React, Three.js, the
DOM, or any browser API.** This is what makes every topology operation testable
in Node with a tight feedback loop, instead of "it looked right in the browser".

If you find yourself wanting `window` or `THREE` inside `/src/kernel`, the
design has gone wrong: the data needed belongs in the caller.

## Where each concern lives

### `/src/kernel`

Pure TypeScript. See [mesh-kernel.md](mesh-kernel.md).

- `math/` holds vectors, matrices, transforms.
- `mesh/` holds the BMesh structure, triangulation, serialization.
- `primitives/` holds the parametric shape constructors.
- `ops/` holds extrude, inset, bevel, loop cut, subdivide, merge, dissolve, …
- `modifiers/` holds the non-destructive stack and its evaluator.
- `io/` holds OBJ, ASCII FBX, project files, UV projection.
- `commands/` holds undo history and the operator registry.

### `/src/bridge`

Turns a kernel mesh into GPU buffers and Three.js objects. This is the only
place where both worlds are imported together. See [rendering.md](rendering.md).

### `/src/viewport`

The imperative Three.js application: renderer, camera controller, gizmo,
picking, grid. Created once against a canvas ref and never re-rendered by React.

### `/src/store`

Zustand, split into five slices. See [state-management.md](state-management.md).

### `/src/shared`

Presentation-only components. No business logic, no store access, except
`ToastHost`, which is a thin adapter over the toast slice. Each component lives
in its own folder with its `.tsx`, `.scss` and test; the parent `index.ts` is the
only barrel.

### `/src/domain`

Everything that knows what the application *is*: panels, the keymap, autosave,
file services, and the hooks that hold behaviour so components stay declarative.

This is also the only layer that talks to files and browser storage:
`services/autosave.ts` for the numbered copies and the one handle it keeps in
IndexedDB, the autosave location, and `services/download.ts` for opening and
saving `.3doo` files. The browser keeps no copy of a project. The viewport never
reads any of it. It draws what the store holds, which is how an image reaches
the screen without `/src/viewport` importing `/src/domain` and inverting the
arrows above. See [saving.md](saving.md).

### `/src/modules` and `/src/app`

A **module** is one whole area of the application, reachable at its own path:

| Module | Path | Is |
| --- | --- | --- |
| `home` | `/` | The landing page |
| `modeling` | `/modeling` | The mesh editor, the shell that was once `App` |
| `docs` | `/docs` | The user manual, with its own left-hand contents menu |

`/src/app` holds only what all of them share: the registry in `modules.ts`, the
router, the `ModuleSwitcher` brand plate, and an `App` whose entire job is to read
the path and hand the screen to one module.

Each module owns its own layout **and its own lifecycle hooks**. `useKeymap` and
`useAutosave` are mounted inside `ModelingModule`, not in `App`, which is what
stops <kbd>X</kbd> deleting geometry while someone is reading the docs. It is
also what keeps the landing page cheap: nothing imports the viewport until the
modeling module mounts, so no WebGL context is created to show a hero heading.

Adding sculpting later is one entry in `APP_MODULES` and one branch in `App`.

The arrow from `app` runs one way only. `TopBar` does not import the switcher.
It takes the brand plate as a `brand` prop, and `ModelingModule` passes it in.
A domain component reaching back up into `/src/app` would invert the rule this
whole diagram rests on.

#### Routing

There is no router dependency. `app/router.ts` is a `useSyncExternalStore` over
`history.pushState` and `popstate`, about thirty lines. Nested routes, params
and loaders would all go unused, because the registry already says which path
maps to which area; the docs module's sections are a URL fragment, not a route.

The one deployment requirement this creates: `/modeling` and `/docs` must serve
`index.html`. Vite's dev server and `preview` already do; a static host needs its
SPA fallback turned on.

## Data flow of one operation

Pressing <kbd>E</kbd> to extrude:

1. `useKeymap` matches the binding and calls `store.exec('extrude', { offset: 1 })`.
2. `exec` snapshots the document into the undo history.
3. `execOperator` looks the operator up in the kernel registry, coerces the
   parameters, and mutates the active object's `BMesh` in place.
4. `exec` increments `meshVersion` and writes a status string.
5. The viewport's `subscribeWithSelector` subscription on `meshVersion` fires and
   rebuilds that object's GPU buffers.
6. Panels subscribed to counts re-render; panels subscribed to unrelated state do
   not.

Note that step 3 mutates rather than replaces the mesh. That is deliberate: see
[state-management.md](state-management.md) on why `meshVersion` exists.

## Things deliberately not abstracted

- **No renderer abstraction.** There is one renderer; an interface over it would
  be speculative.
- **No ECS.** Scene objects are a flat list with an optional parent id.
- **No command pattern with `do`/`undo` pairs.** Structural operations are painful
  to invert step by step, so history stores whole-document snapshots instead.
  See [state-management.md](state-management.md#undo).
