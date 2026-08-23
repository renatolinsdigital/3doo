# Performance

Shared performance principles. Frontend specifics (bundle splitting, lazy routes) live in `frontend.md`. Backend specifics (query optimization, indexing) live in `backend.md`.

## General principles

- Measure before optimizing. Don't guess at bottlenecks.
- Optimize the common path, not the rare edge case, unless the edge case is catastrophic.
- Prefer removing work over speeding up work. The fastest code is code that doesn't run.

## Frontend

- Lazy-load routes and heavy components.
- Avoid unnecessary re-renders (see `react.md` for memoization guidance).
- Keep bundle size in check; avoid pulling in a heavy library for something a small utility can do.

## Backend

- Avoid N+1 queries; use Prisma's relation loading (`include`/`select`) deliberately.
- Index columns that are actually queried or filtered on, not every column defensively.
- Keep request handlers thin; expensive work belongs in a service, ideally measurable and cacheable independently.

## Definition of done for a performance fix

A performance change is not complete until it's been measured before and after, and the improvement is documented in the PR description.
