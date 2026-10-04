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
  ring. SEGMENTS slices flat faces and straight edges into strips first so
  they curve, and ORIGIN centres the bend on the object or the 3D cursor.
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

### Fixed

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
