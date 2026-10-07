# SpeakSplit Pay: Product & Technical Plan

A Splitwise-style expense-splitting app for India. Natural-language, voice and receipt-photo entry, settlement through UPI deep links, Auth0 SSO (OIDC + PKCE), and a cloud-agnostic backend that runs on Docker Compose, k3s or EKS.

> **Scope:** personal / learning project for use within a friends group. Several choices (EKS rehearsals, Auth0 cross-domain SSO, a Go service) are deliberate learning exercises rather than the cheapest route.

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
- Support every common split type, correctly, to the paisa.
- Settle through UPI with a prefilled payment link.
- Learn: OIDC/PKCE, cross-domain SSO, Kubernetes, cloud-agnostic design, on-device AI.

### Non-goals (for now)
- Holding or moving user money (no wallet, no escrow, no payment-aggregator role).
- Becoming a UPI TPAP.
- Public app-store launch, multi-currency support, and a bank-grade audit trail.

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
| FR-19 | **Remainder handling:** deterministic rule for leftover paise (e.g. ₹100 among 3 people), identical on every client and the server. | P0 |
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
| FR-50 | **Profile:** name, avatar, UPI ID(s), default currency (INR), language. | P0 |
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

### 2.8 Additions beyond the original list (marked for your review)

These were not in your original list. FR-6, FR-9, FR-19, FR-25, FR-30, FR-33, FR-43, FR-44 and FR-47 above are the most important: they define correctness and trust, and most splitting apps get one of them wrong.

Further ideas, not yet numbered:
- **Offline entry** with background sync and idempotent retries.
- **Currency support** and conversion for trips abroad.
- **Undo** within a short window after saving or deleting.
- **Dispute / flag** an expense ("this isn't mine") that notifies the payer.
- **Accessibility:** screen-reader support, large text, Hindi and regional-language UI.
- **Dark mode.**

---

## 3. Non-functional requirements

| Area | Requirement |
|---|---|
| **Correctness** | Money stored as integer paise. No floating point. Split and simplification logic is pure, deterministic and unit-tested; the same code runs on the client and the server. |
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
    ├─ api (Fastify, TypeScript): REST + WebSocket/SSE, JWKS validation
    ├─ worker: reminders, push, AI jobs (BullMQ)
    └─ go-service (optional): JWT-validating service, notification dispatcher
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
| Language / framework | TypeScript + Fastify (shares the split engine with the clients) |
| API style | REST with zod schemas and OpenAPI; WebSocket or SSE for realtime |
| Auth | JWT validation via JWKS (`jose`): `iss`, `aud`, `exp`, scopes |
| Authorization | Application-level, scoped by group membership in a single data-access layer; optional Postgres RLS via `SET LOCAL` as defence in depth |
| ORM / queries | Drizzle (or Prisma) |
| Migrations | Drizzle Kit / Prisma Migrate, run as a Kubernetes Job before rollout |
| Queue / cache | Redis + BullMQ |
| File storage | S3 API (MinIO locally) |
| Realtime | WebSocket/SSE with Redis pub/sub for multi-replica fan-out |
| Validation of money | Shared `split-engine` package |
| Optional | Go service (chi/Gin + `lestrrat-go/jwx`) for token-validating gateway or notification dispatch |

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

GitHub, pnpm workspaces, ESLint, Prettier, Jest/Vitest, GitHub Actions, Sentry (optional).

---

## 6. Data model

All amounts are **integer paise**. IDs are UUIDs; `users.id` maps to the Auth0 `sub`.

| Table | Key fields |
|---|---|
| `users` | `id` (Auth0 sub), `name`, `email`, `phone`, `avatar_url`, `upi_id`, `locale`, `created_at`, `deleted_at` |
| `groups` | `id`, `name`, `type`, `currency`, `simplify_debts`, `created_by`, `archived_at` |
| `group_members` | `group_id`, `user_id` (nullable for placeholder), `placeholder_name`, `role`, `joined_at`, `left_at` |
| `expenses` | `id`, `group_id` (nullable), `description`, `category`, `total_paise`, `currency`, `date`, `created_by`, `split_type`, `idempotency_key`, `source` (manual/text/voice/image), `deleted_at` |
| `expense_payers` | `expense_id`, `user_id`, `paid_paise` |
| `expense_splits` | `expense_id`, `user_id`, `owed_paise`, `share_value` (shares/percent input) |
| `expense_items` | `expense_id`, `name`, `amount_paise`, `assigned_user_ids` |
| `attachments` | `id`, `expense_id`, `storage_key`, `mime`, `created_at` |
| `settlements` | `id`, `group_id`, `from_user`, `to_user`, `amount_paise`, `method` (upi/cash), `upi_ref`, `status` (pending/confirmed/disputed), `created_at` |
| `invites` | `id`, `group_id`, `token_hash`, `expires_at`, `max_uses`, `created_by` |
| `blocks` | `blocker_id`, `blocked_id`, `created_at` |
| `audit_log` | `id`, `entity`, `entity_id`, `actor_id`, `action`, `diff`, `created_at` |
| `push_tokens` | `user_id`, `token`, `platform`, `last_seen` |
| `comments` (P2) | `id`, `expense_id`, `user_id`, `body`, `created_at` |

Balances are **derived** from expenses and settlements (a view or computed in the engine), not stored as editable numbers.

Indexes to plan for: `(group_id, date)`, `(user_id)` on splits, and a trigram or full-text index on `expenses.description` for search (FR-35).

---

## 7. Split engine

A dependency-free TypeScript package used by the app, the web page and the API.

**Responsibilities**
- Compute per-person owed amounts for equal, exact, percent, share, adjustment and itemised splits.
- Distribute remainder paise deterministically (e.g. to participants in a stable order).
- Validate: splits sum exactly to the total; percentages sum to 100; no negative shares.
- Compute net balances from expenses and settlements.
- Simplify debts (greedy matching of the largest creditor and debtor; optional exact minimisation for small groups).

**Testing**
- Property-based tests (fast-check): for any inputs, sum of splits equals total; balances sum to zero.
- Fixed fixtures for tricky cases: ₹100 among 3, 1 paisa among 2, percentages like 33.33/33.33/33.34, multiple payers.

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
- Optional: re-implement the validator in Go to compare.

**Later experiments:** MFA and step-up for large settlements, Auth0 Organizations, a CLI using the device authorization flow.

---

## 10. UPI settlement

- Build `upi://pay?pa=<VPA>&pn=<name>&am=<amount>&cu=INR&tn=<note>&tr=<ref>`.
- On Android this opens an app chooser. On iOS, per-app schemes may be needed, so offer explicit GPay, PhonePe and Paytm buttons.
- The app can't reliably verify that the payment succeeded, so the flow is: open UPI app → return → payer taps "I've paid" → payee confirms (FR-43, FR-44).
- Fallbacks: copy UPI ID and show a QR.
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
│  ├─ api/                    # Fastify API
│  └─ worker/                 # BullMQ jobs (reminders, push, AI)
├─ packages/
│  ├─ split-engine/           # shared TS + tests
│  └─ api-types/              # zod schemas / OpenAPI client
├─ services/
│  └─ go-service/             # optional Go service
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
| Small VM for friends (k3s / Compose) | A few hundred rupees per month |
| **EKS** | **Not free.** The control plane alone is roughly $70+/month, plus nodes, NAT and load balancers. Create it for a rehearsal, then destroy it. |
| Apple Developer (TestFlight) | $99/year, optional |
| Domains | About ₹800/year each; you need at least two for realistic cross-domain SSO |

Verify current pricing before committing to any of these.

---

## 14. Build order

1. **Split engine + tests** (paise, remainders, all split types, simplification)
2. **Postgres schema, migrations, Docker Compose**
3. **API:** Auth0 JWT validation, group-scoped authorization, expenses, balances, with tests
4. **Mobile app:** OIDC + PKCE login, groups, manual expenses, balances, UPI settle
5. **Members and safety:** invites, add/remove, roles, block/unblock
6. **Web pay page** on a second domain; SSO between app and page
7. **AI text parsing** (FR-2) with the review screen; then voice via keyboard dictation (FR-3)
8. **Image and image+text parsing** (FR-4, FR-5), itemised splits
9. **Search, filters, activity feed, push reminders**
10. **Dockerize, Helm, k3d, then k3s VM** for friends
11. **Terraform + Argo CD + EKS rehearsal;** optional Go service
12. **On-device AI** on a Pixel 8 Pro (bundled small model), then Gemini Nano on supported phones

---

## 15. Risks and things to test early

| Risk | Mitigation |
|---|---|
| Rounding errors or mismatched totals | Integer paise, property-based tests, shared engine |
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
- Does a placeholder member's balance transfer when they claim the placeholder?
