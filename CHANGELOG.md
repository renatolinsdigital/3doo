# Changelog

All notable changes to 3DOO are recorded here. Versions follow
[Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

- **MAJOR**: changes that break saved scenes, workflows or shortcuts users rely on.
- **MINOR**: new features that keep existing behaviour working.
- **PATCH**: bug fixes and small corrections.

New entries go under `Unreleased` until a version is cut. Group them under
`Added`, `Changed`, `Fixed` or `Removed`.

## [Unreleased]

### Changed

- The MCP server's `share_link` saves a page in the app's style, with YOUR
  MODEL IS READY, the model's counts and size, an OPEN IN 3DOO button and a
  DOWNLOAD .3DOO button. The page carries the model itself and hands it to the
  editor's tab, so a model of any size opens. The editor's tab takes the scene
  on `/modeling#receive`.

### Fixed

- Shared models too big for a link now open. A link had to carry the whole
  scene in its address, which browsers refuse past about two million
  characters, and the tool's result repeated that link, which could run past
  what an assistant accepts from a tool.

## [1.0.0] - 2026-10-05

First tracked release. It marks the state of the project at this point,
including the subdivision modifier, loop subdivision and the edit mode
delete menu. Earlier history lives in git.
