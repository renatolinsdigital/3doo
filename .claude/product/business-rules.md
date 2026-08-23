# Business Rules

Rules that come from the business, not from technical constraints. Code enforcing these rules should reference this file in a comment when the "why" isn't obvious from the code alone.

## Format

```markdown
### Rule: <short name>

**Statement:** <what must always be true>
**Applies to:** <which module/entity>
**Enforced in:** <file or service responsible>
**Notes:** <exceptions, edge cases, history>
```

## Example

### Rule: A user cannot delete the last admin of a workspace

**Statement:** every workspace must always have at least one admin.
**Applies to:** `users` module, `workspaces` module.
**Enforced in:** `WorkspaceService.removeAdmin`.
**Notes:** attempting to remove the last admin should return a clear 400 error, not fail silently.
