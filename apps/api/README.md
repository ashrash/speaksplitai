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

**Verified email.** Friend requests by email are matched against `users.email`, which the API
keeps equal to the token's email when Auth0 marks it verified (and no other active account has
it). Auth0 access tokens don't carry email by default: add a post-login Action that sets
`email` and `email_verified` on the access token, under `AUTH0_CLAIM_NAMESPACE` (for example
`https://speaksplit.app/email`). Phone numbers are never verified yet, so phone requests wait.

**Group access.** Group routes use `@GroupAccess('read' | 'member' | 'write' | 'manage')` on the `:groupId` parameter:

| Caller                    | read | write                                         | manage (archive, unarchive, delete)                                                   |
| ------------------------- | ---- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Current member            | yes  | yes (409 `archived` if the group is archived) | owner only (either person in a friend-to-friend group); also works on archived groups |
| Former member (`left_at`) | yes  | 403                                           | 403                                                                                   |
| Anyone else               | 404  | 404                                           | 404                                                                                   |

A fourth level, `member`, is any current member even in an archived group (used for leaving).
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

| Method | Path                                 | Access           | Notes                                                                                                                                   |
| ------ | ------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                            | public           | liveness                                                                                                                                |
| GET    | `/health/ready`                      | public           | checks the database                                                                                                                     |
| GET    | `/me`                                | signed in        | profile and UPI IDs; creates the user on first call                                                                                     |
| PATCH  | `/me`                                | signed in        | name, avatar (https), language, default currency                                                                                        |
| GET    | `/me/upi-ids`                        | signed in        | primary first                                                                                                                           |
| POST   | `/me/upi-ids`                        | signed in        | first one is primary; duplicates (any case) 409; at most 10                                                                             |
| PATCH  | `/me/upi-ids/:id`                    | own UPI IDs only | label; `isPrimary: true` moves primary                                                                                                  |
| DELETE | `/me/upi-ids/:id`                    | own UPI IDs only | removing the primary promotes the oldest remaining                                                                                      |
| POST   | `/groups`                            | signed in        | idempotent; caller becomes owner                                                                                                        |
| GET    | `/groups`                            | signed in        | groups you currently belong to; `?status=archived` for archived ones                                                                    |
| GET    | `/groups/:groupId`                   | group read       | group and members                                                                                                                       |
| PATCH  | `/groups/:groupId`                   | group write      | rename, currency, simplify; needs `version`                                                                                             |
| POST   | `/groups/:groupId/archive`           | group manage     | read-only and hidden from `GET /groups`                                                                                                 |
| POST   | `/groups/:groupId/unarchive`         | group manage     |                                                                                                                                         |
| DELETE | `/groups/:groupId`                   | group manage     | only when every balance is zero (409 `unsettled` lists currencies)                                                                      |
| POST   | `/groups/:groupId/invites`           | group write      | `{ maxUses?, expiresInHours?, placeholderMemberId? }`; returns the token once (and `url` if `PUBLIC_APP_URL` is set); at most 20 active |
| GET    | `/groups/:groupId/invites`           | group write      | active invites, without tokens                                                                                                          |
| DELETE | `/groups/:groupId/invites/:inviteId` | group write      | revoke                                                                                                                                  |
| GET    | `/invites/:token`                    | signed in        | preview: group, who invited, placeholder name; 404 unknown, 410 expired / revoked / used up                                             |
| POST   | `/invites/:token/accept`             | signed in        | join, rejoin or claim a placeholder; repeat-safe; 403 if either blocked the other                                                       |
| POST   | `/groups/:groupId/members`           | group write      | `{ name }`: placeholder member                                                                                                          |
| DELETE | `/groups/:groupId/members/:memberId` | group manage     | only when their balance is zero; not the owner; they keep read access                                                                   |
| POST   | `/groups/:groupId/leave`             | group member     | only when your balance is zero; owners can't leave                                                                                      |
| GET    | `/friends`                           | signed in        | friends, group-mates and friend-to-friend partners, with flags and the direct group id                                                  |
| DELETE | `/friends/:userId`                   | signed in        | ends an explicit friendship only                                                                                                        |
| POST   | `/friends/requests`                  | signed in        | `{ userId }`, `{ email }` or `{ phone }`; 202 `sent` (always, for email/phone), 200 `accepted` / `already_friends`; 20 a day            |
| GET    | `/friends/requests`                  | signed in        | `{ incoming, outgoing }`; unmatched addresses are masked                                                                                |
| POST   | `/friends/requests/:id/accept`       | recipient        |                                                                                                                                         |
| POST   | `/friends/requests/:id/decline`      | recipient        | quiet: the sender just stops seeing it as pending                                                                                       |
| DELETE | `/friends/requests/:id`              | sender           | cancel                                                                                                                                  |
| POST   | `/friends/invites`                   | signed in        | personal "add me" link; token returned once; at most 10 active                                                                          |
| GET    | `/friends/invites`                   | signed in        | your active friend links                                                                                                                |
| DELETE | `/friends/invites/:inviteId`         | creator          | revoke                                                                                                                                  |
| POST   | `/direct`                            | signed in        | `{ userId }`: the friend-to-friend group with someone you share a group with; created once per pair; 403 if either blocked the other    |
| GET    | `/direct`                            | signed in        | your friend-to-friend groups                                                                                                            |

Request and response shapes are the zod schemas in `@speaksplit/api-types`.
