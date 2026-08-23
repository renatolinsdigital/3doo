# Coding Standards

General standards that apply regardless of language or layer. Framework-specific rules live in `frontend.md`, `backend.md`, `typescript.md`, `react.md`, `angular.md`, `vue.md`, and `svelte.md`.

## Naming

- Variables and functions: `camelCase`.
- Classes, types, interfaces, React components: `PascalCase`.
- Constants that are truly fixed (config, enums): `UPPER_SNAKE_CASE`.
- Files match what they export: `UserCard.tsx` exports `UserCard`, `user.service.ts` exports `UserService`.

## Functions

- One responsibility per function. If you need "and" to describe what it does, split it.
- Prefer early returns over deep nesting.
- Keep function signatures short; if you're passing more than three parameters, use an options object.

## Comments

- Comment the "why," never the "what." Code should already say what it does.
- Delete commented-out code before committing. Git history is the archive, not the file.

## Dead code and unused dependencies

- No unused imports, variables, or exports left in a PR.
- Don't add a dependency for something a few lines of code can do.

## Error handling

- Never swallow errors silently. Log or rethrow with context.
- Fail loud in development, fail gracefully (with user-facing messaging) in production.
