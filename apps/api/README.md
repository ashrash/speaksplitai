# @speaksplit/api

NestJS + TypeORM + PostgreSQL. The schema lives in hand-written migrations under
`src/database/migrations` (see [docs/schema.md](../../docs/schema.md)); `synchronize` is always off.

```sh
pnpm dev:infra                       # from the repo root: Postgres, Redis, MinIO
pnpm --filter @speaksplit/api dev    # http://localhost:3000/health
pnpm --filter @speaksplit/api build && pnpm --filter @speaksplit/api migration:run
```
