# 3DOO

3DOO is a 3D mesh editor that runs in the browser. You model with the
operations of a desktop package (extrude, inset, bevel, loop cut, dissolve and
the rest) and export the result as OBJ or FBX, ready for a game engine.

Underneath sits a mesh kernel written in plain TypeScript. It stores a
half-edge structure in the style of Blender's BMesh, so every vertex knows its
edges and every edge knows the faces on either side. Those links are what make
loop cut, bevel and dissolve possible. The kernel imports nothing from React,
Three.js or the browser, so it runs and is tested in Node, and could be reused
anywhere else.

3DOO is inspired by Blender. Its keymap, its camera and much of how its tools
behave follow Blender's, so a Blender user finds their way around quickly. The
app itself never names Blender: this documentation is where that lineage is
recorded.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm test         # 1420 tests
npm run build    # typecheck + production bundle
npm run lint
```

## What it does

| Area | Included |
| --- | --- |
| Primitives | Cube, plane, circle, grid, UV sphere, ico sphere, cylinder, cone, capsule, torus, with live parameters |
| Object mode | Transform gizmo, duplicate, linked duplicate, merge, separate, union / difference / intersect booleans, apply transform, delete, outliner with rename / visibility / lock and Ctrl+G groups that rename, select, join, ungroup or delete as one |
| Selection | Vertex, edge and face modes; click and Shift+click, box / circle / lasso region select, Alt+click edge and face loops, grow / shrink / invert |
| Modelling | Extrude (region and individual), inset, bevel with segments, loop cut, subdivide (Catmull-Clark), vertex and edge slide, relax, circle, space, merge, merge by distance, connect, delete, dissolve, fill, bridge, triangulate, tris-to-quads |
| Normals | Recalculate outside, flip, shade smooth / flat, mark / clear sharp edges (drawn in cyan, carried through subdivide, loop cut, merge and the modifiers), face-orientation overlay |
| Modifiers | Mirror, array, solidify, weld, subdivision, remesh. All non-destructive, reorderable, with Apply |
| Remesh | A modifier with three methods: voxel quad shell (signed distance field, surface nets, crease and corner constraints), blocks straight off the lattice, and quadric error decimation |
| 3D cursor | Right-click to place it on a point, vertex, edge or face; snap it to the selection or the selection to it; use it as the transform pivot or as a mirror plane |
| Proportional editing | Six falloff curves, with a viewport ring showing how far the falloff reaches. Scroll to resize it mid-transform, or Ctrl+scroll any time |
| Viewport | Orbit / pan / zoom, solid / wireframe / x-ray / matcap, adaptive grid, normals overlay |
| Files | Save and load `.3doo` projects (JSON, with imported images inside), OBJ and FBX import (binary or ASCII, FBX 7 onwards, landing the right way up and the right size), PNG / JPG / BMP import as a plane at the origin |
| Autosave | Off until turned on. Writes numbered `.3doo` copies into a `3doo-auto-saves` folder you choose, every 30 seconds to 15 minutes, and only when the scene has changed. The browser keeps no copy of the project. Needs a browser with a folder picker (Chrome, Edge) |
| Opening scene | A fresh tab starts on a cube, as Blender does, and so does FILE > NEW. One Ctrl+Z takes it away |
| Preferences | Tooltips, panel visibility, viewport background, grid, snapping, undo depth, autosave and the selection outline, kept in localStorage per browser, with import / export as a `.pref` file |
| Export | OBJ + MTL, **binary FBX 7.4**, with Unity / Unreal / Blender / Maya axis and unit presets; image planes keep their picture |
| Undo | Whole-scene snapshot history, 50 steps by default and 10 to 100 under UNDO STEPS, with a history list to click straight back to any of them |

## Modules

The app is split into modules. Switch between them from the brand plate in the
top-left corner. Each module has its own path and owns its own layout and
lifecycle.

| Module | Path | Is |
| --- | --- | --- |
| Home | `/` | Landing page |
| Modeling | `/modeling` | The mesh editor |
| Docs | `/docs` | The user manual, with a left-hand contents menu |

Sculpting is the next module planned.
[architecture.md](docs/architecture.md) explains how a module is added.

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

Three rules hold the split in place:

- **The kernel never imports React, Three.js or any browser API.** It runs in
  Node and is tested there.
- **Three.js is imperative and mounted once.** React does not reconcile
  scene-graph objects or vertices. The viewport reads the store directly
  through `subscribeWithSelector`.
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
| [docs/export.md](docs/export.md) | OBJ and binary FBX, axis presets, and the FBX pitfalls |
| [docs/saving.md](docs/saving.md) | Project files, autosave, and what the browser keeps |
| [docs/design-system.md](docs/design-system.md) | Brutalist tokens, mixins, and usability guardrails |
| [docs/scripting.md](docs/scripting.md) | The operator registry / `exec` API |
| [docs/testing.md](docs/testing.md) | What is tested and how to add to it |

The user manual is not in this folder. It is the Docs module, written in
[content.ts](src/modules/docs/content.ts).

## Keyboard

The keymap follows Blender's defaults, because that is the muscle memory users
arrive with. Every binding lives in one table,
[keymap.ts](src/domain/keymap/keymap.ts). The in-app overlay
(<kbd>Shift</kbd> + <kbd>?</kbd>) and the Docs module both build their lists
from it, so they cannot drift. The tables below are a copy: update them when a
binding changes.

A binding marked *edit* works in edit mode only, and one marked *object* in
object mode only. The rest work in both.

### Modes and selection

| Key | Action |
| --- | --- |
| `Tab` | Toggle edit mode |
| `1` / `2` / `3` | Vertex / edge / face select (*edit*) |
| `V` | Select tool. Press again for the next region shape: box, circle, lasso |
| `A` / `Alt+A` | Select all / deselect all |
| `Ctrl+I` | Invert the selection |
| `Alt+L` | Select the face loop running through two adjacent faces (*edit*) |
| `]` / `[` | Grow / shrink the selection (*edit*) |
| `Esc` | Clear the selection and put the gizmo away |

### Transform

| Key | Action |
| --- | --- |
| `G` | Pick the move tool. The gizmo handles do the dragging |
| `R` / `S` | Rotate / scale, following the pointer from the keypress |
| `X` / `Y` / `Z` | During a rotate or scale: lock it to that axis. Press again to unlock |
| `Shift+G` | Slide vertices along their edges, or edges across their faces (*edit*) |

### Modelling

| Key | Action |
| --- | --- |
| `E` | Extrude: drag the distance along the region normal (*edit*) |
| `I` | Inset: drag the thickness in toward the selection (*edit*) |
| `Ctrl+B` | Bevel: drag the width out from the selection (*edit*) |
| `Ctrl+R` | Loop cut (*edit*) |
| `Ctrl+D` | Subdivide: split selected edges at their midpoint, or cut up faces (*edit*) |
| `M` | Merge by distance (*edit*) |
| `F` | Fill a boundary loop with a face (*edit*) |
| `J` | Connect two vertices with an edge, splitting the face (*edit*) |
| `Alt+B` | Bridge two open edge loops with a band of quads (*edit*) |
| `Alt+T` | Triangulate every face (*edit*) |
| `Alt+J` | Merge adjacent, near-coplanar triangle pairs back into quads (*edit*) |
| `Shift+N` | Recalculate normals, pointing them outward |

### Objects and history

| Key | Action |
| --- | --- |
| `M` | Merge the selected objects into the active one (*object*) |
| `Shift+D` / `Alt+D` | Duplicate / linked duplicate, the copy sharing the mesh data (*object*) |
| `P` | Separate the loose parts into an object each (*object*) |
| `Ctrl+G` | Group the selected objects into a folder in the outliner (*object*) |
| `Ctrl+A` | Apply rotation and scale into the mesh (*object*) |
| `X` | Object mode: delete the object. Edit mode: delete the selection, leaving a hole |
| `Delete` | Object mode: delete the object. Edit mode: open the delete menu, to delete or dissolve vertices, edges or faces |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |

### The 3D cursor

| Key | Action |
| --- | --- |
| `C` | Place the cursor under the pointer |
| `Alt+V` / `Alt+E` / `Alt+F` | Cursor to the vertex, edge centre or face centre under the pointer |
| `Shift+C` | Cursor to the world origin |
| `Ctrl+Shift+C` | Cursor to the selection |
| `Alt+Shift+C` | Cursor to the origin of the selection |
| `Shift+V` | Selection to the cursor |
| `Alt+Shift+V` | Origins of the selected objects to the cursor |
| `Alt+C` | Hide or show the cursor |
| `Ctrl+.` | Cycle the pivot: origin, median, 3D cursor |

### View

| Key | Action |
| --- | --- |
| `.` / `Home` | Frame selected / frame all |
| `5` | Orthographic / perspective |
| `Shift+1` / `3` / `7` | Front / right / top view |
| `Ctrl+Shift+1` / `3` / `7` | Back / left / bottom view |
| `Shift+4` / `6` | Orbit left / right, fifteen degrees a press |
| `Shift+8` / `2` | Orbit up / down, fifteen degrees a press |
| `Shift+9` | Look from the opposite side, the same distance out |
| `Shift+5` | Orthographic / perspective, like plain `5` |
| `Shift+Z` | Cycle shading: solid, solid + wireframe, wireframe, x-ray, matcap |

### Files and help

| Key | Action |
| --- | --- |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / save as a new file |
| `Ctrl+O` | Open a project |
| `Ctrl+E` | Export |
| `Shift+?` | The shortcut overlay |

### Mouse

| Input | Action |
| --- | --- |
| Middle-drag | Orbit |
| <kbd>Shift</kbd> + middle-drag | Pan |
| Wheel | Zoom |
| <kbd>Alt</kbd> + click | Select the edge loop (edge select) or face loop (face select) under the pointer |
| Right-click | The 3D cursor menu |
| <kbd>Ctrl</kbd> + wheel | Resize the proportional-editing falloff. Plain wheel does the same mid-transform |

The camera controller also has a Maya preset (<kbd>Alt</kbd> + left-drag to
orbit, <kbd>Alt</kbd> + middle-drag to pan), set through the store's
`setNavigation`. No control in the UI exposes it yet.

## How the editor behaves, and why

The sections below explain behaviour that is easy to get wrong when changing
the code. Each one says what happens first and why second.

### Camera keys

The camera keys are Blender's numpad layout with <kbd>Shift</kbd> in front:

- **Odd keys jump to a view**: 1 front, 3 right, 7 top. Add <kbd>Ctrl</kbd> for
  the opposite view.
- **Even keys turn the camera a step**: 4 and 6 left and right, 8 and 2 up and
  down. 9 looks from the opposite side and 5 toggles orthographic.

Why it is built this way:

- **Both the number row and the numpad work.** A laptop has no numpad, and a
  hand already on the numpad should not have to reach up to the row.
  <kbd>Shift</kbd> keeps the layout clear of <kbd>1</kbd>, <kbd>2</kbd> and
  <kbd>3</kbd>, which pick the select modes in edit mode.
- **The bindings match the physical key, not the character.** A shifted digit
  arrives as `!` on a US keyboard and as something else on other layouts. A
  numpad digit arrives as `1` or as `End` depending on NumLock. The key code is
  the one thing that stays the same through both.
- **A step is fifteen degrees,** so six presses make an exact quarter turn:
  orbiting up from the front view lands on the top view, not near it. The
  directions name where the camera goes, not which way the scene seems to turn.
  A run of presses stops at straight up. The next press carries on over the
  top, upside down, unless LOCK VERTICAL ORBIT in PREFS is on.
- **The camera turns, it does not snap.** A view arrives over about 0.2
  seconds, easing in and out. A snap only shows where the camera ended up. A
  turn shows how the new view relates to the old one, which matters most
  between mirror-image views such as right and left. Grabbing the camera with
  the mouse mid-turn takes over from wherever it has got to, and a second orbit
  press stacks onto the first instead of being dropped.
- **A view changes the direction only.** The orbit point and the distance stay
  where they were, so a view never moves you nearer or further, and a mouse
  orbit afterwards carries on from where the keyboard left off.

The status bar names the view you pressed. The six coloured ends of the axis
widget in the corner reach the same six views with the mouse, and turn the same
way.

### Extrude, inset and bevel follow the pointer

<kbd>E</kbd>, <kbd>I</kbd> and <kbd>Ctrl</kbd>+<kbd>B</kbd> each take one
distance, and a distance typed in before you have seen the shape is guesswork.
So the key starts a drag instead:

1. Press the key. A dashed guide appears.
2. Move the pointer. The mesh follows live, and the status bar reads out the
   distance.
3. Click or press <kbd>Enter</kbd> to confirm, or <kbd>Esc</kbd> to put the mesh
   back. Holding the button down and dragging works too: releasing confirms.

Each operation reads the pointer differently:

| Key | The distance is | To make it smaller |
| --- | --- | --- |
| `E` | Travel along the region normal. The guide is drawn along it, and only travel along it counts | Pull back. Past the start, the region sinks into the surface |
| `I` | Travel in toward the selection, along the line from where the pointer started. Sweeping past the middle keeps widening the ring | Pull back the way you came. It stops at zero |
| `Ctrl+B` | The length the guide line has gained, measured from the selection out to the pointer, in any direction | Bring the pointer back in. It stops at zero |

Every pointer move re-runs the operation on the mesh as it stood at the
keypress. A wider bevel is the original edges bevelled again, not the last
chamfer bevelled a second time. Confirming without moving changes nothing and
records no undo step, so a stray <kbd>E</kbd> costs nothing. When you already
know the exact figure, type it into the OPERATIONS panel instead.

### Subdivide follows the select mode

<kbd>Ctrl</kbd>+<kbd>D</kbd> does different things depending on the select
mode:

- **Edge select**: splits each selected edge at its midpoint and splices the new
  vertex into the faces on both sides. The LOOP OPERATIONS button relabels
  itself to Subdivide Edge.
- **Vertex or face select**: cuts whole faces up, Catmull-Clark style. The
  Smooth parameter applies here.

### Delete versus dissolve

In edit mode, <kbd>Delete</kbd> opens the delete menu at the pointer, modelled
on Blender's. It offers six entries, a delete and a dissolve for each element
type, and the difference between the two is what they leave behind:

| Entry | Does | Leaves |
| --- | --- | --- |
| Delete vertices, edges or faces | Removes the geometry | A hole |
| Dissolve vertices, edges or faces | Removes the topology | The surrounding surface, intact |

Each entry names the element type it acts on, so the select mode does not
decide it: with one face selected in vertex select, Delete Faces takes that
face and leaves its four corners. An entry with nothing to act on is greyed
out, and its hint says what it is waiting for.

<kbd>X</kbd> skips the menu and deletes straight away, acting on the element
type of the current select mode: vertices in <kbd>1</kbd>, edges in
<kbd>2</kbd>, faces in <kbd>3</kbd>.

Dissolve keeps every remaining vertex where it is and merges the faces around
the removed element into one. That has consequences, so it follows three rules:

- **Faces** merge into a single n-gon, so dissolve needs two or more touching
  faces. A lone face has nothing to merge with, so the menu greys the entry
  out until a second one is selected beside it.
- **Edges** need a face on each side, so an edge on an open border never
  dissolves. They are also skipped when their two faces meet at more than 40°.
  Merging two faces that steep makes a folded face, which shades badly:
  dissolving a cube edge would look broken.
- **Vertices** at a corner follow the same 40° rule across their faces. A
  vertex lying along a path, such as the midpoint left by subdividing an edge,
  merges nothing and always dissolves.

### What the panels offer

Because the delete menu and <kbd>X</kbd> cover delete and dissolve, no panel
has a button for them. The OBJECT panel has Recalculate Normals in that spot
instead, since it is most often wanted right after a merge. Merge lives in the TOPOLOGY panel, welding the
selected vertices at their centre, at the 3D cursor, or onto the first or last
one selected.

Every edit-mode button disables itself when the selection cannot feed it, and
its hint says what to select instead:

| Operation | Needs |
| --- | --- |
| Merge | Two or more vertices |
| Connect | Exactly two vertices |
| Fill | Three edges |
| Bridge | Four edges |
| Bevel, Loop Cut | Edges |
| Inset | Faces |
| Merge by Distance, Triangulate, Tris to Quads | Nothing. They fall back to the whole mesh |

### Object origins

Every object has an origin: the point its vertex coordinates are measured
from. It is the point **Location** names and the plane a Mirror modifier
reflects across. On the Origin pivot it is also where the gizmo sits and what
rotate and scale turn about. The amber square on a selected object marks it,
drawn on top of the geometry because an origin usually sits inside the mesh.
**Overlays → Origins** hides the square without moving anything.

What moves the origin:

| Operation | The origin |
| --- | --- |
| Object-mode move | Moves with the mesh |
| Edit-mode move | Stays put. The geometry moves away from it |
| Origin to geometry | Moves to the middle of the mesh |
| Merge, Separate, the three booleans | Moves to the middle of the result, as Origin to geometry would |
| Duplicate, Linked duplicate, Apply transform, Recalculate normals | Stays put |

**Origin to geometry** is the <kbd>⊙</kbd> button at the foot of the tool rail.
Use it when an edit-mode move has left the origin behind. Nothing moves on
screen, because the vertices give up exactly what the origin gains. It needs a
single-user mesh: linked copies share their vertices, so moving one copy's
origin would drag every other copy off its own.

Merge, Separate and the booleans re-centre because the geometry they hand back
has no relation to the old origin: a merge spans everything that came in, a
separated part is one piece of the whole, and a cut can remove the corner the
origin sat in. The operations that leave it alone have good reason to: a copy
should behave like its source, and the other two do not move the geometry
relative to its origin.

### The 3D cursor

The red and white ring is where new primitives appear and, when you choose, what
transforms turn around. Right-click in the viewport for its menu. Every entry
also has a key, printed beside it (see [the 3D cursor keys](#the-3d-cursor)).

| Entry | Does |
| --- | --- |
| PLACE CURSOR HERE | Drops the cursor on the surface under the pointer, or on its current view plane over empty space |
| CURSOR TO VERTEX / EDGE CENTRE / FACE CENTRE | Snaps it to that element under the pointer |
| CURSOR TO SELECTION | Moves it to the middle of the selected geometry |
| CURSOR TO SELECTION ORIGIN | Moves it to the selection's origin, which differs from the above once an edit-mode move has left the origin behind |
| SELECTION TO CURSOR | Moves the selection to the cursor as one group, landing on the point the gizmo shows. Origins stay where they were |
| ORIGIN OF SELECTED TO CURSOR | Moves the selected objects' origins to the cursor. The geometry stays put |
| CURSOR TO WORLD ORIGIN | Sends it back to 0, 0, 0 |
| HIDE CURSOR / SHOW CURSOR | Hides or shows the ring |

A snap entry the click found nothing for is disabled rather than hidden, and
says why on hover, so the menu keeps the same shape every time.

Two settings read the cursor:

- The **PIVOT** picker in the top bar sets what rotate and scale turn around:
  the object's origin, the median of the selection, or the cursor, in object
  and edit mode alike. The gizmo sits on whichever is in force, and the status
  bar flags any choice other than median.
- The Mirror modifier's **Origin** picks whether its plane passes through the
  object's origin or through the cursor. That is how you mirror a limb about a
  point other than the object's centre.

Hiding the ring, from the menu or **Overlays → 3D cursor**, does not move it or
stop anything from using it.

## Stack

Vite · React 18 · TypeScript (strict) · imperative Three.js · Zustand · Sass.

No Tailwind, no CSS-in-JS, no component library. The brutalist design system is
a small set of Sass mixins over CSS custom properties.

## Licence

Unlicensed prototype.
