# @speaksplit/api

NestJS + TypeORM + PostgreSQL 16. The schema lives in hand-written migrations under
`src/database/migrations`; TypeORM `synchronize` is always off and entities mirror the migrations.

```sh
pnpm dev:infra                       # from the repo root: Postgres, Redis, MinIO
pnpm db:migrate                      # from the repo root: build + apply migrations
pnpm --filter @speaksplit/api dev    # http://localhost:3000/health
```

| Script                                            | What it does                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `migration:run` / `migration:revert`              | Apply / roll back migrations (runs the built JS; build first)                            |
| `migration:create src/database/migrations/<Name>` | New empty migration                                                                      |
| `test`                                            | Unit tests                                                                               |
| `test:int`                                        | Schema integration tests; needs `TEST_DATABASE_URL` for a role that can create databases |

The integration tests create a throwaway database, run the migrations, and check that Postgres
itself enforces the money invariants (payers and splits sum to the total, no cross-group rows,
one owner per group, append-only audit log, and so on).

Always write an expense together with its payers and splits in one transaction: the totals check
is a deferred constraint trigger that runs at `COMMIT` and fails with SQLSTATE `23514`.
