# Changelog

All notable changes to 3DOO are recorded here. Versions follow
[Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

- **MAJOR**: changes that break saved scenes, workflows or shortcuts users rely on.
- **MINOR**: new features that keep existing behaviour working.
- **PATCH**: bug fixes and small corrections.

New entries go under `Unreleased` until a version is cut. Group them under
`Added`, `Changed`, `Fixed` or `Removed`.

## [Unreleased]

### Added

- Knife tool (K, edit mode): click out a line on the mesh to cut new edges
  through its faces.
- Bend modifier: curls the mesh around X, Y and Z at once, each by up to 360°
  spread along the whole length that curls, so a full turn closes it into a
  ring. It bends the object as drawn, so a cube scaled into a column curls
  along its length, and it only moves the vertices already there: loop cut
  the length you want curved. ORIGIN centres the bend on the object or the 3D
  cursor.
- Twist modifier: turns the mesh about X, Y and Z at once, each by up to four
  full turns, so one end turns the whole angle past the other. Like bend, it
  twists the object as drawn and only moves the vertices already there, and
  ORIGIN picks the line it turns about: the object's or the 3D cursor's.
- Scripting: the `<>` button in the top bar opens a code editor that builds
  and edits the scene with JavaScript: primitives and custom meshes,
  transforms, colours, every modelling operation on a scripted selection,
  modifiers, booleans, folders, the 3D cursor and the view. The editor colours
  the code in the app's palette, suggests names as you type, and shows a
  balloon for every API name with a link to its row in the new SCRIPTING
  section of the docs. RUN (Ctrl+Enter) reports success in a toast and closes
  the dialog; a failure is reported in a toast and under the code, marks the
  failing line, keeps the dialog open and leaves the scene untouched. A whole
  run is one step to undo.
- Touch screens: pinch to zoom about the point between the fingers, slide two
  fingers to pan, and twist them to turn the scene round like a turntable. One
  finger keeps doing what the left mouse button does, and a second finger
  takes over from it.
- Dragging the axis widget in the viewport's corner orbits the view, with a
  finger or a mouse.
- A long press opens the menus a right-click does (the 3D cursor menu, the
  outliner rows, the material slots), and on any other control shows its hint.
  A tap on an unavailable control shows why it is unavailable.
- A quick bar under the viewport on phones, tablets and narrow windows. TOOLS
  and SCENE open the panel columns as drawers. On a touch screen it also has
  undo, redo, ADD (a tap builds on the selection, as Shift+click does), delete,
  and CUT, UNDO POINT and CANCEL while the knife is cutting.

### Changed

- Below 1024px the panel columns are drawers instead of disappearing, and the
  top bar scrolls sideways instead of widening the page.
- On touch screens the controls grow to fingertip size and the smallest text
  comes up a point. The desktop is unchanged.
- On a phone the docs read as one scrolling page, instead of an article boxed
  into a third of the screen under the contents.
- The camera jumps to a view instead of turning to it when the system asks for
  reduced motion.
- The viewport is announced to screen readers as a named region, with a
  description of how to steer it, and the editor area is the page's main
  landmark.

### Fixed

- An active button being hovered drew its light label on a light fill, which
  could not be read. A touch screen keeps the hover after a tap, so there it
  was every active button.
- On a touch screen a tap left the control's hint stuck on screen.
- iOS no longer zooms the page into a field when it is tapped.

- In orthographic view, zoomed in, a click on an object could select the one
  behind it, and the gizmo on that object could not be grabbed.
- The in-app docs said the tool rail switches to vertex, edge and face select
  in edit mode. It holds the same tools in both modes, and the select modes are
  in the SELECT panel.

## [1.0.1] - 2026-10-02

### Relevant Changes

- Redesigned the home page
- Improved the module switcher on the home page reads `3DOO - HOME`

## [1.0.0] - 2026-10-02

First tracked release. It marks the state of the project at this point,
including the subdivision modifier, loop subdivision and the edit mode
delete menu. Earlier history lives in git.
