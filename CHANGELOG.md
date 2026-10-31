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

- Extrude along normals (`Shift+E`, and a button under EXTRUDE in the
  OPERATIONS panel): each selected face is pushed out along its own normal,
  the region stays joined, and every face ends up the offset away.

### Fixed

- Extruding a region of faces, or insetting one with a depth, left any vertex
  in the middle of the region behind, so the faces sagged down to it.

## [1.0.0] - 2026-10-05

First tracked release. It marks the state of the project at this point,
including the subdivision modifier, loop subdivision and the edit mode
delete menu.

## Before 1.0.0

Releases before 1.0.0 are not listed. Until then 3DOO was built against a
private roadmap that moved back and forth between areas rather than in a
straight line, and its milestones would make little sense read from outside.
This log starts at 1.0.0, the first version meant to be followed in public.
