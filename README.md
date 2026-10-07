# SpeakSplit Pay

A Splitwise-style expense-splitting app built for India. Add an expense by typing a sentence,
speaking it, or photographing the bill; split it any way you like, to the paisa; and settle up
through a prefilled UPI payment link.

> Personal / learning project for use within a group of friends. SpeakSplit Pay never holds or
> moves money: payments happen in the user's own UPI app.

## Features

Priority: **MVP** = first release, **Next** = soon after, **Later** = backlog.

### Adding expenses

| Feature                                                                                      | Priority |
| -------------------------------------------------------------------------------------------- | -------- |
| Manual entry: amount, description, date, payer, participants, split type                     | MVP      |
| **Text-to-split**: "Rahul paid 800 for cab, split with Priya and me" becomes a draft expense | MVP      |
| Review before save: AI drafts are always editable and never saved silently                   | MVP      |
| Edit and delete with a full history of who changed what                                      | MVP      |
| **Voice-to-split** in English, Hindi and Hinglish                                            | Next     |
| **Receipt photo**: line items, tax, tip and total extracted into a draft                     | Next     |
| Photo + instructions: "Mike had the steak, rest split equally"                               | Next     |
| Itemised splits: assign line items to people; tax and tip shared proportionally              | Next     |
| Receipt attachments                                                                          | Next     |
| Recurring expenses (rent, subscriptions, utilities) and auto-suggested categories            | Later    |

### Split types

| Feature                                                                         | Priority |
| ------------------------------------------------------------------------------- | -------- |
| Equal, exact amounts, percentages, shares                                       | MVP      |
| Payer who isn't a participant (paid on someone's behalf)                        | MVP      |
| Deterministic handling of leftover paise (₹100 among 3 = 33.34 / 33.33 / 33.33) | MVP      |
| Adjustment splits (equal ± fixed amounts) and multiple payers                   | Next     |
| Usage-weighted splits (electricity by AC hours, rent by room size)              | Later    |

### Groups and people

| Feature                                                                                 | Priority |
| --------------------------------------------------------------------------------------- | -------- |
| Groups (trip, flat, couple, friends, event) with their own balances; archive and delete | MVP      |
| Friend-to-friend expenses outside any group                                             | MVP      |
| Invites by WhatsApp link, phone number or email                                         | MVP      |
| Add and remove members (blocked while they have a non-zero balance)                     | MVP      |
| Roles (owner, admin, member), leaving a group                                           | Next     |
| Placeholder members: add someone by name, and they claim it when they sign up           | Next     |
| Block and unblock users                                                                 | Next     |

### Balances and history

| Feature                                                              | Priority |
| -------------------------------------------------------------------- | -------- |
| Who owes whom, per group and overall, with what you owe and are owed | MVP      |
| Simplify debts to the fewest transfers (toggle per group)            | MVP      |
| Expense detail with split breakdown, receipt and edit history        | MVP      |
| Search, filters and sorting; per-group activity feed                 | Next     |
| CSV / PDF export and monthly insights                                | Later    |

### Settling up

| Feature                                                                             | Priority |
| ----------------------------------------------------------------------------------- | -------- |
| Pay via a prefilled `upi://pay` link that opens GPay, PhonePe, Paytm or any UPI app | MVP      |
| Record a payment (full or partial, UPI or cash)                                     | MVP      |
| Payee confirms or disputes a recorded payment                                       | Next     |
| Copy UPI ID and QR code fallbacks; "settle all" suggestions                         | Next     |
| Reminders by push and a prefilled WhatsApp message                                  | Next     |
| Attach a payment screenshot and extract the UPI reference                           | Later    |

### Accounts, notifications and sharing

| Feature                                                          | Priority |
| ---------------------------------------------------------------- | -------- |
| Sign in with email OTP or Google (Auth0)                         | MVP      |
| Profile: name, avatar, one or more UPI IDs, language             | MVP      |
| Single sign-on between the app and the web pay page              | Next     |
| Web pay page: "you owe ₹X to Y" with a pay button, no app needed | Next     |
| Sign out everywhere; delete account and data                     | Next     |
| Push notifications; share a balance card to WhatsApp             | Next     |
| Per-group notification settings; comments on expenses            | Later    |

## How it's built

| Area            | Choice                                                                                 |
| --------------- | -------------------------------------------------------------------------------------- |
| Mobile app      | Expo + React Native, TypeScript                                                        |
| Web pay page    | Vite + React                                                                           |
| API             | NestJS + TypeORM on PostgreSQL 16                                                      |
| Background jobs | BullMQ on Redis                                                                        |
| File storage    | Any S3-compatible store (MinIO locally)                                                |
| Identity        | Auth0, OIDC Authorization Code + PKCE                                                  |
| AI parsing      | Pluggable provider behind one `parseExpense()` interface; cloud first, on-device later |
| Infrastructure  | Docker Compose for dev; Helm on k3s or EKS; OpenTofu/Terraform; Argo CD                |

Principles:

- **Money is integer paise**, never floating point. The same split engine runs on the phone,
  the web page and the server.
- **The database guards the money.** Payers and splits must each add up to the expense total,
  rows can't cross groups, and the audit log can't be edited. Postgres enforces all of this,
  not just the application.
- **Privacy:** names are replaced with placeholders before text goes to a cloud AI model.
  Receipts are kept briefly unless attached to an expense. Bank details and UPI PINs are never
  stored.
- **Portable:** only standard interfaces (Postgres, Redis, S3 API, OIDC, OpenTelemetry), so it
  runs on a laptop, a small VM or any cloud.

## Data model

All amounts are integer paise. Balances are computed from expenses and settlements, never
stored as editable numbers.

| Table                                       | Holds                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `users`, `user_upi_ids`                     | Accounts (linked to Auth0) and their UPI IDs (one primary)                                                                            |
| `groups`, `group_members`                   | Groups and their members. A member may be a placeholder with no account yet. Friend-to-friend expenses live in hidden `direct` groups |
| `expenses`                                  | Description, total, date, split type, source (manual, text, voice, image)                                                             |
| `expense_payers`, `expense_splits`          | Who paid and who owes how much, per member                                                                                            |
| `expense_items`, `expense_item_assignments` | Receipt line items and who shares each one                                                                                            |
| `settlements`                               | Payments between members: UPI or cash; pending, confirmed, disputed or cancelled                                                      |
| `recurring_expenses`                        | Schedules that generate expenses                                                                                                      |
| `invites`, `blocks`                         | Invite links (hashed tokens) and user blocks                                                                                          |
| `attachments`, `comments`                   | Receipts and payment proofs (in S3); comments on expenses                                                                             |
| `push_tokens`                               | Device tokens for notifications                                                                                                       |
| `audit_log`                                 | Append-only history, also the activity feed                                                                                           |
| `idempotency_keys`                          | Makes create-expense and record-payment safe to retry                                                                                 |
| `member_balances`, `user_balances` (views)  | Net balance per member and per user                                                                                                   |

Other guarantees: expenses and comments are soft-deleted, members leave rather than being
deleted, and optimistic locking (`version` columns) stops two people silently overwriting the
same expense.

### Data lifecycle

| Event                      | What happens                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| Account deletion           | The user is anonymised, not deleted, so other people's balances and history stay correct |
| Leaving a group            | The member is marked as left; their past expenses remain                                 |
| Claiming a placeholder     | The placeholder is linked to the new account and keeps its history                       |
| Deleting a group           | Allowed when balances are zero; removes everything in it                                 |
| Parse-only receipt uploads | Deleted automatically after expiry                                                       |
| Idempotency keys           | Expire after 24 hours                                                                    |

## Repository layout

```
apps/
  api/            NestJS + TypeORM REST API, database migrations
  worker/         BullMQ jobs (reminders, push, AI, cleanup)
  pay-web/        Vite + React web pay page
  mobile/         Expo app (not generated yet)
packages/
  split-engine/   shared, dependency-free split and balance logic
  api-types/      zod schemas shared by the API and clients
services/
  go-service/     optional Go service
deploy/           docker-compose, Helm, Argo CD, Terraform
```

## Getting started

Requires Node 22.13+, pnpm 10 (`corepack enable`) and Docker.

```sh
pnpm install
cp .env.example .env
pnpm dev:infra                          # Postgres 16, Redis, MinIO
pnpm db:migrate                         # build + apply database migrations
pnpm --filter @speaksplit/api dev       # http://localhost:3000/health
pnpm --filter @speaksplit/pay-web dev   # http://localhost:5173
```

Checks (same as CI):

```sh
pnpm format:check && pnpm lint && pnpm build && pnpm typecheck && pnpm test
pnpm test:int                           # database integration tests; needs TEST_DATABASE_URL
```

## Roadmap

1. ~~Monorepo scaffolding~~
2. ~~Database schema and migrations~~
3. Split engine and its tests
4. API: Auth0 JWT validation, group-scoped access, expenses, balances
5. Mobile app: login, groups, manual expenses, balances, UPI settle
6. Invites, roles, block/unblock
7. Web pay page and single sign-on
8. AI text parsing, then voice
9. Receipt photos and itemised splits
10. Search, filters, activity feed, push reminders
11. Kubernetes (Helm, k3s), then Terraform + Argo CD + EKS
12. On-device AI
