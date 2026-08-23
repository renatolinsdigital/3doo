# API Reference Conventions

How endpoints should be documented in this repository, whether by hand or generated from Swagger/OpenAPI (see `engineering/backend.md`).

## Required sections per endpoint

````markdown
### POST /users

Creates a new user.

**Auth:** required (Bearer JWT)

**Request body**
| Field | Type | Required | Notes |
|---|---|---|---|
| email | string | yes | must be unique |
| password | string | yes | min 8 characters |

**Responses**
| Status | Meaning |
|---|---|
| 201 | User created |
| 400 | Validation error |
| 409 | Email already in use |

**Example**
​`bash
curl -X POST /users -d '{"email": "a@b.com", "password": "secret123"}'
​`
````

## Rules

- Every endpoint documents auth requirements explicitly, even when "none."
- Every error status returned by the endpoint must be listed, not just the happy path.
- Request/response examples must match the actual Zod schema (see `backend.md`), not an idealized version.
- If the endpoint is generated from decorators (NestJS + Swagger), keep the decorator descriptions in sync with this file rather than letting them drift apart.
