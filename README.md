# 3DOO

3DOO is a browser-based 3D mesh editor designed to bring real modeling workflows to the web. Create and edit 3D meshes directly in your browser, use familiar modeling operations, and export your work as game-ready assets.

At the heart of 3DOO is a pure TypeScript BMesh kernel: a half-edge mesh data structure with real topological relationships between vertices, edges, and faces. This is what allows modeling operations such as extrude, bevel, loop cut, and dissolve to behave like they do in traditional desktop 3D modeling software.

The modeling engine is completely independent from the browser UI and rendering layer. The kernel has no DOM or rendering dependencies, which makes it easy to test, reason about, and potentially reuse in different environments.

## Development Quick start

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm test         # 170 tests
npm run build    # typecheck + production bundle
npm run lint
```

## What the MVP does

| Area | Included |
| --- | --- |
| Primitives | Box, plane, circle, grid, UV sphere, ico sphere, cylinder, cone, capsule, torus — with live parameters |
| Object mode | Transform gizmo, duplicate, linked duplicate, join, delete, outliner with rename / visibility / lock |
| Selection | Vertex, edge and face modes; click, box select, Alt+click edge loops, grow / shrink / invert |
| Modelling | Extrude (region and individual), inset, bevel with segments, loop cut, subdivide (Catmull-Clark), merge by distance, delete, dissolve, fill, bridge, triangulate, tris-to-quads |
| Normals | Recalculate outside, flip, shade smooth / flat, face-orientation overlay |
| Modifiers | Mirror, array, solidify, weld, subdivision — non-destructive, reorderable, with Apply |
| Proportional editing | Six falloff curves |
| Viewport | Orbit / pan / zoom (Blender and Maya presets), solid / wireframe / x-ray / matcap, adaptive grid, normals overlay |
| Files | Save and load JSON projects, autosave to IndexedDB with crash recovery, OBJ import |
| Export | OBJ + MTL, **ASCII FBX 7.4**, with Unity / Unreal / Blender / Maya axis and unit presets |
| Undo | Snapshot history capped at 64 steps |

Everything deliberately left out of the MVP is listed in [TODO.txt](TODO.txt).

## Architecture

Four responsibilities, kept strictly apart:

```text
              ┌──────────────────────┐
              │       React UI       │   panels, outliner, properties, dialogs
              └──────────┬───────────┘
                         ▼
              ┌──────────────────────┐
              │       Zustand        │   scene · tool · viewport · ui slices
              └───────┬───────┬──────┘
                      │       │
        ┌─────────────┘       └──────────────┐
        ▼                                    ▼
┌──────────────────┐                 ┌──────────────────┐
│   Mesh Kernel    │◄───  Bridge  ──►│     Three.js     │
│ BMesh · ops      │                 │ renderer, gizmo  │
│ modifiers · io   │                 │ picking, camera  │
└──────────────────┘                 └──────────────────┘
        │
        ▼
   OBJ · FBX
```

- **The kernel never imports React, Three.js, or any browser API.** It runs in Node
  and is tested there.
- **Three.js is imperative and mounted once.** React does not reconcile scene-graph
  objects or vertices; the viewport reads the store directly through
  `subscribeWithSelector`.
- **React owns the chrome only** — panels, forms, toolbars, dialogs, status.

### Layout

```text
/src
  /kernel          pure TypeScript, zero Three.js imports
    math/  mesh/  primitives/  ops/  modifiers/  io/  commands/
  /bridge          kernel mesh → GPU buffers → Three.js objects
  /viewport        renderer, camera controller, picking, grid
  /store           Zustand slices
  /shared          brutalist component library (presentation only)
  /domain          panels, hooks, services, keymap
  /global-styles   Sass design system
  /app             application shell
/docs              architecture and subsystem documentation
```

## Documentation

| Document | Covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How the four layers fit together and why |
| [docs/mesh-kernel.md](docs/mesh-kernel.md) | The BMesh data structure and every modelling operation |
| [docs/math.md](docs/math.md) | Coordinate system, winding, normals, mitering, triangulation |
| [docs/state-management.md](docs/state-management.md) | Zustand slices, mesh versioning, undo |
| [docs/rendering.md](docs/rendering.md) | The display bridge, buffers, picking, camera |
| [docs/export.md](docs/export.md) | OBJ and ASCII FBX, axis presets, and the FBX pitfalls |
| [docs/design-system.md](docs/design-system.md) | Brutalist tokens, mixins, and usability guardrails |
| [docs/scripting.md](docs/scripting.md) | The operator registry / `exec` API |
| [docs/testing.md](docs/testing.md) | What is tested and how to add to it |

## Keyboard

Blender defaults, because that is the muscle memory users arrive with. Press
<kbd>Shift</kbd> + <kbd>?</kbd> in the app for the full list.

| Key | Action |
| --- | --- |
| `Tab` | Toggle edit mode |
| `1` / `2` / `3` | Vertex / edge / face select |
| `G` / `R` / `S` | Move / rotate / scale |
| `E` / `I` | Extrude / inset |
| `Ctrl+B` / `Ctrl+R` | Bevel / loop cut |
| `M` | Merge by distance |
| `X` | Delete — object mode: the object; edit mode: the selection, leaving a hole |
| `Delete` | Object mode: the object; edit mode: dissolve the selection, keeping the surface |
| `A` / `Alt+A` | Select all / deselect |
| `.` | Frame selected |
| `Ctrl+S` / `Ctrl+E` | Save / export |

In edit mode both <kbd>X</kbd> and <kbd>Delete</kbd> act on whichever element
type the current select mode targets — vertices in <kbd>1</kbd>, edges in
<kbd>2</kbd>, faces in <kbd>3</kbd>. The difference is what they leave behind:
delete removes the geometry outright and leaves a hole, dissolve removes the
topology but keeps the surrounding surface intact. Dissolving faces merges
adjacent ones into a single n-gon, so it needs two or more touching faces — a
lone face has nothing to merge with and the status bar says so rather than
reporting a no-op as a success.

Because the keys cover both, the Operations panel has no Delete or Dissolve
section; it offers Merge instead, which welds the selected vertices together at
their center, or onto the first or last one selected. Merge is vertex-only and is
disabled in edge and face mode. Object mode's panel likewise drops its Delete
button — the same two keys cover it — and carries Recalculate Normals instead,
which is otherwise unreachable outside edit mode and is most often wanted right
after a Join.

Navigation is <kbd>MMB</kbd> to orbit and <kbd>Shift</kbd>+<kbd>MMB</kbd> to pan
by default; a Maya preset (<kbd>Alt</kbd>-based) is also available.

## Stack

Vite · React 18 · TypeScript (strict) · imperative Three.js · Zustand · Sass.

No Tailwind, no CSS-in-JS, no component library — the brutalist system is a small
set of Sass mixins over CSS custom properties.

## Licence

Unlicensed prototype.
