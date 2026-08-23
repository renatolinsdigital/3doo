# Architecture

Shared architectural principles that apply across the codebase. Stack-specific structure lives in `frontend.md` and `backend.md`.

## Principles

- **Clean separation of concerns.** Business logic, data access, and presentation never mix in the same file.
- **Domain-oriented organization.** Group code by what it does for the business (domain), not just by technical type, wherever the framework allows it.
- **No relative import chains.** Use path aliases everywhere; `../../../../` is never acceptable in a PR.
- **Explicit over implicit.** Avoid magic. A new contributor should be able to trace a request or a data flow without guessing.
- **Dependencies point inward.** Framework and infrastructure code depends on domain code, never the other way around.

## Where to look next

- Frontend folder structure and component organization: `frontend.md`
- Backend module structure, NestJS conventions, and data layer: `backend.md`
- Language-level conventions shared by both: `typescript.md`
- Test organization and expectations: `testing.md`
