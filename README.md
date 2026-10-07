# SpeakSplit Pay

A Splitwise-style expense-splitting app built for India. Add an expense by typing a sentence,
speaking it, or photographing the bill; split it any way you like, exact to the smallest unit
of the currency; and settle up through a prefilled UPI payment link. Trips abroad work too:
expenses can be in any supported currency.

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

| Feature                                                                               | Priority |
| ------------------------------------------------------------------------------------- | -------- |
| Equal, exact amounts, percentages, shares                                             | MVP      |
| Payer who isn't a participant (paid on someone's behalf)                              | MVP      |
| Deterministic handling of leftover minor units (₹100 among 3 = 33.34 / 33.33 / 33.33) | MVP      |
| Adjustment splits (equal ± fixed amounts) and multiple payers                         | Next     |
| Usage-weighted splits (electricity by AC hours, rent by room size)                    | Later    |

### Currencies

| Feature                                                                                        | Priority |
| ---------------------------------------------------------------------------------------------- | -------- |
| Expenses in any supported currency (INR default; USD, EUR, AED, THB, JPY, KWD and more)        | MVP      |
| Balances kept separately per currency, never silently converted                                | MVP      |
| Group and personal default currency                                                            | MVP      |
| Settle a foreign-currency debt in rupees over UPI, recording the rupee amount actually sent    | MVP      |
| Converted "about ₹X in total" view and suggested settlement amounts from stored exchange rates | Next     |
| Daily exchange-rate updates by the worker                                                      | Next     |

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
| Record a payment (UPI or cash); it counts straight away and clears the full amount  | MVP      |
| Payee disputes a recorded payment                                                   | Next     |
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

- **Money is an integer count of the currency's smallest unit** (paise, cents, yen, fils), never
  floating point. The same split engine runs on the phone, the web page and the server.
- **The database guards the money.** Payers and splits must each add up to the expense total,
  rows can't cross groups, and the audit log can't be edited. Postgres enforces all of this,
  not just the application.
- **Privacy:** names are replaced with placeholders before text goes to a cloud AI model.
  Receipts are kept briefly unless attached to an expense. Bank details and UPI PINs are never
  stored.
- **Portable:** only standard interfaces (Postgres, Redis, S3 API, OIDC, OpenTelemetry), so it
  runs on a laptop, a small VM or any cloud.

## Data model

Every amount is a `bigint` column named `*_minor` holding the currency's smallest unit, next to
the currency it is in. Balances are computed from expenses and settlements per currency, never
stored as editable numbers.

| Table                                       | Holds                                                                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currencies`                                | ISO 4217 codes and how many decimal places each has (INR 2, JPY 0, KWD 3)                                                                                       |
| `exchange_rates`                            | Dated rates for converted views and settlement suggestions; balances never use them                                                                             |
| `users`, `user_upi_ids`                     | Accounts (linked to Auth0) and their UPI IDs (one primary)                                                                                                      |
| `groups`, `group_members`                   | Groups (with a default currency) and their members. A member may be a placeholder with no account yet. Friend-to-friend expenses live in hidden `direct` groups |
| `expenses`                                  | Description, total and its currency, date, split type, source (manual, text, voice, image)                                                                      |
| `expense_payers`, `expense_splits`          | Who paid and who owes how much, per member                                                                                                                      |
| `expense_items`, `expense_item_assignments` | Receipt line items and who shares each one                                                                                                                      |
| `settlements`                               | Payments between members: the debt cleared (amount + currency), and what was actually sent if it was another currency; UPI only in INR                          |
| `recurring_expenses`                        | Schedules that generate expenses                                                                                                                                |
| `invites`, `blocks`                         | Invite links (hashed tokens) and user blocks                                                                                                                    |
| `attachments`, `comments`                   | Receipts and payment proofs (in S3); comments on expenses                                                                                                       |
| `push_tokens`                               | Device tokens for notifications                                                                                                                                 |
| `audit_log`                                 | Append-only history, also the activity feed                                                                                                                     |
| `idempotency_keys`                          | Makes create-expense and record-payment safe to retry                                                                                                           |
| `member_balances`, `user_balances` (views)  | Net balance per member and per user, one row per currency                                                                                                       |

Other guarantees: expenses and comments are soft-deleted, members leave rather than being
deleted, and optimistic locking (`version` columns) stops two people silently overwriting the
same expense.

### Money and rounding

- **Stored amounts are integers in minor units**, so every stored value is exact to the
  smallest unit of its currency. They are `bigint` in Postgres and safe integers in JavaScript
  (up to about 90 trillion rupees); anything larger is rejected, not rounded.
- **Decimal inputs never touch a float.** Percentages, shares, exchange rates and typed amounts
  are parsed from their decimal text into exact integers (`bigint`) before any arithmetic.
- **Amounts typed with too many decimals are rejected** (₹1.005, ¥10.5) unless a caller asks
  for a specific rounding mode, for example when reading a receipt.
- **Splits always add up exactly.** Each person gets the whole-unit part of their exact share;
  the few leftover units go one each to the largest remainders, ties going to the earlier
  member in a stable order. Everyone is within one minor unit of their exact share.
- **Currency conversion rounds once**, at the end, half-to-even, and only for display or
  suggested settlement amounts. Balances stay in the currency the money was spent in.
- **The database checks it too:** payers and splits must sum exactly to the total, currencies
  must exist, and UPI payments must be in INR.

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
  split-engine/   shared, dependency-free money, split and balance logic
  api-types/      zod schemas shared by the API and clients
deploy/           docker-compose, Helm, Argo CD, Terraform
docs/             product plan and schema design
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

## MVP checklist

- [x] Monorepo scaffolding, CI, local Docker Compose stack
- [x] Database schema and migrations, with integration tests for the money rules
- [x] Multi-currency support in the schema
- [x] Split engine
  - [x] Exact money maths: currencies, decimal parsing, conversion, rounding
  - [x] Equal, exact, percent, shares and adjustment splits with property-based tests
  - [x] Net balances from expenses and settlements, per currency
  - [x] Who owes whom, without simplification (for groups that turn it off)
  - [x] Debt simplification (fewest transfers), per currency
- [x] API foundation
  - [x] Auth0 token validation; create the user on first request
  - [x] Group membership check on every group-scoped endpoint (former members read-only)
  - [x] Database errors mapped to HTTP errors; request IDs and structured logs
  - [x] Idempotency keys for create endpoints (used by groups now; expenses and payments next)
  - [x] TypeORM entities mirroring the migration; shared request/response schemas
  - [x] Test that one user can't read or change another group's data
- [ ] API features
  - [x] Profile and UPI IDs (email and phone changes wait for a verified flow)
  - [x] Groups: create, list, view, rename (optimistic locking), default currency, archive,
        delete when settled
  - [x] Friend-to-friend groups (expenses in them come with the expense endpoints)
  - [ ] Invite links; join; remove members (blocked while they have a balance)
  - [ ] Expenses: create, edit, delete, with audit history
  - [ ] Balances per group and overall, with simplified debts
  - [ ] Record a payment (UPI or cash, including paying a foreign-currency debt in INR); counts
        immediately; must clear the full amount owed
- [ ] Text-to-split: `POST /expenses/parse` with name anonymisation and split-engine validation
- [ ] Auth0 tenant: mobile app, API audience, email OTP and Google sign-in
- [ ] Mobile app: login, groups, add expense (form and text with review), expense detail,
      invites, profile, settle up via UPI
- [ ] Ship to friends: VM with Docker Compose and TLS, nightly backups, Android APK, testing UPI
      links on real phones

Decided:

- **Visibility:** every member of a group can see every expense in it, but expense lists show
  only the ones you paid for or are part of unless you ask for all of them.
- **Leaving:** members who leave a group keep read access to its history; they can no longer
  add or change anything in it.

- **Payments count straight away.** Recording a payment updates balances immediately; the
  payee doesn't have to confirm it (disputing one comes after the MVP).
- **No partial payments.** A payment clears the whole amount one person owes another in that
  currency: the amount in the suggested settle-up plan, or the direct debt when the group has
  simplification turned off.

Still open: which AI provider to use for text-to-split.

## After the MVP

1. Roles, placeholders, block/unblock, payee confirmation of payments
2. Web pay page and single sign-on
3. Voice entry, receipt photos and itemised splits
4. Search, filters, activity feed, push reminders, converted currency views
5. Kubernetes (Helm, k3s), then Terraform + Argo CD + EKS
6. On-device AI
