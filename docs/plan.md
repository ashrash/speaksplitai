# SpeakSplit Pay: Product & Technical Plan

A Splitwise-style expense-splitting app for India. Natural-language, voice and receipt-photo entry, multi-currency expenses for trips abroad, settlement through UPI deep links, Auth0 SSO (OIDC + PKCE), and a cloud-agnostic backend that runs on Docker Compose, k3s or EKS.

Companion: [`schema.md`](schema.md) (data model and PostgreSQL schema). The schema is implemented in `apps/api/src/database/migrations`.

> **Scope:** personal / learning project for use within a friends group. Several choices (EKS rehearsals, Auth0 cross-domain SSO) are deliberate learning exercises rather than the cheapest route.

---

## Table of contents

1. [Goals and non-goals](#1-goals-and-non-goals)
2. [Functional requirements](#2-functional-requirements)
3. [Non-functional requirements](#3-non-functional-requirements)
4. [Architecture](#4-architecture)
5. [Tech stack](#5-tech-stack)
6. [Data model](#6-data-model)
7. [Split engine](#7-split-engine)
8. [AI parsing design](#8-ai-parsing-design)
9. [Authentication and SSO](#9-authentication-and-sso)
10. [UPI settlement](#10-upi-settlement)
11. [Infrastructure and deployment](#11-infrastructure-and-deployment)
12. [Repository layout](#12-repository-layout)
13. [Cost notes](#13-cost-notes)
14. [Build order](#14-build-order)
15. [Risks and things to test early](#15-risks-and-things-to-test-early)
16. [Open questions](#16-open-questions)

---

## 1. Goals and non-goals

### Goals
- Make adding an expense take seconds: type, speak, or photograph a bill.
- Support every common split type, correctly, to the smallest unit of the currency.
- Handle trips abroad: expenses in any supported currency, settled in rupees.
- Settle through UPI with a prefilled payment link.
- Learn: OIDC/PKCE, cross-domain SSO, Kubernetes, cloud-agnostic design, on-device AI.

### Non-goals (for now)
- Holding or moving user money (no wallet, no escrow, no payment-aggregator role).
- Becoming a UPI TPAP.
- Public app-store launch and a bank-grade audit trail.
- Automatic currency conversion of balances: balances stay in the currency the money was spent in.

---

## 2. Functional requirements

Priority: **P0** = MVP, **P1** = next, **P2** = later.

### 2.1 Expense entry

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | **Manual split:** form with amount, description, date, payer, participants and split type. | P0 |
| FR-2 | **Text-to-split:** type a sentence such as "Rahul paid 800 for cab, split with Priya and me." The system parses it into a draft expense. | P0 |
| FR-3 | **Voice-to-split:** speak the sentence (via keyboard dictation initially, in-app speech later); transcribe and parse. Supports English, Hindi and Hinglish. | P1 |
| FR-4 | **Image-to-split:** photograph a bill or receipt; OCR/vision extracts the items, taxes, tips and total into a draft expense. | P1 |
| FR-5 | **Image + text combined:** attach a receipt and add instructions ("Mike had the steak, rest split equally"). The instruction is applied to the extracted line items. | P1 |
| FR-6 | **Review before save:** every AI-generated expense appears as an editable draft with a clear confirm step. The AI never saves silently. | P0 |
| FR-7 | **Itemised splits:** assign individual line items to specific people; shared items are split among a chosen subset; tax and tip are distributed proportionally or equally. | P1 |
| FR-8 | **Recurring expenses:** rent, subscriptions and utilities created on a schedule. | P2 |
| FR-9 | **Edit and delete expenses** with an audit trail (who changed what, when). | P0 |
| FR-10 | **Attachments:** one or more receipt images attached to an expense. | P1 |
| FR-11 | **Expense categories** (food, travel, rent, utilities, etc.), auto-suggested by the AI. | P2 |

### 2.2 Split types

| ID | Requirement | Priority |
|---|---|---|
| FR-12 | **Equal** split among selected participants. | P0 |
| FR-13 | **Exact amounts** per person (must sum to the total). | P0 |
| FR-14 | **Percentages** (must sum to 100%). | P0 |
| FR-15 | **Shares / units** (e.g. 2 shares vs 1 share). | P0 |
| FR-16 | **Adjustment split:** equal split plus or minus fixed amounts per person. | P1 |
| FR-17 | **Payer is not a participant** (paid on someone's behalf). | P0 |
| FR-18 | **Multiple payers** for one expense. | P1 |
| FR-19 | **Remainder handling:** deterministic rule for leftover minor units (e.g. ₹100 among 3 people), identical on every client and the server. | P0 |
| FR-20 | **Usage-weighted split** (e.g. electricity by AC hours, rent by room size). | P2 |

### 2.3 Groups and people

| ID | Requirement | Priority |
|---|---|---|
| FR-21 | **Create, rename, archive and delete groups** (trip, flat, couple, etc.). | P0 |
| FR-22 | **Group splits:** expenses belong to a group; the group has its own balances. | P0 |
| FR-23 | **Non-group (friend-to-friend) expenses** between two people. | P0 |
| FR-24 | **Invite members** by shareable link (WhatsApp), phone number or email. | P0 |
| FR-25 | **Add and remove members**; removal is blocked or flagged while the member has a non-zero balance. | P0 |
| FR-26 | **Roles:** group owner/admin and member, with permissions for adding or removing members and editing others' expenses. | P1 |
| FR-27 | **Block users:** a blocked user cannot invite me, add me to groups, or send me requests or reminders. Existing shared history is preserved. | P1 |
| FR-28 | **Unblock** users and view a block list. | P1 |
| FR-29 | **Leave a group** (only with a settled balance, or with explicit acknowledgement). | P1 |
| FR-30 | **Placeholder members:** add a person who hasn't joined yet by name, and claim the placeholder when they sign up. | P1 |

### 2.4 Balances, bills and history

| ID | Requirement | Priority |
|---|---|---|
| FR-31 | **View balances:** who owes whom, per group and overall. | P0 |
| FR-32 | **Pending balances / dues:** a list of what I owe and what I'm owed, with ageing. | P0 |
| FR-33 | **Simplify debts:** minimise the number of transfers within a group; can be toggled on or off per group. | P0 |
| FR-34 | **View bills:** expense detail screen with the split breakdown, receipt image, payer and history. | P0 |
| FR-35 | **Search:** search expenses by description, amount, person, group, category and date range. | P1 |
| FR-36 | **Filters and sorting:** by group, person, status (open/settled), category, date. | P1 |
| FR-37 | **Activity feed** per group (added, edited, deleted, settled). | P1 |
| FR-38 | **Export** a group's ledger as CSV or PDF. | P2 |
| FR-39 | **Monthly summary / insights** (spend by category, by person). | P2 |

### 2.5 Settlement and payments

| ID | Requirement | Priority |
|---|---|---|
| FR-40 | **Settle via UPI:** generate a `upi://pay` deep link with payee VPA, amount, note and reference, and open the user's UPI app. | P0 |
| FR-41 | **UPI app choice:** buttons for GPay, PhonePe and Paytm, plus a generic chooser. | P1 |
| FR-42 | **Fallbacks:** copy UPI ID, show a QR code. | P1 |
| FR-43 | **Record payment:** mark a settlement as paid (full or partial) and as cash or UPI. | P0 |
| FR-44 | **Confirmation by payee:** the receiver confirms a payment; unconfirmed payments stay "pending confirmation". | P1 |
| FR-45 | **Payment evidence:** optionally attach the UPI success screenshot and extract the reference number and amount. | P2 |
| FR-46 | **Settle-all** suggestions for a group (the minimal set of transfers). | P1 |
| FR-47 | **Reminders:** push notification and a prefilled WhatsApp message containing a pay link. | P1 |

### 2.6 Accounts and profile

| ID | Requirement | Priority |
|---|---|---|
| FR-48 | **Sign-up and sign-in** via Auth0 (email OTP, Google). | P0 |
| FR-49 | **Single sign-on** between the mobile app and the web pay page. | P1 |
| FR-50 | **Profile:** name, avatar, UPI ID(s), default currency (INR unless changed), language. | P0 |
| FR-51 | **Sign out everywhere** and session management. | P1 |
| FR-52 | **Delete account and data**, with the effect on shared groups defined. | P1 |
| FR-53 | **Web pay page:** a link opens a page showing "you owe ₹X to Y" and a pay button, usable by people without the app. | P1 |

### 2.7 Notifications and sharing

| ID | Requirement | Priority |
|---|---|---|
| FR-54 | **Push notifications** for new expense, edit, payment received, reminder. | P1 |
| FR-55 | **Per-group notification settings** (mute, digest). | P2 |
| FR-56 | **Share a balance card** (image or text) to WhatsApp. | P1 |
| FR-57 | **In-app comments** on an expense. | P2 |

### 2.8 Currencies

| ID | Requirement | Priority |
|---|---|---|
| FR-58 | **Expenses in any supported currency** (ISO 4217; INR by default; USD, EUR, AED, THB, JPY, KWD and more). Amounts are exact to the currency's smallest unit (2 decimals for INR, 0 for JPY, 3 for KWD). | P0 |
| FR-59 | **Per-currency balances:** amounts in different currencies are never added together or silently converted. | P0 |
| FR-60 | **Group default currency** used for new expenses and converted views; each user also has a default currency. | P0 |
| FR-61 | **Settle a foreign-currency debt in INR:** a payment records the debt cleared (e.g. $10) and what was actually sent (e.g. ₹831.23). UPI payments are always INR. | P0 |
| FR-62 | **Converted view:** "about ₹X in total" and suggested settlement amounts from stored exchange rates. | P1 |
| FR-63 | **Exchange-rate updates:** a worker job stores dated rates from a configurable source. | P1 |

### 2.9 Additions beyond the original list (marked for your review)

These were not in your original list. FR-6, FR-9, FR-19, FR-25, FR-30, FR-33, FR-43, FR-44 and FR-47 above are the most important: they define correctness and trust, and most splitting apps get one of them wrong.

Further ideas, not yet numbered:
- **Offline entry** with background sync and idempotent retries.
- **Undo** within a short window after saving or deleting.
- **Dispute / flag** an expense ("this isn't mine") that notifies the payer.
- **Accessibility:** screen-reader support, large text, Hindi and regional-language UI.
- **Dark mode.**

---

## 3. Non-functional requirements

| Area | Requirement |
|---|---|
| **Correctness** | Money stored as an integer count of the currency's minor unit (`bigint` in Postgres, safe integers in JS). No floating point anywhere: percentages, shares and exchange rates are parsed from decimal text into exact integers. Amounts with more decimals than the currency allows are rejected, not rounded. Split and simplification logic is pure, deterministic and unit-tested; the same code runs on the client and the server. |
| **Idempotency** | Create-expense and record-payment endpoints accept idempotency keys, so retries on bad networks never duplicate entries. |
| **Security** | OIDC Authorization Code + PKCE (S256), JWT validation (signature, `iss`, `aud`, `exp`, scopes), tokens in secure storage, TLS everywhere, and secrets outside the repo. |
| **Authorization** | Every data-access path is scoped by group membership; tests prove one user cannot read another group's data. |
| **Privacy** | AI calls receive anonymised text (names replaced by P1, P2, …). The cloud model gets no group identity or history. Zero-retention API terms where available. Data deletion supported. |
| **Performance** | Add-expense round trip under ~1 s on a typical Indian 4G connection; balance view under ~500 ms for groups of up to 50 people and 5,000 expenses. |
| **Availability** | Best-effort for personal use. Stateless API replicas so that scaling out is a config change. |
| **Offline** | Reads work from cache; writes are queued and synced (P1). |
| **Portability** | Only standard interfaces in application code: Postgres, Redis, S3 API, OIDC, OpenTelemetry. No proprietary cloud services. |
| **Observability** | Structured logs with request IDs, traces, metrics, and crash reporting. |
| **Compatibility** | iOS 15+ and Android 8+ (API 26+); on-device AI is optional and never required. |
| **Accessibility / i18n** | English and Hindi UI strings from the start (externalised); Hinglish input handled by the parser. |
| **Compliance (awareness)** | India's DPDP rules for personal data; the app never stores bank credentials or UPI PINs. |

---

## 4. Architecture

```
 Expo app (iOS + Android)             Web pay page (2nd domain)
    │  OIDC Auth Code + PKCE             │  OIDC Auth Code + PKCE (SPA)
    ▼                                    ▼
 Auth0 tenant (custom domain: login.<yourdomain>)
    │  access token (aud = SpeakSplit API, role/claims via Action)
    ▼
 Ingress (NGINX or Gateway API, TLS via cert-manager)
    ├─ api (NestJS + TypeORM, TypeScript): REST + WebSocket/SSE, JWKS validation
    └─ worker: reminders, push, AI jobs, exchange rates (BullMQ)
          │
          ├─ PostgreSQL     (container locally, managed or CloudNativePG in prod)
          ├─ Redis          (queues, pub/sub for realtime fan-out, rate limits)
          └─ S3-compatible  (MinIO locally, S3 or R2 in prod): receipts, avatars

 App ──▶ upi://pay?... ──▶ GPay / PhonePe / Paytm  (no backend involvement)
 App ──▶ on-device model (step 2) ──▶ falls back to POST /expenses/parse
```

---

## 5. Tech stack

### 5.1 Mobile app

| Concern | Choice |
|---|---|
| Framework | Expo + React Native, TypeScript |
| Navigation | Expo Router |
| Styling | NativeWind |
| Server state | TanStack Query (persisted cache) |
| UI state | Zustand |
| Forms / validation | react-hook-form + zod |
| Auth | `expo-auth-session` (Auth Code + PKCE S256) or `react-native-auth0` |
| Token storage | `expo-secure-store` (refresh token); access token in memory |
| Push | `expo-notifications` |
| Camera / images | `expo-camera`, `expo-image-picker`, `expo-image-manipulator` (resize before upload) |
| Payments | `Linking.openURL('upi://pay?...')` |
| Voice (v1) | Keyboard dictation (free, handles Hinglish) |
| Voice (later) | On-device or server speech-to-text behind a `transcribe()` interface |
| Local DB (P1) | `expo-sqlite` for offline queue |
| i18n | `i18next` |

### 5.2 Web pay page

| Concern | Choice |
|---|---|
| Framework | Vite + React |
| Auth | `@auth0/auth0-react` or `oidc-client-ts`, Auth Code + PKCE, refresh token rotation |
| Hosting | Cloudflare Pages, or an nginx container in the cluster, on a **separate registrable domain** from the Auth0 custom domain |

### 5.3 Backend

| Concern | Choice |
|---|---|
| Language / framework | TypeScript + NestJS (ES modules; shares the split engine with the clients) |
| API style | REST with zod schemas and OpenAPI; WebSocket or SSE for realtime |
| Auth | JWT validation via JWKS (`jose`): `iss`, `aud`, `exp`, scopes |
| Authorization | Application-level, scoped by group membership in a single data-access layer; optional Postgres RLS via `SET LOCAL` as defence in depth |
| ORM / queries | TypeORM (`synchronize` off; entities mirror the migrations) |
| Migrations | Hand-written TypeORM migrations, run as a Kubernetes Job before rollout |
| Queue / cache | Redis + BullMQ |
| File storage | S3 API (MinIO locally) |
| Realtime | WebSocket/SSE with Redis pub/sub for multi-replica fan-out |
| Validation of money | Shared `split-engine` package |
| Testing | Vitest (unit) and integration tests against a real PostgreSQL 16 |

### 5.4 Identity (Auth0)

- One tenant with a **custom domain** (needed for reliable cross-domain SSO; check current plan limits).
- Applications: **Native** (mobile), **SPA** (pay page), and an **API** with an audience.
- Connections: passwordless email OTP and Google.
- An **Action** adds custom claims (e.g. role) to access tokens.
- Refresh token rotation on; RP-initiated logout; back-channel logout later.

### 5.5 AI

| Concern | Choice |
|---|---|
| Interface | `parseExpense(input: {text?, imageRefs?, context}) → DraftExpense` with swappable providers |
| Cloud (v1) | `POST /expenses/parse` → Gemini Flash-Lite, Claude Haiku or a small OpenAI model, with JSON-schema output |
| Images | A vision-capable model for receipts, or on-device OCR (ML Kit text recognition) followed by text parsing |
| On-device (step 2) | Pixel 8 Pro: bundled small model via `llama.rn` / LiteRT. Supported phones (Pixel 9+, recent Samsung/OnePlus/Xiaomi): Gemini Nano via ML Kit Prompt API. Apple Intelligence iPhones: Foundation Models framework. |
| Fallback chain | On-device → cloud (anonymised) → manual form |
| Guardrails | Always a review step (FR-6); rate limits per user; reject or flag if parsed splits don't sum to the total |

### 5.6 Tooling

GitHub, pnpm workspaces, ESLint, Prettier, Vitest, fast-check, GitHub Actions, Sentry (optional).

---

## 6. Data model

Full design, DDL and verification: [`schema.md`](schema.md). Summary:

- **Money** is a `bigint` count of the currency's minor unit, in columns named `*_minor`, always next to a currency code. IDs are UUIDs; `users.auth_subject` holds the Auth0 `sub`.
- **Currencies:** a `currencies` table (code, minor-unit exponent) seeded from the split engine's list; `exchange_rates` holds dated rates for converted views only.
- **Members, not users:** payers, splits, item assignments and settlements reference `group_members.id`, so placeholder members work and claiming one keeps its history.
- **Friend-to-friend expenses** live in a hidden `direct` group, so every expense has a group.
- **Postgres enforces the money rules:** payers and splits each sum to the total (checked at commit), rows can't cross groups, UPI payments are INR, the audit log is append-only.

| Table | Key fields |
|---|---|
| `currencies` | `code`, `minor_unit`, `name` |
| `exchange_rates` | `base`, `quote`, `rate`, `as_of`, `source` |
| `users` | `id`, `auth_subject`, `name`, `email`, `phone`, `avatar_url`, `locale`, `default_currency`, `deleted_at` |
| `user_upi_ids` | `user_id`, `vpa`, `label`, `is_primary` |
| `groups` | `id`, `name`, `type` (incl. `direct`), `default_currency`, `simplify_debts`, `direct_key`, `version`, `archived_at` |
| `group_members` | `id`, `group_id`, `user_id` (null for placeholder), `placeholder_name`, `role`, `joined_at`, `claimed_at`, `left_at` |
| `expenses` | `id`, `group_id`, `description`, `category`, `total_minor`, `currency`, `expense_date`, `split_type`, `source`, `version`, `deleted_at` |
| `expense_payers` | `expense_id`, `member_id`, `paid_minor` |
| `expense_splits` | `expense_id`, `member_id`, `owed_minor`, `share_value`, `adjustment_minor` |
| `expense_items`, `expense_item_assignments` | line items (`amount_minor`, `kind`) and who shares each (`shares`) |
| `settlements` | `from_member_id`, `to_member_id`, `amount_minor` + `currency` (debt cleared), `paid_amount_minor` + `paid_currency` (if sent in another currency), `method`, `upi_ref`, `status` |
| `invites`, `blocks`, `attachments`, `comments`, `push_tokens`, `recurring_expenses` | as in `schema.md` |
| `audit_log` | append-only history and activity feed |
| `idempotency_keys` | safe retries for create-expense and record-payment |

Balances are **derived** per currency by the `member_balances` and `user_balances` views, never stored as editable numbers.

---

## 7. Split engine

A dependency-free TypeScript package used by the app, the web page and the API.

**Money rules**
- Amounts are integers in the currency's minor unit (`MinorUnits`), kept within `Number.MAX_SAFE_INTEGER` so they are exact as JS numbers; every multiplication and division happens on `bigint`.
- Decimal inputs (percentages, shares, exchange rates, typed amounts) are parsed from their decimal text, never through floating-point arithmetic.
- Typed amounts with more decimals than the currency has are rejected unless a rounding mode is given explicitly (e.g. for OCR'd receipts).
- Currency conversion rounds once, at the end, half-to-even by default.

**Responsibilities**
- Compute per-person owed amounts for equal, exact, percent, share, adjustment and itemised splits.
- Distribute leftover minor units with the largest-remainder method: each person gets the whole-unit part of their exact share, and the leftover units go one each to the largest fractional remainders, ties to the earlier participant in a stable order. Everyone ends within one minor unit of their exact share.
- Validate: splits sum exactly to the total; percentages sum to exactly 100; no negative shares.
- Compute net balances from expenses and settlements, per currency.
- Without simplification, list who owes whom: within each expense, members who paid less than their share owe those who paid more, in proportion to the excess; debts are then netted per pair.
- Simplify debts per currency: split members into the largest number of groups whose balances sum to zero (exact search for up to 16 people with a non-zero balance), then within each group the largest debtor pays the largest creditor until all are settled. That gives the minimum number of transfers; beyond 16 people it falls back to the greedy step alone (at most n - 1 transfers).

**Testing**
- Property-based tests (fast-check): for any inputs, splits sum to the total, each part is within one unit of its exact share, results are deterministic; balances sum to zero per currency.
- Fixed fixtures for tricky cases: ₹100 among 3, 1 paisa among 2, ¥1000 among 3, percentages like 33.33/33.33/33.34, KWD with 3 decimals, conversions between currencies with different exponents, amounts beyond 32-bit range.

---

## 8. AI parsing design

1. **On the phone:** replace names with placeholders (P0 = me, P1, P2, …).
2. **Parse:** produce a draft: `{amount, payer, participants, splitType, items?, description, category}`.
3. **Validate:** run the split engine on the draft. If it doesn't add up, show an error or ask the user to fix.
4. **Map back** placeholders to real members on the phone.
5. **Review screen:** user edits and confirms (FR-6).

For images: resize and compress on the device, send via a pre-signed upload (or inline), extract line items, tax and total, and combine with any typed instructions (FR-5). Receipts are personal data, so apply short retention and delete after parsing unless the user attaches the image to the expense.

Evaluate regularly with a small test set of real sentences in English, Hindi and Hinglish, and real receipts. Track the proportion parsed without edits.

---

## 9. Authentication and SSO

**Mobile (OIDC Authorization Code + PKCE)**
- System browser (ASWebAuthenticationSession / Custom Tabs), never an embedded webview.
- `code_verifier` / `code_challenge` (S256), `state`, `nonce`, correct redirect URI (custom scheme or app links).
- Scopes: `openid profile email offline_access`; audience set to the SpeakSplit API.
- Refresh token rotation; refresh token in secure storage.

**Cross-domain SSO**
- The pay page lives on a different registrable domain, so signing in on one client and opening the other demonstrates real SSO through the Auth0 session.
- Use `prompt=none` for silent checks and `prompt=login` to force reauthentication.
- Use an Auth0 **custom domain** to avoid third-party-cookie problems with silent auth.

**Logout**
- RP-initiated logout (end-session endpoint), token revocation, and back-channel logout across clients.

**Server**
- Validate JWT signature via JWKS, `iss`, `aud`, `exp`, scopes.
- Create the `users` row on first authenticated request (or via an Auth0 post-login Action).

**Later experiments:** MFA and step-up for large settlements, Auth0 Organizations, a CLI using the device authorization flow.

---

## 10. UPI settlement

- Build `upi://pay?pa=<VPA>&pn=<name>&am=<amount>&cu=INR&tn=<note>&tr=<ref>`.
- On Android this opens an app chooser. On iOS, per-app schemes may be needed, so offer explicit GPay, PhonePe and Paytm buttons.
- The app can't reliably verify that the payment succeeded, so the flow is: open UPI app → return → payer taps "I've paid" → payee confirms (FR-43, FR-44).
- Fallbacks: copy UPI ID and show a QR.
- UPI is INR-only. A debt in another currency is settled by paying rupees: the app suggests an amount from the latest stored rate, the payer can edit it, and the settlement records both the debt cleared and the rupees actually sent.
- Some UPI apps restrict or decline prefilled payments to personal VPAs. Test on friends' real apps early.
- NPCI discontinued P2P collect requests, so reminders are nudges to pay; they are not payment requests.

---

## 11. Infrastructure and deployment

### 11.1 Principles
- **Cloud-agnostic:** depend only on Postgres, Redis, the S3 API, OIDC and OpenTelemetry.
- Cloud-specific details live in Terraform modules and Helm values files.
- Stateless services behind an ingress, with config via environment variables and secrets.

### 11.2 Components

| Concern | Choice |
|---|---|
| Containers | Docker, multi-stage builds |
| Orchestration | Kubernetes, packaged with **Helm** (or Kustomize) |
| IaC | OpenTofu / Terraform, modules per cloud |
| GitOps | Argo CD (or Flux) |
| CI | GitHub Actions: lint, typecheck, tests, build, push image, update chart |
| Registry | GHCR (ECR on AWS) |
| Ingress / TLS | NGINX Ingress or Gateway API + cert-manager |
| Secrets | External Secrets Operator (AWS Secrets Manager or any backend) |
| Autoscaling | HPA on API and worker |
| Postgres on K8s | CloudNativePG (to learn) or managed Postgres |
| Observability | OpenTelemetry → Prometheus + Grafana + Loki (or Grafana Cloud free tier); Sentry for apps |

### 11.3 Environments

| Environment | Setup |
|---|---|
| Daily dev | Docker Compose: Postgres, Redis, MinIO, API, worker |
| Local Kubernetes | k3d or kind, with Tilt or Skaffold |
| Friends' environment | One small VM running k3s (or just Docker Compose), same Helm chart |
| EKS rehearsal | Terraform creates EKS, Argo CD deploys, you test, then `tofu destroy` |

### 11.4 Client distribution

| Target | Method |
|---|---|
| Android | `eas build -p android --profile preview` produces an APK link for friends |
| iOS | EAS + TestFlight (Apple Developer account, $99/yr); otherwise iPhone friends use the web pay page |
| JS updates | `eas update` |
| Web pay page | Cloudflare Pages, git-connected |

### 11.5 Migrations and releases
- Migrations run as a pre-upgrade Helm hook or Kubernetes Job.
- Expand/contract migrations so old and new API versions can coexist during rollout.
- Rolling deployments with readiness and liveness probes.

---

## 12. Repository layout

```
speaksplit-pay/
├─ apps/
│  ├─ mobile/                 # Expo app
│  ├─ pay-web/                # Vite web pay page
│  ├─ api/                    # NestJS + TypeORM API, migrations, DB integration tests
│  └─ worker/                 # BullMQ jobs (reminders, push, AI, exchange rates)
├─ packages/
│  ├─ split-engine/           # shared money maths, splits, balances + tests
│  └─ api-types/              # zod schemas / OpenAPI client
├─ deploy/
│  ├─ docker-compose.yml
│  ├─ helm/speaksplit/
│  ├─ argocd/
│  └─ terraform/{aws,local}/
├─ docs/
└─ .github/workflows/
```

---

## 13. Cost notes

| Item | Cost |
|---|---|
| Local dev, Docker Compose, GitHub, EAS free tier, Cloudflare Pages | ₹0 |
| Auth0 | Free plan for learning; check current limits, especially custom-domain availability |
| LLM calls | Gemini free tier or a few paise per parse with small models |
| Exchange rates | Free tiers of public rate APIs are enough for daily updates; check terms |
| Small VM for friends (k3s / Compose) | A few hundred rupees per month |
| **EKS** | **Not free.** The control plane alone is roughly $70+/month, plus nodes, NAT and load balancers. Create it for a rehearsal, then destroy it. |
| Apple Developer (TestFlight) | $99/year, optional |
| Domains | About ₹800/year each; you need at least two for realistic cross-domain SSO |

Verify current pricing before committing to any of these.

---

## 14. Build order

1. ~~**Monorepo scaffolding**, CI, Docker Compose~~
2. ~~**Postgres schema and migrations**, with integration tests; multi-currency~~
3. ~~**Split engine + tests**: money maths, currencies, rounding, split types, balances, simplification~~ (itemised splits come with step 10)
4. **API:** Auth0 JWT validation, group-scoped authorization, expenses, balances, with tests
5. **Mobile app:** OIDC + PKCE login, groups, manual expenses, balances, UPI settle
6. **Members and safety:** invites, add/remove, roles, block/unblock
7. **AI text parsing** (FR-2) with the review screen; then voice via keyboard dictation (FR-3)
8. **Deploy for friends:** Docker Compose on a small VM with TLS and backups; Android APK
9. **Web pay page** on a second domain; SSO between app and page
10. **Image and image+text parsing** (FR-4, FR-5), itemised splits
11. **Search, filters, activity feed, push reminders, converted currency views**
12. **Helm, k3d, then k3s VM**
13. **Terraform + Argo CD + EKS rehearsal**
14. **On-device AI** on a Pixel 8 Pro (bundled small model), then Gemini Nano on supported phones

---

## 15. Risks and things to test early

| Risk | Mitigation |
|---|---|
| Rounding errors or mismatched totals | Integer minor units, exact decimal maths, property-based tests, shared engine, totals checked by Postgres |
| Exchange-rate drift or bad rates | Balances never converted; rates only suggest settlement amounts, which the payer can edit |
| Duplicate entries from retries | Idempotency keys |
| Cross-group data leaks | Single data-access layer, tests with two users, optional RLS |
| UPI deep links failing on some apps or iOS | Test on friends' phones; keep copy-ID and QR fallbacks |
| No way to verify payment | Payer marks paid, payee confirms; optional screenshot evidence |
| AI misparses (names, amounts, Hinglish) | Mandatory review screen, validation by the split engine, evaluation set |
| Receipt images contain personal data | Short retention, clear policy, deletion on account removal |
| Auth0 redirect/URI misconfiguration | Exact redirect URIs per client; test on real devices |
| Third-party cookie blocking breaks silent SSO | Custom domain; fall back to redirect or popup |
| Free-tier limits change | Check current terms; keep code portable |
| On-device AI unavailable on most phones | Optional tier only; cloud and manual always work |
| Operational overhead of owning the backend | Start with Compose; add Kubernetes only after the API is stable |

---

## 16. Open questions

- Group-wide ledger visibility: can every member see every expense, or only those they're in?
- What happens to balances and history when a user deletes their account?
- Is partial settlement allowed, and how is it allocated across debts?
- Should debt simplification be on by default?
- Which languages beyond English and Hindi for the UI and parser?
- How long are receipt images kept?
- ~~Does a placeholder member's balance transfer when they claim the placeholder?~~ Yes: history references the member row, which the new account takes over.
- Which exchange-rate source, and how often should rates update?
- Should a group be able to restrict which currencies its expenses use?
