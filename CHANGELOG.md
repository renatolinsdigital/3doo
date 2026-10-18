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

- `npm run aie2e`: three AI agents, a modeller, an art director and a
  technical artist, build a stylized, game-ready, medium poly axe in 3DOO
  through the MCP tools and judge it stage by stage, while the runner drives
  the editor's main functions by hand, exports and reads back the result, and
  writes a report on the asset and on what the software got in the way of.
  It runs on the user's own Claude login. See
  [docs/how_aie2e_agents_work.md](docs/how_aie2e_agents_work.md).
- The `inspect_mesh` MCP tool: each mesh's triangles, quads, n-gons and poles
  as exported, and every hole, flipped face, stacked vertex, loose element,
  sliver and twisted quad, listed in words.

### Fixed

- Pictures from the MCP server's `render_views` showed no edges at all in
  `solidWire` or `wireframe` shading.

## [1.0.0] - 2026-10-05

First tracked release. It marks the state of the project at this point,
including the subdivision modifier, loop subdivision and the edit mode
delete menu.

## Before 1.0.0

Releases before 1.0.0 are not listed. Until then 3DOO was built against a
private roadmap that moved back and forth between areas rather than in a
straight line, and its milestones would make little sense read from outside.
This log starts at 1.0.0, the first version meant to be followed in public.
