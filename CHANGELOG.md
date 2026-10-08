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

- `scene.addMesh` takes `edges`, `smooth`, `faceMaterials` and `sharp`, so a
  script can build edges with no face, smooth shading, the material slot each
  face wears and sharp edges. It may also be given no faces at all.

### Changed

- The SCRIPT dialog's ACTIONS tab is now SCENE: the scene as it stands, written
  as the script that builds it on a new project, instead of a log of what was
  done. Adding a cube and deleting it again leaves it empty. It is read only,
  with CLOSE and COPY. Images and lattices have no script form yet, so they are
  noted in comments and COPY says a run leaves them out.
- `scene.addMesh` keeps every point it is given, including ones no face uses,
  so `mesh.verts[i]` is always `verts[i]`.
- A script too long to colour, such as a dense mesh written out point by
  point, is drawn as plain text so the editor stays responsive.

### Removed

- The ACTIONS log, with its CLEAR and OPEN IN EDITOR buttons.

## [1.0.0] - 2026-10-05

First tracked release. It marks the state of the project at this point,
including the subdivision modifier, loop subdivision and the edit mode
delete menu. Earlier history lives in git.
