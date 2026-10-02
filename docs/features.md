# Features

What the modelling module does, and how its tools behave. For the keys that
drive them, see [keymap.md](keymap.md).

## At a glance

| Area | Included |
| --- | --- |
| Primitives | Cube, plane, circle, grid, UV sphere, ico sphere, cylinder, cone, capsule, torus, with live parameters |
| Object mode | Transform gizmo, duplicate, linked duplicate, merge, separate, union / difference / intersect booleans, apply transform, delete, outliner with rename / visibility / lock and Ctrl+G groups that rename, select, join, ungroup or delete as one |
| Selection | Vertex, edge and face modes; click and Shift+click, box / circle / lasso region select, Alt+click edge and face loops, grow / shrink / invert |
| Modelling | Extrude (region and individual), inset, bevel with segments, loop cut, subdivide (Catmull-Clark), vertex and edge slide, relax, circle, space, merge, merge by distance, connect, delete, dissolve, fill, bridge, triangulate, tris-to-quads |
| Normals | Recalculate outside, flip, shade smooth / flat, mark / clear sharp edges (drawn in cyan, carried through subdivide, loop cut, merge and the modifiers), face-orientation overlay |
| Modifiers | Mirror, array, solidify, weld, loop subdivide, subdivision surface (Catmull-Clark or simple, up to 6 levels, edit cage drawn around the result), remesh. All non-destructive, reorderable, with Apply |
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

## How the editor behaves, and why

The sections below explain behaviour that is easy to get wrong when changing
the code. Each one says what happens first and why second.

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

When the 40° rule would skip the whole selection, as with a cube corner, the
entry is greyed out rather than offering a click that changes nothing. So is
Dissolve Faces when the selected faces close off a solid, such as every face
of a cube, since there is no outline left to merge them into.

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
also has a key, printed beside it (see [the 3D cursor keys](keymap.md#the-3d-cursor)).

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
