# Git Workflow

## Branching

- `main` is always deployable. Nothing broken merges into it.
- Branch off the latest `main` before starting work; rebase onto `main` regularly to stay current rather than merging it in.
- Name branches by intent, using kebab-case descriptions:
  - Features: `feature/short-description`
  - Fixes: `fix/short-description`
  - Chores/tooling: `chore/short-description`
  - Refactors: `refactor/short-description`
- Keep branches short-lived and scoped to a single piece of work. Open a PR as soon as the branch is ready for feedback rather than letting it grow.

## Commits

- Prefer small, focused commits over one giant commit at the end; each commit should represent one coherent change.
- Use Conventional Commits for messages: `feat: add user login`, `fix: correct token expiry check`, `chore: bump dependency`, plus `refactor:`, `test:`, `docs:`, `perf:`, `ci:` as appropriate.
- Write commit messages that explain _why_ a change was made when that isn't obvious from the diff alone. The diff already shows _what_ changed.
- Don't commit commented-out code, debug logging, or unrelated formatting changes alongside functional changes.

## Pull requests

- Keep PRs small and reviewable; split unrelated changes into separate PRs.
- PR descriptions should cover the motivation and the approach, plus a test plan for how the change was verified.
- Link related issues or tickets where applicable.
- Address review feedback with new commits during review; save squashing for just before merge.

## Before pushing

- Run lint and tests locally. The pre-commit hook covers this, but don't rely on it as the only check. CI is the final gate, not the first one.
- Rebase on the latest `main` and resolve any conflicts before requesting review.
- Squash noisy "wip" or "fixup" commits into meaningful ones before opening a PR, unless the team has explicitly agreed to preserve full history.
- Never force-push to `main`, and avoid force-pushing shared branches without warning collaborators first.
