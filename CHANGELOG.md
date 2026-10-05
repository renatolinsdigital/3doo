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

- The MCP `scripting_reference` tool now returns a short quickstart by default
  (about 1,500 tokens instead of about 13,000): the conventions, a script that
  runs, every name the API has and the rules a table does not say. The full API,
  the finished examples or one example are asked for with `topic` and `example`.
  An assistant starts building sooner and spends far fewer tokens reading.
- The MCP server's instructions now lay out the workflow in four steps and tell
  the assistant to check once and hand the result over.
- `share_link` says when a link points at localhost, which opens only while 3DOO
  is being served there.
- The MCP dialog and the AI ASSISTANTS docs say which commands to run and when,
  and that the assistant starts the server itself.

## [1.0.0] - 2026-10-05

First tracked release. It marks the state of the project at this point,
including the subdivision modifier, loop subdivision and the edit mode
delete menu. Earlier history lives in git.
