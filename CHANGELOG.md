# Changelog

All notable changes to 3DOO are recorded here. Versions follow
[Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

- **MAJOR**: changes that break saved scenes, workflows or shortcuts users rely on.
- **MINOR**: new features that keep existing behaviour working.
- **PATCH**: bug fixes and small corrections.

New entries go under `Unreleased` until a version is cut. Group them under
`Added`, `Changed`, `Fixed` or `Removed`.

## [Unreleased]

### Fixed

- Fill (F) no longer fills only half a hole. When the selected edges split
  into more than one run, for instance where a diagonal crosses the hole,
  each run now fills whole instead of only the part after the edge it
  started from.
- Fill (F) gives each empty region a face of its own. Where loose edges such
  as knife lines cross a hole, every part they divide it into fills, where
  before the edges were strung into rings that crossed the hole and left
  gaps. Selecting everything no longer caps the outline of an open sheet.
- Fill (F) sees holes past a face folded flat back over the mesh, such as
  the outline cap an earlier fill could leave, and replaces that face where
  it was hiding a hole. It used to report no holes to fill.
- Fill (F) with faces selected fills only the holes those faces go all the
  way round, instead of laying stray triangles across holes and along the
  outline.

## [1.0.0] - 2026-10-05

First tracked release. It marks the state of the project at this point,
including the subdivision modifier, loop subdivision and the edit mode
delete menu. Earlier history lives in git.
