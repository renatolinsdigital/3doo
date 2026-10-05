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
  on. A drag writes one line with where it ended, and a move called off
  leaves nothing. OPEN IN EDITOR hands the log to the script editor.
- `mesh.selectVerts`, `selectEdges` and `selectFaces` also take a list of
  points, `[[x, y, z], ...]`, and pick the elements standing on them.

### Changed

- SCRIPT opens on ACTIONS. The script editor is one click away, under EDITOR,
  and keeps its draft and its undo across the switch.

## [1.0.0] - 2026-10-02

First tracked release. It marks the state of the project at this point,
including the subdivision modifier, loop subdivision and the edit mode
delete menu. Earlier history lives in git.
