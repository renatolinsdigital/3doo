# Features

What the modelling module does, and how its tools behave. For the keys that
drive them, see [keymap.md](keymap.md).

## At a glance

| Area | Included |
| --- | --- |
| Primitives | Cube, plane, circle, grid, UV sphere, ico sphere, cylinder, cone, capsule, torus, with live parameters |
| Object mode | Transform gizmo, duplicate, linked duplicate, merge, separate, union / difference / intersect booleans, apply transform, delete, outliner with rename / visibility / lock and Ctrl+G groups that rename, select, join, ungroup or delete as one |
| Selection | Vertex, edge and face modes; click and Shift+click, box / circle / lasso region select, Alt+click edge and face loops, grow / shrink / invert |
| Modelling | Extrude (region and individual), inset, bevel with segments, loop cut, knife, subdivide (Catmull-Clark), vertex and edge slide, relax, circle, space, merge, merge by distance, connect, delete, dissolve, fill, bridge, triangulate, tris-to-quads |
| Normals | Recalculate outside, flip, shade smooth / flat, mark / clear sharp edges (drawn in cyan, carried through subdivide, loop cut, merge and the modifiers), face-orientation overlay |
| Modifiers | Mirror, array, solidify, bend (around X, Y and Z at once, up to a full ring, moving only the vertices already there), twist (about X, Y and Z at once, up to four full turns), lattice (a cage of points round the mesh, kept as an object of its own and shaped in edit mode, smooth or linear), weld, loop subdivide, subdivision surface (Catmull-Clark or simple, up to 6 levels, edit cage drawn around the result), remesh. All non-destructive, reorderable, with Apply |
| Remesh | A modifier with three methods: voxel quad shell (signed distance field, surface nets, crease and corner constraints), blocks straight off the lattice, and quadric error decimation |
| 3D cursor | Right-click to place it on a point, vertex, edge or face; snap it to the selection or the selection to it; use it as the transform pivot, as a mirror plane or as the centre of a bend or a twist |
| Proportional editing | Six falloff curves, with a viewport ring showing how far the falloff reaches. Scroll to resize it mid-transform, or Ctrl+scroll any time |
| Viewport | Orbit / pan / zoom, solid / wireframe / x-ray / matcap, adaptive grid, normals overlay |
| Touch | Pinch to zoom, two-finger slide to pan, two-finger twist to turn, drag the axis widget to orbit, long press for the right-click menus. Panels become drawers on narrow screens, and a quick bar holds undo, redo, ADD, delete and the knife's CUT / UNDO POINT / CANCEL |
| Files | Save and load `.3doo` projects (JSON, with imported images inside), OBJ and FBX import (binary or ASCII, FBX 7 onwards, landing the right way up and the right size), PNG / JPG / BMP import as a plane at the origin |
| Autosave | Off until turned on. Writes numbered `.3doo` copies into a `3doo-auto-saves` folder you choose, every 30 seconds to 15 minutes, and only when the scene has changed. The browser keeps no copy of the project. Needs a browser with a folder picker (Chrome, Edge) |
| Opening scene | A fresh tab starts on a cube, as Blender does, and so does FILE > NEW. One Ctrl+Z takes it away |
| Preferences | Tooltips, panel visibility, viewport background, grid, snapping, undo depth, autosave and the selection outline, kept in localStorage per browser, with import / export as a `.pref` file |
| Export | OBJ + MTL, **binary FBX 7.4**, with Unity / Unreal / Blender / Maya axis and unit presets; image planes keep their picture |
| Scripting | A JavaScript editor behind the `<>` button: primitives and custom meshes, transforms, colours down to single faces through material slots, every modelling operation on a scripted selection, modifiers, booleans, folders, and world bounds for placing parts. Syntax colours, suggestions, hover help linked to the docs, examples. One undo step per run, and a failed run changes nothing |
| AI assistants | An MCP server that drives the editor in a headless browser: an assistant runs scripts, renders the perspective view and the six Shift+number views, exports `.3doo`, OBJ and FBX, and saves pages that open the editor on the result, at any size. The MCP button beside `<>` explains how it connects and what it returns, with the setup commands ready to copy. See [mcp.md](mcp.md) |
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

### The knife cuts what you draw

<kbd>K</kbd>, or the knife in the tool rail, picks up a tool modelled on
Blender's knife. It cuts new edges into the mesh along a line you click out
point by point, with no selection to make first and no quads required. The
pointer turns into a knife while it is in hand, and a cyan square marks where
the next click will land.

1. Click where the cut starts: on a vertex, on an edge, inside a face, or out in
   empty space beside the mesh, to cut in from its edge.
2. Click wherever the cut should turn. A line follows the pointer from the last
   point, with a dot wherever it will cross an edge.
3. Press <kbd>Enter</kbd> or <kbd>Space</kbd> to make the cut, or
   <kbd>Esc</kbd> to call it off.

| Input | While a cut is open |
| --- | --- |
| Click | Adds a point: on a vertex within 12 pixels, on an edge within 8, and otherwise inside the face under the pointer. Press, drag and release to place two points |
| `Enter` / `Space` | Makes the cut |
| `Backspace` / `Ctrl+Z` | Takes the last point back |
| `E` | Lifts the knife: the next click starts a separate line, and every line is cut together |
| `Shift`, held | Ignores vertices and edges, so a point can go anywhere inside a face |
| `Ctrl`, held | Takes the middle of the edge under the pointer |
| `Esc` / right-click | Calls the cut off |
| A click outside the viewport | Makes the cut, then does its own job |

How it behaves, and why:

- **Nothing changes until the cut is made.** Each line is worked out as it is
  drawn and held by the viewport; the operator then makes the whole cut in one
  run, so it is one undo step, and <kbd>Esc</kbd> leaves no step behind.
- **The line is the one drawn on screen.** Each line cuts the mesh along the
  plane holding the two clicks' lines of sight, so it lands exactly under the
  line in a perspective view too. A vertex within a pixel of the line is cut
  through rather than cut beside, which would leave two slivers.
- **It cuts what you can see.** Every face is sliced on its own, and in solid
  shading a slice the camera cannot see is dropped. Wireframe and x-ray cut
  through, the way they select through, so one line across a box goes all the
  way round it. Orbiting partway through a cut does not move the part already
  drawn: each line keeps the view it was drawn in.
- **A face divides from edge to edge.** A cut that stops inside a face divides
  nothing, and its edges are left loose on top of the face, as Blender leaves
  them: a face is one ring of corners, with no room for a slit. Where two lines
  of one cut cross inside a face, the face divides along both.
- **It is a tool, not a one-off.** The knife stays in hand after a cut, the way
  the move tool does, until another tool is picked or edit mode is left.

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

### Phones, tablets and touch

The editor runs on a phone or a tablet with nothing but fingers. The layout
follows the screen's width and the input follows the pointer, so the two are
decided separately:

- **Width.** Below 1024px the two panel columns are drawers, opened from the
  quick bar under the viewport. A tablet starts with the scene drawer out,
  which is how the layout looked before the drawers existed; a phone starts
  with both away and keeps only one out at a time. The top bar becomes one row
  that scrolls sideways rather than pushing the page wider than the screen.
- **Pointer.** On a coarse pointer every control grows to a fingertip's size
  (44px for the default target) and the quick bar gains the keys a hand
  without a keyboard cannot press. The viewport follows suit: the gizmo, the
  vertex dots and the wireframe are drawn larger, since a desktop's few pixels
  all but vanish on a phone's dense screen. A laptop with a touch screen keeps the
  desktop layout, since its main pointer is the mouse, but its screen still
  takes every gesture below.

On the canvas, one finger is the left mouse button: a tap selects, a drag draws
a region or carries a gizmo handle, the knife lays its points. Two fingers are
the camera. That split is why a second finger cancels whatever the first one
started, a region drag or a knife point: people rarely land two fingers at
exactly the same moment, and the first one down would otherwise leave a
selection or a cut behind every time they reached for the view. A gizmo handle
already in hand is the exception, because swinging the camera round under an
object halfway through moving it is worse than ignoring the second finger.

A twist turns the scene round the vertical, like a turntable, rather than
rolling the view: the camera has no roll, and a turntable is what the keyboard
and the mouse orbit around too. Turning over the top needs the other axis, and
that is what dragging the axis widget does, the same way a navigation gizmo
works in desktop packages. The twist is held back until the hand has turned
about ten degrees, since no pinch or slide keeps the line between two fingers
perfectly still, and a view that wobbled on every zoom would be worse than one
that could not turn at all.

A long press stands in for the right button. Android sends a `contextmenu`
event for one and iOS sends nothing, so `useLongPressMenu` raises the event
itself on anything marked `data-context-menu`, and swallows Android's when it
follows, so a menu never opens twice. The click the finger makes on release
is swallowed too. On a control without a menu, the same long press shows the
control's hint, since a touch screen has no hover to show it with.

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
- The Bend modifier's **Origin** does the same for the centre of the bend: the
  mesh at that point stays where it is. Put the cursor at the foot of a column
  and the foot stays planted while the top curls over.
- The Twist modifier's **Origin** sets the line the twist turns about and the
  level that holds still. With the cursor at the foot of a column, the foot
  stays square to the floor and the top turns the whole angle.

Hiding the ring, from the menu or **Overlays → 3D cursor**, does not move it or
stop anything from using it.
