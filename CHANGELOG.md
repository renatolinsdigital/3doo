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

- AI assistants: an MCP server (`node mcp/server.ts`) lets Claude and other
  assistants build models with the scripting API, look at them from the
  perspective view or any of the Shift+number views, and hand them back as a
  `.3doo`, an OBJ or FBX, PNG pictures, or a link that opens the editor on the
  result. The new AI ASSISTANTS section of the docs says how to set it up.
- MCP button beside `<>` in the top bar: a guide to using 3DOO from an AI
  assistant. It shows how a call travels from the assistant to the scripting
  API, the commands to set the server up with COPY buttons and this site
  already filled in as the place links open, every tool the server offers
  with what it returns, and the settings the server reads.
- Scripts can give parts of one mesh colours of their own: `object.addMaterial`
  adds a material slot, `mesh.assignMaterial` puts the selected faces on it,
  and `object.materials` lists the slots to rename, recolour or remove. A face
  read in a script says which slot it wears.
- `object.bounds` says where an object's shape is drawn in the world,
  modifiers and all, for placing one part against another. `scene.name` reads
  and sets the project name, and `scene.add` and `scene.addMesh` take a
  `color`.
- The SCRIPTING docs list the values every choice takes, such as the modes of
  merge, delete and dissolve and the modifiers' `origin`. The reference an
  assistant reads now opens with what a script can do and how it works, and
  leaves out the notes about the SCRIPT dialog.
- A knife point in a script is checked like every other option: `co` may be
  written `[x, y, z]`, and a point that cannot be read stops the script with
  its place in the list instead of being dropped from the cut.
- Scene links: a `/modeling#scene=...` link opens the editor on the scene it
  carries, in place of the starting cube. The whole scene travels inside the
  link, so nothing is uploaded.
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
  run is one step to undo. LOAD AN EXAMPLE fills the editor with a finished
  model to learn from: a stylised axe, a low poly character, a wizard's
  staff, a wooden bridge, a treasure chest and potion bottles. Each is modelled the way a game asset is: no face has more than
  four sides, and parts meet surface to surface rather than passing through
  one another.
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
- On touch screens the transform gizmo, the vertex dots and the wireframe's
  edges are drawn larger, so they can be seen and aimed at with a finger.
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
- On an iPhone or iPad, panels taller than the screen could not be scrolled.
- A finger swiping up the panels over a field's label scrolls them, rather
  than nudging the value on the way, and a scroll that starts on the edge
  LENGTH label no longer leaves an empty step in the undo history.

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
