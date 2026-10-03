# Keymap

Every key and mouse binding in the modelling module, and the reasoning behind
the camera keys.

The keymap follows Blender's defaults, because that is the muscle memory users
arrive with. Every binding lives in one table,
[keymap.ts](../src/domain/keymap/keymap.ts). The in-app overlay
(<kbd>Shift</kbd> + <kbd>?</kbd>) and the Docs module both build their lists
from it, so they cannot drift. The tables below are a copy: update them when a
binding changes.

A binding marked *edit* works in edit mode only, and one marked *object* in
object mode only. The rest work in both.

## Modes and selection

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

## Transform

| Key | Action |
| --- | --- |
| `G` | Pick the move tool. The gizmo handles do the dragging |
| `R` / `S` | Rotate / scale, following the pointer from the keypress |
| `X` / `Y` / `Z` | During a rotate or scale: lock it to that axis. Press again to unlock |
| `Shift+G` | Slide vertices along their edges, or edges across their faces (*edit*) |

## Modelling

| Key | Action |
| --- | --- |
| `E` | Extrude: drag the distance along the region normal (*edit*) |
| `I` | Inset: drag the thickness in toward the selection (*edit*) |
| `Ctrl+B` | Bevel: drag the width out from the selection (*edit*) |
| `Ctrl+R` | Loop cut (*edit*) |
| `K` | Knife: click points on the mesh to cut new edges through its faces (*edit*). Its own keys are under [During a knife cut](#during-a-knife-cut) |
| `Ctrl+D` | Subdivide: split selected edges at their midpoint, or cut up faces (*edit*) |
| `M` | Merge by distance (*edit*) |
| `F` | Fill a boundary loop with a face (*edit*) |
| `J` | Connect two vertices with an edge, splitting the face (*edit*) |
| `Alt+B` | Bridge two open edge loops with a band of quads (*edit*) |
| `Alt+T` | Triangulate every face (*edit*) |
| `Alt+J` | Merge adjacent, near-coplanar triangle pairs back into quads (*edit*) |
| `Shift+N` | Recalculate normals, pointing them outward |

## Objects and history

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

## The 3D cursor

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

## View

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

## During a knife cut

From the knife's first click until the cut is made, the knife holds the
keyboard the way a modal transform does, and the ordinary bindings wait.

| Key | Action |
| --- | --- |
| `Enter` / `Space` | Make the cut |
| `Backspace` / `Ctrl+Z` | Take the last point back |
| `E` | Lift the knife: the next click starts a separate line |
| `Shift`, held | Ignore vertices and edges, and place the point freely inside the face |
| `Ctrl`, held | Snap to the middle of the edge under the pointer |
| `Esc` | Call the cut off |

## Files and help

| Key | Action |
| --- | --- |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / save as a new file |
| `Ctrl+O` | Open a project |
| `Ctrl+E` | Export |
| `Shift+?` | The shortcut overlay |

## Mouse

| Input | Action |
| --- | --- |
| Middle-drag | Orbit |
| <kbd>Shift</kbd> + middle-drag | Pan |
| Wheel | Zoom |
| <kbd>Alt</kbd> + click | Select the edge loop (edge select) or face loop (face select) under the pointer |
| Right-click | The 3D cursor menu. During a knife cut it calls the cut off instead |
| <kbd>Ctrl</kbd> + wheel | Resize the proportional-editing falloff. Plain wheel does the same mid-transform |

The camera controller also has a Maya preset (<kbd>Alt</kbd> + left-drag to
orbit, <kbd>Alt</kbd> + middle-drag to pan), set through the store's
`setNavigation`. No control in the UI exposes it yet.

## Camera keys

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
