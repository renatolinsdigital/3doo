# Code Review

## What reviewers check

- Correctness: does the change do what it claims, including edge cases.
- Conventions: does it follow `frontend.md` / `backend.md` / `coding-standards.md` / `typescript.md`.
- Tests: are the right things tested, per `testing.md`, not just "a test exists."
- Security: any new endpoint, form, or data access reviewed for auth and validation gaps.

## Giving feedback

- Distinguish blocking issues from suggestions. Prefix optional feedback ("nit:", "optional:") so authors know what's required vs preference.
- Explain the reasoning behind a requested change, not just the change itself.

## Receiving feedback

- Respond to every comment, even if just to confirm it's addressed. Don't leave threads unresolved silently.
- Disagreements get discussed in the PR thread; if unresolved, escalate to a quick sync rather than a back-and-forth comment war.

## Approval

- At least one approval required before merge. Author does not merge their own PR without another set of eyes, except for trivial, low-risk changes agreed in advance.
