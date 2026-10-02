# Versioning

Loaded on every session (no `paths` frontmatter = unconditional, same
priority as CLAUDE.md).

3DOO uses `MAJOR.MINOR.PATCH`. The current version lives in `package.json`
(and the root entries of `package-lock.json`); `CHANGELOG.md` records what
each version contains.

- **Always ask before bumping the version.** Never change the version in
  `package.json`, `package-lock.json` or `CHANGELOG.md` on your own, even
  when a change clearly deserves one. Propose the bump (major, minor or
  patch) with a one-line reason and wait for a yes.
- **MAJOR**: breaks saved scenes, workflows or shortcuts users rely on.
- **MINOR**: adds a feature and keeps existing behaviour working.
- **PATCH**: fixes a bug or makes a small correction.
- Record user-facing changes under `## [Unreleased]` in `CHANGELOG.md`,
  grouped as `Added`, `Changed`, `Fixed` or `Removed`. Adding entries there
  needs no permission; only moving them under a new version number does.
- When a bump is approved, update `package.json`, both root `version`
  fields in `package-lock.json`, and move the `Unreleased` entries under a
  new `## [x.y.z] - YYYY-MM-DD` heading.
