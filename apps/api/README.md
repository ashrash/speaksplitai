# @speaksplit/api

NestJS + TypeORM + PostgreSQL 16. The schema lives in hand-written migrations under
`src/database/migrations`; TypeORM `synchronize` is always off and the entities in
`src/database/entities` mirror the migrations (a test checks they agree).

```sh
pnpm dev:infra                       # from the repo root: Postgres, Redis, MinIO
pnpm db:migrate                      # from the repo root: build + apply migrations
pnpm --filter @speaksplit/api dev    # http://localhost:3000/health
```

| Script                                            | What it does                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `migration:run` / `migration:revert`              | Apply / roll back migrations (runs the built JS; build first)                                   |
| `migration:create src/database/migrations/<Name>` | New empty migration; add it to `src/database/migrations/index.ts`                               |
| `test`                                            | Unit tests                                                                                      |
| `test:int`                                        | Schema and end-to-end API tests; needs `TEST_DATABASE_URL` for a role that can create databases |

## API conventions

**Authentication.** Every route except `/health` needs `Authorization: Bearer <Auth0 access token>`.
The token's RS256 signature is checked against the tenant's JWKS, along with `iss`
(`AUTH0_ISSUER_URL`), `aud` (`AUTH0_AUDIENCE`) and `exp`. The user row is created on the first
authenticated request, with a display name from the token; email and phone are only set through
the profile, so an unverified email can't collide with another account.

**Group access.** Group routes use `@GroupAccess('read' | 'write')` on the `:groupId` parameter:

| Caller                    | read | write                                         |
| ------------------------- | ---- | --------------------------------------------- |
| Current member            | yes  | yes (409 `archived` if the group is archived) |
| Former member (`left_at`) | yes  | 403                                           |
| Anyone else               | 404  | 404                                           |

Non-members get 404 rather than 403, so group ids can't be probed. Every member can read every
expense in a group; lists default to the ones the caller paid for or is part of.

**Errors.** Every error has the same shape:

```json
{ "error": { "status": 409, "code": "stale_version", "message": "…", "requestId": "…" } }
```

Database constraint failures are mapped by SQLSTATE: `23514` (check) and `23503` (foreign key)
to 422, `23505` (unique) and `23001` (restricted delete) to 409, serialization failures to 409
`retry`. Constraint names go to the log, not the client. Anything unexpected is a plain 500.

**Retries.** Create endpoints decorated with `@Idempotent()` require an `Idempotency-Key` header
(8–128 of `A-Z a-z 0-9 - _`; a UUID made when the user taps Save is ideal). Keys are per user
and last 24 hours:

| Same key, and…                 | Result                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| same request, finished         | original status and body, header `Idempotent-Replayed: true` |
| same request, still running    | 409 `request_in_progress`                                    |
| different method, path or body | 422 `idempotency_key_reused`                                 |
| the first attempt failed       | the key was released; the retry runs normally                |

If the process dies after the handler commits but before the key is marked complete, retries
with that key get 409 until it expires; the client should then refresh rather than resend.

**Concurrent edits.** Updates take the `version` the client last saw; if someone changed the row
first the API returns 409 `stale_version` and nothing is overwritten.

**Request ids and logs.** Logs are JSON (pretty in development) with one line per request.
Each response carries `X-Request-Id`, which is reused from the request if it is well formed.
Authorization headers, cookies and idempotency keys are redacted.

## Endpoints so far

| Method | Path               | Access           | Notes                                                       |
| ------ | ------------------ | ---------------- | ----------------------------------------------------------- |
| GET    | `/health`          | public           | liveness                                                    |
| GET    | `/health/ready`    | public           | checks the database                                         |
| GET    | `/me`              | signed in        | profile and UPI IDs; creates the user on first call         |
| PATCH  | `/me`              | signed in        | name, avatar (https), language, default currency            |
| GET    | `/me/upi-ids`      | signed in        | primary first                                               |
| POST   | `/me/upi-ids`      | signed in        | first one is primary; duplicates (any case) 409; at most 10 |
| PATCH  | `/me/upi-ids/:id`  | own UPI IDs only | label; `isPrimary: true` moves primary                      |
| DELETE | `/me/upi-ids/:id`  | own UPI IDs only | removing the primary promotes the oldest remaining          |
| POST   | `/groups`          | signed in        | idempotent; caller becomes owner                            |
| GET    | `/groups`          | signed in        | groups you currently belong to                              |
| GET    | `/groups/:groupId` | group read       | group and members                                           |
| PATCH  | `/groups/:groupId` | group write      | rename, currency, simplify; needs `version`                 |

Request and response shapes are the zod schemas in `@speaksplit/api-types`.
