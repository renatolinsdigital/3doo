# Pull Requests

## Size

- Keep PRs reviewable in one sitting. If a change is sprawling, split it into sequential PRs where possible.

## Description

Every PR includes:

- What changed and why.
- How it was tested.
- Any follow-up work intentionally left out of scope.
- Screenshots or a short clip for anything visual (frontend changes).

## Checklist before requesting review

- Lint and tests pass locally.
- No leftover debug logging, commented-out code, or unused files.
- New environment variables or migrations are called out explicitly in the description.
- Relevant docs under `.claude/` or `/docs` updated if the change introduces or alters a convention.

## Merging

- Squash merge into `main` by default, keeping a single clean commit per PR unless the team has agreed otherwise.
