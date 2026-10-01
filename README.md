# 3DOO

3DOO is a browser-based 3D mesh editor designed to bring real modeling workflows to the web. Create and edit 3D meshes directly in your browser, use familiar modeling operations, and export your work as game-ready assets.

At the heart of 3DOO is a pure TypeScript BMesh kernel: a half-edge mesh data structure with real topological relationships between vertices, edges, and faces. This is what allows modeling operations such as extrude, bevel, loop cut, and dissolve to behave like they do in traditional desktop 3D modeling software.

3DOO is inspired by Blender. Its keymap, camera navigation and much of how its tools behave follow Blender's, so anyone who models in Blender finds their way around quickly. The app itself never names Blender: this documentation is where that lineage is recorded.

The modeling engine is completely independent from the browser UI and rendering layer. The kernel has no DOM or rendering dependencies, which makes it easy to test, reason about, and potentially reuse in different environments.

## Development Quick start

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm test         # 1420 tests
npm run build    # typecheck + production bundle
npm run lint
```

## Modules

The app is split into modules, switched from the brand plate in the top-left
corner. Each has its own path and owns its own layout and lifecycle.

| Module | Path | Is |
| --- | --- | --- |
| Home | `/` | Landing page |
| Modeling | `/modeling` | The mesh editor |
| Docs | `/docs` | The user manual, with a left-hand contents menu |

Sculpting is the next module planned. See
[architecture.md](docs/architecture.md) for how one is added.

## What the MVP does

| Area | Included |
| --- | --- |
| Primitives | Cube, plane, circle, grid, UV sphere, ico sphere, cylinder, cone, capsule, torus, with live parameters |
| Object mode | Transform gizmo, duplicate, linked duplicate, merge, separate, union / difference / intersect booleans, apply transform, delete, outliner with rename / visibility / lock and Ctrl+G groups that rename, select, join, ungroup or delete as one |
| Selection | Vertex, edge and face modes; click and Shift+click, box / circle / lasso region select, Alt+click edge and face loops, grow / shrink / invert |
| Modelling | Extrude (region and individual), inset, bevel with segments, loop cut, subdivide (Catmull-Clark), vertex and edge slide, relax, circle, space, merge, merge by distance, connect, delete, dissolve, fill, bridge, triangulate, tris-to-quads |
| Normals | Recalculate outside, flip, shade smooth / flat, face-orientation overlay |
| Modifiers | Mirror, array, solidify, weld, subdivision, remesh. All non-destructive, reorderable, with Apply |
| Remesh | A modifier with three methods: voxel quad shell (signed distance field, surface nets, crease and corner constraints), blocks straight off the lattice, and quadric error decimation |
| 3D cursor | Right-click to place it on a point, vertex, edge or face; snap it to the selection or the selection to it; use it as the transform pivot or as a mirror plane |
| Proportional editing | Six falloff curves, with a viewport ring showing how far the falloff reaches. Scroll to resize it mid-transform, or Ctrl+scroll any time |
| Viewport | Orbit / pan / zoom (Blender and Maya presets), solid / wireframe / x-ray / matcap, adaptive grid, normals overlay |
| Files | Save and load `.3doo` projects (JSON, with imported images inside), OBJ import, PNG / JPG / BMP import as a plane at the origin |
| Autosave | Off until turned on. Writes numbered `.3doo` copies into a `3doo-auto-saves` folder in a location you choose, every 30 seconds to 15 minutes, and only when the scene has changed. Nothing of the project is kept in the browser. Needs a browser with a folder picker (Chrome, Edge) |
| Opening scene | A fresh tab starts on a cube, as Blender does, and so does FILE > NEW. One Ctrl+Z takes it away |
| Preferences | Tooltips, panel visibility, viewport background, grid, snapping, undo depth, autosave and the selection outline, kept in localStorage per browser, with import / export as a `.pref` file |
| Export | OBJ + MTL, **ASCII FBX 7.4**, with Unity / Unreal / Blender / Maya axis and unit presets |
| Undo | Whole-scene snapshot history, 50 steps by default and 10 to 100 under UNDO STEPS, with a history list to click straight back to any of them |

## Architecture

Four responsibilities, kept strictly apart:

```text
              ┌──────────────────────┐
              │       React UI       │   panels, outliner, properties, dialogs
              └──────────┬───────────┘
                         ▼
              ┌──────────────────────┐
              │       Zustand        │   scene · tool · viewport · ui · preferences slices
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
- **React owns the chrome only**: panels, forms, toolbars, dialogs, status.

### Layout

```text
/src
  /kernel          pure TypeScript, zero Three.js imports
    math/  mesh/  primitives/  ops/  modifiers/  remesh/  io/  commands/
  /bridge          kernel mesh → GPU buffers → Three.js objects
  /viewport        renderer, camera controller, picking, grid
  /store           Zustand slices
  /shared          brutalist component library (presentation only)
  /domain          panels, hooks, services, keymap
  /global-styles   Sass design system
  /modules         home, modeling and docs, one per path
  /app             application shell: module registry, router, brand switcher
/docs              architecture and subsystem documentation
```

## Documentation

| Document | Covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How the four layers fit together and why |
| [docs/mesh-kernel.md](docs/mesh-kernel.md) | The BMesh data structure, every modelling operation, and the modifier stack |
| [docs/math.md](docs/math.md) | Coordinate system, winding, normals, mitering, triangulation |
| [docs/state-management.md](docs/state-management.md) | Zustand slices, mesh versioning, undo |
| [docs/rendering.md](docs/rendering.md) | The display bridge, buffers, picking, camera |
| [docs/export.md](docs/export.md) | OBJ and ASCII FBX, axis presets, and the FBX pitfalls |
| [docs/saving.md](docs/saving.md) | Autosave, project files, and where a project lives in the browser |
| [docs/design-system.md](docs/design-system.md) | Brutalist tokens, mixins, and usability guardrails |
| [docs/scripting.md](docs/scripting.md) | The operator registry / `exec` API |
| [docs/testing.md](docs/testing.md) | What is tested and how to add to it |

## Keyboard

Blender defaults, because that is the muscle memory users arrive with. The
bindings live in one table, [keymap.ts](src/domain/keymap/keymap.ts), which the
in-app overlay (<kbd>Shift</kbd> + <kbd>?</kbd>) and the Docs module both build
their lists from. What follows is that table, in full.

### Modes and selection

| Key | Action |
| --- | --- |
| `Tab` | Toggle edit mode |
| `1` / `2` / `3` | Vertex / edge / face select (edit mode) |
| `V` | Select tool: press again for the next region shape (box, circle, lasso) |
| `A` / `Alt+A` | Select all / deselect all |
| `Ctrl+I` | Invert the selection |
| `Alt+L` | Select the face loop running through two adjacent faces (edit mode) |
| `]` / `[` | Grow / shrink the selection (edit mode) |
| `Esc` | Clear the selection and put the gizmo away |

### Transform

| Key | Action |
| --- | --- |
| `G` | Move tool: the gizmo handles do the dragging |
| `R` / `S` | Rotate / scale, running off the pointer from the keypress |
| `X` / `Y` / `Z` | Mid rotate or scale: pin it to that axis, press again to lift |
| `Shift+G` | Slide vertices along their edges, or edges across their faces (edit mode) |

### Modelling

| Key | Action |
| --- | --- |
| `E` | Extrude, the distance dragged along the region normal (edit mode) |
| `I` | Inset, the thickness dragged in toward the selection (edit mode) |
| `Ctrl+B` | Bevel, the width dragged in toward the selection (edit mode) |
| `Ctrl+R` | Loop cut across the quad ring the selected edge runs through (edit mode) |
| `Ctrl+D` | Subdivide: splits selected edges at their midpoint, or cuts up faces |
| `M` | Object mode: merge the selected objects; edit mode: merge by distance |
| `F` | Fill a boundary loop with a face (edit mode) |
| `J` | Connect two selected vertices with an edge (edit mode) |
| `Alt+B` | Bridge two open edge loops with a band of quads (edit mode) |
| `Alt+T` / `Alt+J` | Triangulate / merge near-coplanar triangle pairs back into quads (edit mode) |
| `Shift+N` | Recalculate normals, pointing them outward |

### Objects, history and files

| Key | Action |
| --- | --- |
| `Shift+D` / `Alt+D` | Duplicate / linked duplicate, the copy sharing the mesh data |
| `P` | Separate the loose parts into an object each |
| `Ctrl+A` | Apply rotation and scale into the mesh |
| `X` | Delete. Object mode: the object; edit mode: the selection, leaving a hole |
| `Delete` | Object mode: the object; edit mode: dissolve the selection, keeping the surface |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+S` / `Ctrl+O` / `Ctrl+E` | Save / open / export |
| `Shift+?` | The shortcut overlay |

### Viewport and the 3D cursor

| Key | Action |
| --- | --- |
| `.` / `Home` | Frame selected / frame all |
| `5` | Orthographic / perspective |
| `Shift+1` / `3` / `7` | Front / right / top view, with `Ctrl` for the opposite three |
| `Shift+4` / `6` / `8` / `2` | Orbit left / right / up / down, fifteen degrees a press |
| `Shift+9` | Look from the opposite side |
| `Shift+Z` | Cycle shading: solid, solid + wireframe, wireframe, x-ray, matcap |
| `Shift+C` | 3D cursor to the world origin |
| `Ctrl+Shift+C` | 3D cursor to the selection |
| `Shift+V` | Selection to the 3D cursor |
| `Ctrl+.` | Cycle the pivot: origin, median, 3D cursor |

The mouse carries a few of its own: <kbd>Alt</kbd>+click selects an edge loop,
right-click opens the 3D cursor menu, and <kbd>Ctrl</kbd>+scroll resizes the
proportional-editing falloff, which plain scroll also does mid-transform.

### Moving the camera from the keyboard

Blender's numpad arrangement, with <kbd>Shift</kbd> in front of it, on the
number row and the numpad alike. Odd keys jump to a view, even keys turn the
camera by a step:

| Key | Does |
| --- | --- |
| `Shift+1` / `3` / `7` | Front / right / top view |
| `Ctrl+Shift+1` / `3` / `7` | The opposite of each: back / left / bottom |
| `Shift+4` / `6` | Orbit left / right, fifteen degrees a press |
| `Shift+8` / `2` | Orbit up / down, fifteen degrees a press |
| `Shift+9` | Look from the opposite side, the same distance out |
| `Shift+5` | Orthographic / perspective, as plain `5` also does |

Every one of them answers from either block, because neither block is always
there: a laptop has no numpad, and a hand already resting on one should not
have to travel up to the row. <kbd>Shift</kbd> is what keeps the whole
arrangement clear of <kbd>1</kbd>, <kbd>2</kbd> and <kbd>3</kbd>, which pick
the vertex, edge and face select modes in edit mode.

Fifteen degrees a press is Blender's step, and it is chosen so a run of presses
lands squarely: six of them make a quarter turn, so orbiting up from the front
view arrives at the top view rather than near it. The four directions are named
for where the camera goes, not for which way the scene appears to turn. A run
aimed at straight up stops there rather than tipping over it, and the press
after that carries on across, upside down, unless LOCK VERTICAL ORBIT under
PREFS is on.

The bindings match the physical key rather than the character it produces,
which each block needs for its own reason. A shifted digit arrives as `!` on a
US keyboard and as something else again on every other layout. A numpad digit
arrives as `1` or as `End` depending on NumLock, a light on the keyboard that has
no business deciding whether a camera moves. The code of the key itself is the
one thing that stays put through both.

None of these snap. The camera turns to the view over about two tenths of a
second, easing off at both ends, which is Blender's smooth view and is there
for a reason: a view that snaps tells you where the camera ended up, and a view
that turns tells you how the model you were looking at relates to the one you
are looking at now. Going from the right side to the left is the case that
makes the point, since the two pictures are mirror images and the turn between
them is the only thing that says which way round the model went. Grabbing the
camera with the mouse mid-turn takes it from wherever it has got to, and a
second press of an orbit key stacks onto where the first one was heading rather
than being swallowed.

A view changes the direction only. The point the camera orbits and the distance
it stands at are both left where they were, so a view or a step turns the scene
around without moving you nearer or further, and a mouse orbit afterwards picks
up from where the keyboard left off. The status bar names what you pressed. The
six coloured ends of the axis widget in the corner reach the same six views
with the mouse, and turn to them the same way.

### Extrude, inset and bevel run off the pointer

<kbd>E</kbd>, <kbd>I</kbd> and <kbd>Ctrl</kbd>+<kbd>B</kbd> take one distance
each, and a distance typed in before the shape it makes has been seen is
guesswork. The key puts a dashed guide up and the mesh follows the pointer from
there, live, until a click or <kbd>Enter</kbd> confirms it and <kbd>Esc</kbd>
puts it back. The status bar reads the distance out as it goes.

A bevel and an inset open the same way round, so the pair has one gesture
between them: push the pointer in toward the geometry being cut. The way in is
fixed when the drag starts, running from wherever the pointer was to the
selection, and travel is read along that line rather than as a distance from
the selection, so sweeping the pointer on past the middle keeps widening the cut
instead of closing it again. Pull back the way you came to close it. An extrude
travels along the region normal alone: the guide is drawn along that axis
through the selection, only travel along it counts, and dragging back past the
start sinks the region into the surface rather than raising it off.

None of the three nudges what is already there, so every pointer move re-runs
the operator from the mesh as it stood at the keypress rather than layering
another cut on the last one. Confirming without having moved leaves the mesh
alone and records no undo step, so a stray <kbd>E</kbd> or <kbd>I</kbd> costs
nothing. The OPERATIONS panel keeps its number fields for when the exact figure
is the point.

<kbd>Ctrl</kbd>+<kbd>D</kbd> follows the select mode too: in edge mode it splits
each selected edge, dropping a vertex at its midpoint and splicing it into the
rings of both faces that share it, and the Loop Operations panel's button relabels
itself to Subdivide Edge. In vertex and face mode it keeps cutting whole faces
up Catmull-Clark style, where the Smooth parameter applies.

In edit mode both <kbd>X</kbd> and <kbd>Delete</kbd> act on whichever element
type the current select mode targets: vertices in <kbd>1</kbd>, edges in
<kbd>2</kbd>, faces in <kbd>3</kbd>. The difference is what they leave behind:
delete removes the geometry outright and leaves a hole, dissolve removes the
topology but keeps the surrounding surface intact. Dissolving faces merges
adjacent ones into a single n-gon, so it needs two or more touching faces. A
lone face has nothing to merge with and the status bar says so rather than
reporting a no-op as a success. Dissolving an edge likewise skips edges whose
two faces meet at more than 40°, and the same for a vertex at a *corner* whose
surrounding faces do: the merge keeps every vertex in place and so produces a
folded face, which is what made dissolving a cube edge or corner look broken. A
vertex lying along a path rather than at a corner (the midpoint left by
subdividing an edge) merges nothing and always dissolves, whatever angle its
faces meet at.

Because the keys cover both, no panel has a Delete or Dissolve button. Merge
lives in the TOPOLOGY panel instead, welding the selected vertices at their
centre, at the 3D cursor, or onto the first or last one selected. Every
operation in the edit-mode panels disables itself when the current selection
cannot feed it. Merge and Connect are vertex-only and want two or more and
exactly two vertices respectively, Fill wants three edges and Bridge four,
Bevel and Loop Cut want edges, Inset wants faces. Each keeps its hint while
disabled, saying what to select instead. Only Merge by Distance, Triangulate
and Tris to Quads are always available, because each falls back to the whole
mesh. The OBJECT panel likewise has no Delete button (the same two keys cover
it) and carries Recalculate Normals instead, which is most often wanted right
after a merge.

### Object origins

Every object carries an origin: the zero its vertex coordinates are measured
from. It is the point **Location** names, the point the gizmo seats its handles
on, the point a rotation or a scale turns about, and the plane a Mirror modifier
reflects across. The amber square on a selected object marks it, drawn over the
geometry rather than behind it because an origin usually sits inside the mesh.
**Overlays → Origins** hides the square without moving anything.

An object-mode move carries the origin along with the mesh. An edit-mode move
does not: vertex coordinates change and the zero behind them stays put, so
geometry dragged across the scene leaves its origin, its handles and its square
behind. The <kbd>⊙</kbd> button at the foot of the tool rail (Origin to
geometry) brings all three back onto the middle of the mesh. Nothing moves on
screen, because the vertices give up exactly what the origin gains. It wants a
single-user mesh: linked copies share their vertices, so moving one origin would
drag every other copy off its own.

Merge, Separate and the three booleans hand back geometry the old origin has no
claim on, so each of them re-centres what it leaves behind, exactly as Origin to
geometry would. A merge spans everything that came in, a separated part is one
piece of what used to be a whole, and a cut can take away the very corner the
origin was sitting in. Duplicate, Linked duplicate, Apply transform and
Recalculate normals leave the origin alone: a copy is meant to behave like its
source, and neither of the other two moves the geometry relative to its zero.

### The 3D cursor

The red and white ring is where new primitives are born and, when you want it to
be, what transforms turn around. Right-click anywhere in the viewport for its
menu: **Place here** drops it on the surface under the pointer (over empty
space, on the view plane it is already on), while **To vertex**, **To edge
centre** and **To face centre** snap it onto the geometry the click landed near.
Entries the click found nothing for are disabled rather than hidden, and say so
on hover, so the menu keeps the same shape every time.

The same menu moves the cursor **to selection**, moves the **selection here**
(the group travels as a unit and lands on the point the gizmo is showing), and
sends it back **to the world origin**. Hide the ring from
**Overlays → 3D cursor**; hiding it does not move it or stop anything using it.

Two things read the cursor once it is somewhere useful. The **PIVOT** picker in
the top bar sets what rotate and scale turn around: the object's origin, the
median of the selection, or the cursor, in both object and edit mode. The gizmo
sits on whichever is in force, and the status bar flags any choice other than
median. And the Mirror modifier's **Origin** chooses whether its plane passes
through the object's own origin or through the cursor, which is how you mirror
a limb about a point that is not the object's centre.

Navigation is <kbd>MMB</kbd> to orbit and <kbd>Shift</kbd>+<kbd>MMB</kbd> to pan
by default; a Maya preset (<kbd>Alt</kbd>-based) is also available.

## Stack

Vite · React 18 · TypeScript (strict) · imperative Three.js · Zustand · Sass.

No Tailwind, no CSS-in-JS, no component library. The brutalist system is a small
set of Sass mixins over CSS custom properties.

## Licence

Unlicensed prototype.
