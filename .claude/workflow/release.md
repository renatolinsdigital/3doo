# Release Process

## Versioning

- Semantic versioning (`MAJOR.MINOR.PATCH`). Breaking changes bump major, new backward-compatible features bump minor, fixes bump patch.

## Before cutting a release

- All targeted PRs merged into `main` and passing CI.
- `CHANGELOG.md` updated with user-facing changes, grouped by added / changed / fixed.
- Database migrations (backend) reviewed for safety on the production dataset before deploy, not just correctness locally.

## Deploy

- Deploys go through CI/CD, not manual pushes to production infrastructure.
- Backend migrations run as a distinct step before the new application version starts serving traffic.

## After release

- Verify health checks and key flows in production.
- Tag the release in git, matching the version bumped.
