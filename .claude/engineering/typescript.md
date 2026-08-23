# TypeScript Conventions

Applies to both frontend and backend code.

## Strictness

- `strict: true` in every `tsconfig.json`. Never disable it to make an error go away.
- No `any`. Use `unknown` and narrow it, or define a proper type.
- No non-null assertions (`!`) unless the surrounding code makes null-safety provably impossible to violate, with a comment explaining why.

## Types vs interfaces

- `interface` for object shapes that might be extended (component props, entities).
- `type` for unions, intersections, and utility compositions.

## Imports

- Use path aliases (`@/shared`, `@/domain`, `@/pages` on the frontend; module-relative aliases on the backend per `backend.md`).
- Group imports: external packages first, then internal aliases, then relative imports, separated by a blank line.

## Validation at boundaries

- Anything crossing a boundary (API request body, environment variables, form input) gets validated with Zod, not just typed and trusted. See `backend.md` for the schema conventions used there.

## Generics

- Use generics to remove duplication, not to look sophisticated. If a generic type only ever has one concrete usage, it doesn't need to be generic.
