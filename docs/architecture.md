# Architecture

How the four layers fit together, and the reasoning behind the boundaries.

## The core split

A mesh editor mutates geometry dozens of times per second: dragging a gizmo
re-runs a solve every frame. Reconciling a scene graph on every vertex change
fights the framework, so the responsibilities are separated by what changes at
what rate.

| Layer | Changes at | Owns |
| --- | --- | --- |
| React UI | User interaction | Panels, forms, toolbars, outliner, dialogs, status |
| Zustand | Per action | Scene objects, tool state, viewport settings, UI state |
| Three.js | Per frame | Rendering, camera, gizmos, picking, GPU resources |
| Kernel | Per operation | Topology, modifiers, import/export, commands |

## Dependency direction

Dependencies point inward. The kernel knows nothing about anything else.

```text
app ──► domain ──► shared ──► global-styles
 │         │
 │         └──► store ──► kernel
 │                 ▲
 └──► viewport ────┘──► bridge ──► kernel
```

The rule that matters most: **the kernel must never import React, Three.js, the
DOM, or any browser API.** This is what makes every topology operation testable
in Node with a tight feedback loop, instead of "it looked right in the browser".

If you find yourself wanting `window` or `THREE` inside `/src/kernel`, the
design has gone wrong — the data needed belongs in the caller.

## Where each concern lives

### `/src/kernel`

Pure TypeScript. See [mesh-kernel.md](mesh-kernel.md).

- `math/` — vectors, matrices, transforms.
- `mesh/` — the BMesh structure, triangulation, serialization.
- `primitives/` — parametric shape constructors.
- `ops/` — extrude, inset, bevel, loop cut, subdivide, merge, dissolve, …
- `modifiers/` — the non-destructive stack and its evaluator.
- `io/` — OBJ, ASCII FBX, project files, UV projection.
- `commands/` — undo history and the operator registry.

### `/src/bridge`

Turns a kernel mesh into GPU buffers and Three.js objects. This is the only
place where both worlds are imported together. See [rendering.md](rendering.md).

### `/src/viewport`

The imperative Three.js application: renderer, camera controller, gizmo,
picking, grid. Created once against a canvas ref and never re-rendered by React.

### `/src/store`

Zustand, split into four slices. See [state-management.md](state-management.md).

### `/src/shared`

Presentation-only components. No business logic, no store access — except
`ToastHost`, which is a thin adapter over the toast slice. Each component lives
in its own folder with its `.tsx`, `.scss` and test; the parent `index.ts` is the
only barrel.

### `/src/domain`

Everything that knows what the application *is*: panels, the keymap, autosave,
file services, and the hooks that hold behaviour so components stay declarative.

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

Note that step 3 mutates rather than replaces the mesh. That is deliberate — see
[state-management.md](state-management.md) on why `meshVersion` exists.

## Things deliberately not abstracted

- **No renderer abstraction.** There is one renderer; an interface over it would
  be speculative.
- **No ECS.** Scene objects are a flat list with an optional parent id.
- **No command pattern with `do`/`undo` pairs.** Structural operations are painful
  to invert step by step, so history stores whole-document snapshots instead.
  See [state-management.md](state-management.md#undo).
