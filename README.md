# SpeakSplit Pay

A Splitwise-style expense-splitting app for India: natural-language, voice and receipt-photo entry,
UPI settlement, Auth0 SSO, and a cloud-agnostic backend.

- [Product & technical plan](docs/plan.md)
- [Data model & PostgreSQL schema](docs/schema.md)

## Layout

```
apps/
  api/            NestJS + TypeORM REST API
  worker/         BullMQ jobs (reminders, push, AI, cleanup)
  pay-web/        Vite + React web pay page
  mobile/         Expo app (generated in build step 4)
packages/
  split-engine/   shared, dependency-free split and balance logic
  api-types/      zod schemas shared by the API and clients
services/
  go-service/     optional Go service
deploy/           docker-compose, Helm, Argo CD, Terraform
docs/
```

## Getting started

Requires Node 22.13+, pnpm 10 (`corepack enable`) and Docker.

```sh
pnpm install
cp .env.example .env
pnpm dev:infra                          # Postgres 16, Redis, MinIO
pnpm build                              # shared packages must be built before the apps use them
pnpm --filter @speaksplit/api dev       # http://localhost:3000/health
pnpm --filter @speaksplit/pay-web dev   # http://localhost:5173
```

Checks (same as CI): `pnpm format:check && pnpm lint && pnpm build && pnpm typecheck && pnpm test`.
