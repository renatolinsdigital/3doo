---
paths:
  - "src/api/**/*.ts"
  - "src/api/**/*.js"
---

# API Conventions

Only loads when Claude reads a file matching the globs above — delete this
file (or edit the paths) once you know your real project's layout.

- All endpoints return a consistent JSON error shape: `{ "error": { "code", "message" } }`.
- Validate input at the boundary before touching business logic.
- Document new endpoints in `docs/api.md` as part of the same change.
