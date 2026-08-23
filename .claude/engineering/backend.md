# Backend

Standards for the backend application. This is the primary reference when scaffolding, extending, or reviewing backend code. Language conventions live in `typescript.md`; testing philosophy in `testing.md`; performance in `performance.md`.

---

## Main Stack

- **TypeScript** - type-safe JavaScript throughout the codebase.
- **Node.js** - runtime environment.
- **NestJS** - progressive framework with dependency injection; all backend code follows Nest's module/controller/service structure.
- **PostgreSQL** - relational database.
- **Prisma** - type-safe ORM with migrations; the single source of truth for the database schema.

## Tools & Libraries

- **JWT** - token-based authentication.
- **bcryptjs** - password hashing.
- **Zod** - schema validation for request data and environment variables.
- **Winston** - structured logging.
- **Swagger/OpenAPI** - interactive API documentation.
- **Jest** - unit testing framework.
- **ESLint** - code linting.
- **Prettier** - code formatting.
- **Husky** - Git hooks for pre-commit checks.

Do not introduce an alternative to any item on this list (a different ORM, a different validation library, a different logger) without an explicit decision to change the stack. Consistency across services matters more than a marginal preference.

---

## Project Architecture

Follow Nest's module-based structure, organized by domain:

```
/src
  /modules
    /users
      users.module.ts
      users.controller.ts
      users.service.ts
      dto/
      entities/
    /auth
      auth.module.ts
      auth.controller.ts
      auth.service.ts
      strategies/
      guards/
  /common
    /decorators
    /filters
    /guards
    /interceptors
    /pipes
  /config
  /prisma
    schema.prisma
    migrations/
  main.ts
  app.module.ts
/test
```

- Each feature is a self-contained Nest module: controller (HTTP layer), service (business logic), DTOs (request/response shapes), and its own tests.
- Cross-cutting concerns (guards, interceptors, pipes, filters) live in `/common`, not duplicated per module.
- Database access happens through the Prisma client, injected via a `PrismaService`, never instantiated ad hoc inside a business service.

## Absolute imports

Configure `tsconfig.json` path aliases (`@/modules`, `@/common`, `@/config`) so imports don't rely on long relative chains, mirroring the frontend convention in `frontend.md`.

---

## Dependency Injection & Module Boundaries

- Business logic lives in services, never in controllers. Controllers only handle HTTP concerns: parsing input, calling the service, shaping the response.
- A module only imports what it explicitly depends on; avoid importing the whole `AppModule` graph into a feature module.
- Shared logic used by more than one module goes into a dedicated shared module, not copy-pasted.

---

## Data Layer (Prisma + PostgreSQL)

- `schema.prisma` is the single source of truth for the data model. Never modify the database schema by hand outside of a migration.
- Every schema change ships with a generated migration (`prisma migrate dev`), committed alongside the code that depends on it.
- Use Prisma's `select`/`include` deliberately to avoid over-fetching; never fetch a full relation graph "just in case."
- Wrap multi-step writes that must succeed or fail together in a Prisma transaction (`prisma.$transaction`).

---

## Validation

- All incoming request data (body, query params, route params) is validated with a Zod schema before it reaches business logic. Nest DTOs are typed from the Zod schema, not defined independently and kept in sync by hand.
- Environment variables are validated at startup with a Zod schema; the app should fail fast on boot if a required variable is missing or malformed, not fail confusingly later at runtime.

---

## Authentication & Security

- JWT-based authentication. Tokens are short-lived; use a refresh token flow rather than long-lived access tokens.
- Passwords are hashed with bcryptjs before storage; plaintext passwords are never logged or persisted, even transiently.
- Auth guards live in `/common/guards` and are applied at the controller or route level via decorators, not re-implemented per module.
- Never log tokens, passwords, or other credentials, even at debug level.

---

## Logging

- Structured logging via Winston, not `console.log`, in application code.
- Log levels used deliberately: `error` for failures needing attention, `warn` for recoverable issues, `info` for significant business events, `debug` for local troubleshooting only.
- Logs include enough context (request ID, user ID where relevant) to trace an issue without exposing sensitive data.

---

## API Documentation

- Every controller and DTO carries Swagger/OpenAPI decorators so the interactive docs stay accurate automatically.
- Keep decorator descriptions in sync with `docs/api-reference.md`; if they drift apart, the decorators are treated as the source of truth and the doc file gets updated.
- Every endpoint documents its possible response statuses, not only the success case.

---

## Testing

- Unit tests for services, mocking the Prisma client and external dependencies.
- Integration tests for controllers using Nest's testing module (`@nestjs/testing`), exercising the real DI graph with a test database or mocked providers as appropriate.
- Auth-protected endpoints get at least one test confirming access is denied without a valid token.
- See `testing.md` for what deserves a test and what doesn't.

---

## Performance

- Avoid N+1 queries; use Prisma relation loading intentionally (see `performance.md`).
- Add database indexes for columns that are actually filtered, sorted, or joined on in real queries.
- Keep controllers thin so expensive logic is isolated in services where it can be profiled and cached independently.

---

## Code Quality Tooling

- ESLint with strict rules, Prettier for formatting.
- Husky + lint-staged: pre-commit hook runs lint and tests, blocks the commit on failure.
