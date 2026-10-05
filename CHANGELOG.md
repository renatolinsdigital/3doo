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

- ACTIONS tab in SCRIPT: what you do in the viewport, written as the script
  that would do it. Objects added, moved, selected, renamed, joined, cut or
  deleted, their materials and modifiers, the 3D cursor and the shading are
  all logged, and so is every edit mode operation with the selection it ran
  on. A drag writes one line with where it ended, a move called off leaves
  nothing, and an undo takes its lines back off the log. COPY puts the log on
  the clipboard as a script that clears the scene and builds it again when
  run in EDITOR, and warns when the log holds something no script repeats.
  OPEN IN EDITOR hands the same script to the script editor.
- `mesh.selectVerts`, `selectEdges` and `selectFaces` also take a list of
  points, `[[x, y, z], ...]`, and pick the elements standing on them.
- `mesh.translate`, `rotate` and `scale` take `proportional` (the falloff
  radius) and `falloff`, and `rotate` and `scale` take a `pivot`. `rotate`
  turns about any direction, `axis: [x, y, z]`, as well as `"x"`, `"y"` and
  `"z"`.
- ACTIONS writes every edit mode move, turn and scale as the one call that
  repeats it, proportional editing, a turn about the view and a pivot on the
  cursor or the origin included, where these used to be comments saying there
  was no script equivalent.

### Changed

- SCRIPT opens on ACTIONS. The script editor is one click away, under EDITOR,
  and keeps its draft and its undo across the switch.
- An edit mode move, turn or scale applies its whole amount from where the
  vertices began on every pointer move. Rolling the wheel to resize the
  proportional falloff mid-drag now spreads the whole move again, rather than
  only what comes after, and pinning another axis mid-turn starts the turn
  over about it, as it already did in object mode.

### Fixed

- ACTIONS no longer takes a selection clicked after a move for the one the
  move left, which wrote the next move without selecting first and replayed
  it on the wrong vertices.

## [1.0.0] - 2026-10-02

First tracked release. It marks the state of the project at this point,
including the subdivision modifier, loop subdivision and the edit mode
delete menu. Earlier history lives in git.
