# API Design Best Practices

Practical guidance for designing, building, testing, securing, documenting, and operating HTTP APIs.

An API is a contract between independent systems. A good contract is understandable without guesswork, explicit about failure, difficult to misuse, and stable enough to evolve. REST is a useful style for many HTTP APIs, but these practices also apply to APIs that expose actions, workflows, or asynchronous jobs.

## Contents

- [1. Start with the contract](#1-start-with-the-contract)
- [2. Design resources and URLs](#2-design-resources-and-urls)
- [3. Use HTTP semantics correctly](#3-use-http-semantics-correctly)
- [4. Model requests and responses](#4-model-requests-and-responses)
- [5. Return useful errors](#5-return-useful-errors)
- [6. Secure every boundary](#6-secure-every-boundary)
- [7. Design for reliability and scale](#7-design-for-reliability-and-scale)
- [8. Keep the implementation maintainable](#8-keep-the-implementation-maintainable)
- [9. Test the contract and the system](#9-test-the-contract-and-the-system)
- [10. Document and evolve the API](#10-document-and-evolve-the-api)
- [11. Operate the API](#11-operate-the-api)
- [12. Delivery checklist](#12-delivery-checklist)
- [References](#references)

## 1. Start with the contract

Before writing routes or database code, define:

1. Who calls the API and what trust level each caller has.
2. The resources, workflows, and business invariants it exposes.
3. The request and response schemas, including nullable, optional, read-only, and write-only fields.
4. Success, failure, timeout, retry, and asynchronous behavior.
5. Security, privacy, performance, availability, and compliance requirements.
6. Compatibility rules and how changes will be reviewed.

Treat the API description as a real artifact. An [OpenAPI](https://spec.openapis.org/oas/latest.html) document can drive documentation, client generation, mock servers, contract tests, and validation. Keep it in version control and validate it in CI.

Prefer a contract-first workflow for public or multi-team APIs. Implementation-first is reasonable for a small internal API, but publish the generated contract and review the resulting behavior before consumers depend on it.

## 2. Design resources and URLs

### Resource identifiers

- A **URI** identifies a resource. A **URL** is a URI that also describes how to locate it. A **URN** identifies a resource by name without locating it.
- In an HTTP API, an endpoint is best understood as the combination of an HTTP method and a target URI, such as `GET /v1/users/123`.
- Use `https` in every non-local environment. Never put passwords, access tokens, API keys, or other sensitive data in URLs; URLs are commonly logged, cached, bookmarked, and sent in referrers.

### Naming rules

Use stable, meaningful, lowercase paths. Prefer plural nouns for collections and hyphens between words:

```text
GET    /v1/users
GET    /v1/users/123
POST   /v1/users
PATCH  /v1/users/123
DELETE /v1/users/123
```

Avoid action-shaped paths such as `GET /getUser?id=123` or `POST /deleteUser/123`. The HTTP method already communicates the common operation. Use an action subresource when the operation is a domain command that does not map cleanly to CRUD:

```text
POST /v1/payments/123/capture
POST /v1/reports/456/cancel
```

Do not add file extensions such as `.json` to resource paths. Use `Content-Type` and `Accept` for representation formats. URI paths are case-sensitive beyond the scheme and host, so choose one casing convention and keep it consistent. Percent-encode path values with a standard URI library rather than concatenating untrusted strings.

### Path, query, and body values

- **Path parameters** identify the resource: `/users/{userId}`. They are required and should be bounded and validated.
- **Query parameters** modify a collection or representation: `/users?status=active&limit=25`. Use them for filtering, sorting, pagination, field selection, and search criteria.
- **Request content** carries larger or sensitive input for operations that accept a body. Do not use a GET body as a private convention; its semantics are not interoperable.

### Flat versus nested resources

Use nesting when the relationship is essential and the scope is unambiguous:

```text
GET /v1/authors/5/books
```

Use a flat collection with a filter when several relationships or search criteria are possible:

```text
GET /v1/books?authorId=5&genre=history
```

Avoid deep nesting. A practical rule is one meaningful parent level, then a flat resource or query filter. Whichever style you choose, apply it consistently and enforce authorization at every referenced object.

## 3. Use HTTP semantics correctly

HTTP semantics are defined by [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110), not by a framework's route naming.

| Method | Use it for | Safe | Idempotent |
| --- | --- | --- | --- |
| `GET` | Retrieve a representation | Yes | Yes |
| `HEAD` | Retrieve headers as for `GET`, without content | Yes | Yes |
| `POST` | Create under a collection or perform resource-specific processing | No | No by default |
| `PUT` | Create or replace the state at a known URI | No | Yes |
| `PATCH` | Apply a partial modification | No | Depends on the defined operation |
| `DELETE` | Remove or deactivate the target resource | No | Yes |
| `OPTIONS` | Describe communication options, often for CORS | Yes | Yes |

Idempotent does not mean that every response is identical. It means that repeating the same intended request has the same intended effect. Make retryable `POST` operations idempotent with an `Idempotency-Key` and a server-side record of the key, request fingerprint, result, and expiry. Reject reuse of a key with a different request.

Use `PUT` only when the client owns the target URI and sends a complete replacement, unless your contract explicitly defines another behavior. Use `PATCH` for partial changes and define its patch format, null behavior, replacement rules, and array behavior.

## 4. Model requests and responses

### Validation and data handling

- Validate syntax, types, size, ranges, formats, enums, and cross-field rules at the boundary.
- Validate again in the domain layer where the invariant matters. Client validation is not a security control.
- Reject unknown fields by default for sensitive commands, or document and test how they are handled.
- Use separate input and output models. Never bind request fields directly to persistence entities; this prevents mass assignment and accidental data exposure.
- Mark generated identifiers, timestamps, ownership fields, and audit fields as server-controlled.
- Serialize dates as ISO 8601 / RFC 3339 strings with an explicit timezone, normally UTC. Be precise about decimal money, rounding, numeric limits, and null versus missing.
- Use `Content-Type` to declare the request representation and `Accept` to declare an acceptable response representation. Return `415 Unsupported Media Type` when the request format is unsupported.

### Consistent success responses

Use one response shape per resource type. Do not wrap some responses in `data` while leaving others unwrapped unless that is a deliberate, documented convention. Include links or a documented pagination object when clients need navigation.

Useful status codes include:

| Code | Meaning and typical use |
| --- | --- |
| `200 OK` | Successful retrieval or update with content |
| `201 Created` | New resource created; include `Location` when there is a canonical URI |
| `202 Accepted` | Work accepted for asynchronous processing; provide status information |
| `204 No Content` | Successful operation with no response content |
| `304 Not Modified` | Conditional retrieval found an unchanged representation |
| `400 Bad Request` | Malformed request or invalid syntax |
| `401 Unauthorized` | Missing or invalid authentication; include `WWW-Authenticate` when applicable |
| `403 Forbidden` | Caller is authenticated but not allowed, or the resource must be hidden |
| `404 Not Found` | Resource does not exist or should not be disclosed |
| `405 Method Not Allowed` | Method is known but not supported; include `Allow` |
| `409 Conflict` | Request conflicts with current resource state |
| `412 Precondition Failed` | An `If-Match` or other request precondition failed |
| `413 Content Too Large` | Request exceeds a configured size limit |
| `422 Unprocessable Content` | Syntax is valid but domain validation failed |
| `429 Too Many Requests` | A quota or rate limit was exceeded |
| `500 Internal Server Error` | Unexpected server failure |
| `502` / `503` / `504` | Upstream failure, temporary unavailability, or gateway timeout |

Do not return `200 OK` for every outcome. Do not use `401` for authorization failures: `401` means the server cannot authenticate the caller; `403` means the authenticated caller is not allowed.

### Headers worth designing

At minimum, return the correct `Content-Type` and a request or correlation identifier. For production APIs, also consider `Cache-Control`, `Vary`, `ETag`, `Last-Modified`, `Location`, `Retry-After`, `Allow`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, and an appropriate `Referrer-Policy`.

Use `If-Match` with a strong `ETag` for updates where lost writes matter. Return `412` when the representation changed since the client read it.

## 5. Return useful errors

Use a single documented error format. [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) defines `application/problem+json` for machine-readable HTTP problems:

```json
{
  "type": "https://api.example.com/problems/validation-error",
  "title": "The request is invalid.",
  "status": 422,
  "detail": "One or more fields failed validation.",
  "instance": "https://api.example.com/problems/occurrences/8f4c",
  "errors": [
    { "pointer": "/email", "code": "invalid_format" }
  ]
}
```

Keep the HTTP status and problem `status` consistent. Make `type` stable and preferably resolvable to documentation. Clients should branch on `type` or a documented machine code, not parse `detail`. Give validation failures field pointers and stable codes. Give support a safe occurrence identifier, but never expose stack traces, SQL, file paths, secrets, or internal topology. Log the internal cause separately from the response shown to the client.

## 6. Secure every boundary

Use defense in depth. The right mechanism depends on the caller, sensitivity, and threat model:

- **Internal service or workload:** workload identity, short-lived credentials, least-privilege authorization, and often mTLS.
- **Partner integration:** OAuth 2.0 client credentials with narrow scopes, or mTLS / signed requests where strong workload identity is required. Rotate credentials and audit each partner separately.
- **User-facing API:** an identity provider with OAuth 2.0 / OpenID Connect. Use authorization code with PKCE for browser and native clients. The current OAuth security BCP, [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700), deprecates the implicit and password grants.
- **Simple server-to-server integration:** an API key can identify a client, but it is not user authentication. Scope, rotate, rate-limit, and never place keys in query strings.

For all schemes:

1. Enforce TLS and verify certificates. Protect internal hops when the network is not fully trusted.
2. Authenticate before authorization, then authorize the specific action on the specific object and fields.
3. Apply least privilege, tenant isolation, audience checks, expiry, revocation strategy, and key rotation.
4. Do not trust user-controlled IDs, roles, forwarded headers, origins, filenames, or callback URLs.
5. Validate and constrain outbound URLs to prevent SSRF. Use allowlists, block private and link-local ranges, and re-check redirects.
6. Protect secrets in a secrets manager, not source code, images, logs, or `.env` files committed to a repository. Commit only `.env.example`.
7. Set request size, nesting, parsing, upload, timeout, and response limits. Validate dependencies and scan images and source regularly.
8. Apply CSRF protection to cookie-authenticated browser requests and configure CORS with explicit trusted origins. CORS is not authentication.

Use the [OWASP API Security Top 10 (2023)](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) as a review checklist. Pay particular attention to broken object-level authorization, broken function-level authorization, excessive data exposure or mass assignment, unrestricted resource consumption, SSRF, inventory management, and unsafe consumption of third-party APIs.

## 7. Design for reliability and scale

### Pagination, filtering, search, and sorting

- Always bound page size and set a safe default. Reject unreasonable values rather than silently doing expensive work.
- Offset pagination (`page` and `pageSize`) is simple but becomes unstable or slow while data changes. Cursor pagination is usually better for large or frequently changing collections.
- Use stable, unique sort keys. Document filter syntax, null ordering, case sensitivity, allowed fields, and maximum query complexity.
- Index the fields used by common filters and sorts. Avoid turning arbitrary client input into SQL, search DSL, or code.
- For large exports or expensive searches, create an asynchronous job and let the client poll or receive a webhook.

Example: `GET /v1/authors?name=John&sort=-createdAt&limit=25&cursor=eyJpZCI6...`

### Caching and concurrency

Cache only data that is safe to cache. Set explicit freshness and vary rules; never allow a shared cache to mix tenants or users. Use conditional requests with `ETag` or `Last-Modified` to reduce transfer costs. Caches improve performance but do not replace authorization checks.

### Timeouts, retries, and backpressure

- Set a deadline for every inbound request and outbound dependency call.
- Retry only transient failures, with exponential backoff and jitter, a maximum attempt count, and a total deadline.
- Do not automatically retry non-idempotent operations without an idempotency design.
- Use circuit breakers, bounded queues, connection limits, bulkheads, and load shedding to protect dependencies.
- Propagate cancellation and avoid holding database connections while waiting on unrelated network work.

### Rate limiting and concurrency limiting

Rate limiting protects availability, fairness, and cost. Describe limits by identity and scope: API key, user, tenant, IP, route, and sometimes operation cost. Return `429` with a useful `Retry-After` value and document the policy. A rate limit is not a complete DoS defense; combine it with gateway controls, WAF rules, quotas, and autoscaling.

![Six rate-limiting algorithms](consider/flow.png)

| Algorithm | Strength | Cost or trade-off |
| --- | --- | --- |
| Fixed window counter | Simple and cheap | Bursts at window boundaries |
| Sliding window log | Accurate per request | Stores many timestamps |
| Sliding window counter | Good accuracy with less memory | Approximation at boundaries |
| Token bucket | Allows controlled bursts and a sustained rate | Needs shared, atomic state in a cluster |
| Leaky bucket | Smooth, predictable output | May queue or drop bursts; less burst-friendly |
| Concurrency limiter | Caps work running at one time | Does not limit total requests over time |

Choose based on the resource being protected. A token bucket is a common general-purpose choice; a concurrency limit is essential when a slow downstream service is the bottleneck. Production systems often combine a request-rate limit, a concurrency limit, and an operation or cost quota at different layers. Make distributed counters atomic and fail closed or fail open according to the risk of the operation.

## 8. Keep the implementation maintainable

Organize code around ownership and behavior rather than forcing every project into one folder layout. A small service might use:

```text
api/
  routes/          # HTTP method and path mapping
  controllers/     # Translate HTTP to application calls
  schemas/         # Request, response, and problem schemas
application/       # Use cases and transaction boundaries
domain/            # Business rules and domain models
infrastructure/    # Database, queues, HTTP clients, configuration
middleware/        # Auth, validation, rate limits, request context
tests/
  unit/
  integration/
  contract/
docs/
  openapi.yaml
scripts/            # Migrations, seeds, and operational tasks
```

Keep controllers thin. Put business rules in application or domain services, persistence rules in repositories or data-access modules, and external integrations behind clients or providers. Do not let HTTP DTOs, ORM models, and domain objects become the same object by accident.

Use database constraints for uniqueness, foreign keys, and integrity in addition to application validation. Group related writes in transactions, keep transactions short, and define what happens when a downstream call succeeds but the database commit fails. For events, consider an outbox or equivalent durable handoff.

Configuration should be explicit, validated at startup, and supplied through the environment or a secret manager. Containerization can improve reproducibility, but Docker files do not replace health checks, migrations, backups, deployment strategy, or runtime security.

## 9. Test the contract and the system

Testing should be layered. The five core categories are:

1. **Functional testing:** one request, one expected behavior, including validation and status codes.
2. **Integration testing:** the API with its database, queue, cache, or external service boundary.
3. **Regression testing:** rerun the existing behavior suite after changes and schema migrations.
4. **Load and performance testing:** expected traffic, bursts, large payloads, slow dependencies, and saturation behavior.
5. **Security testing:** authentication, authorization, tenant isolation, injection, SSRF, abuse cases, secrets, and dependency or configuration weaknesses.

Also include schema and OpenAPI validation in CI, consumer-driven contract tests for cross-team integrations, negative tests for malformed and boundary inputs, retry and idempotency tests that simulate timeouts after commits, and tests for `ETag` / `If-Match`, `429`, `Retry-After`, asynchronous `202` workflows, and partial failures. Add smoke tests and synthetic monitoring for critical journeys.

Tests should verify observable behavior, not framework internals. Use production-like data shapes without using real personal or secret data.

## 10. Document and evolve the API

Every operation should document its purpose, authentication, parameters, request schema, response schema, examples, status codes, problem types, pagination, limits, and retry expectations. Provide copyable examples in at least one common client, such as curl, and an interactive viewer only when it is protected and safe to use.

The current published [OpenAPI Specification is 3.2.0](https://spec.openapis.org/oas/latest.html). Use the version supported by your toolchain, and keep the description complete enough that generated clients and tests do not need hidden assumptions. Review external references and Markdown in API descriptions before feeding them to tooling.

### Compatibility and versioning

Prefer additive, backward-compatible changes: add optional response fields, use tolerant readers, and avoid renaming or changing the type, meaning, enum behavior, requiredness, defaults, ordering, pagination, authorization, or precision of existing fields. Deprecate before removal, publish a sunset date and migration path, and measure remaining consumers.

There is no universal need to put a version in a URL. `/v1` is easy to understand and route, while media-type or header versioning can keep resource URLs stable but increases tooling and caching complexity. Choose one strategy, document it, and avoid mixing schemes without a strong reason. Maintain an inventory of hosts, routes, versions, debug endpoints, and webhooks so retired surfaces do not remain exposed.

## 11. Operate the API

### Logs, metrics, and traces

Emit structured logs with a timestamp, level, service, environment, route template, method, status, duration, request ID, trace ID, and safe outcome metadata. Use standard levels such as `debug`, `info`, `warn`, and `error`; keep debug logging off by default in production.

Never log authorization headers, tokens, passwords, payment data, or unnecessary personal data. Redact before serialization, not only in a log viewer. Centralize logs, apply retention and access policies, and alert on symptoms rather than only individual exceptions.

Measure request rate, error rate, latency percentiles, saturation, dependency health, queue depth, database pool usage, cache behavior, rate-limit rejections, and authentication failures. Distributed tracing with propagated context helps connect an API request to downstream work. Define service-level objectives and page on user-impacting symptoms such as sustained error-budget burn or high tail latency.

### Health and failure behavior

- A liveness check should answer whether the process can run.
- A readiness check should answer whether it should receive traffic.
- Keep health endpoints cheap and do not expose dependency details publicly.
- Use graceful shutdown, connection draining, bounded startup, and safe migration procedures.
- Back up data, test restoration, and define recovery objectives.
- Prepare incident runbooks for credential compromise, dependency outage, data corruption, and traffic spikes.

## 12. Delivery checklist

- [ ] The contract names resources and workflows clearly and has concrete examples.
- [ ] Paths are lowercase, stable, encoded correctly, and free of secrets and file extensions.
- [ ] Methods, idempotency, caching, status codes, and headers follow HTTP semantics.
- [ ] Inputs are validated and mapped to separate domain and persistence models.
- [ ] Success and error responses are consistent; problems use stable machine-readable types.
- [ ] Authentication, object-level authorization, tenant isolation, and field-level access are tested.
- [ ] TLS, CORS, CSRF, SSRF, request limits, dependency updates, and secret handling are addressed.
- [ ] Pagination, sorting, timeouts, retries, idempotency, backpressure, and rate limits have explicit policies.
- [ ] Database constraints and transactions protect integrity and failure recovery is understood.
- [ ] OpenAPI and schemas are linted and checked for breaking changes in CI.
- [ ] Functional, integration, regression, load, and security tests cover the highest-risk paths.
- [ ] Logs, metrics, traces, alerts, health checks, retention, and runbooks are ready before production.
- [ ] Deprecated versions, routes, hosts, documentation, and credentials have an owner and removal date.

## References

- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700)
- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)
- [OWASP API Security Top 10 (2023)](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)
- [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)