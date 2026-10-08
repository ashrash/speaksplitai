# Auth0 tenant setup

This guide sets up sign-in with an email code or Google. The mobile app signs in through Auth0's
hosted login page using Authorization Code + PKCE and gets refresh tokens. The API checks the
access tokens it receives.

Make two tenants: one for development and one for production (for example `speaksplit-dev` and
`speaksplit`). Do every step below in each tenant. Development-only settings are marked **(dev)**.

Menu names are from the Auth0 dashboard as of 2026. If Auth0 renames something, search the
dashboard for the setting's name.

## What the API needs

| API variable            | Value                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `AUTH0_ISSUER_URL`      | `https://<tenant>.<region>.auth0.com/`, or `https://<custom domain>/`. It must keep the trailing slash.  |
| `AUTH0_AUDIENCE`        | The API Identifier from step 2, e.g. `https://api.speaksplit.example.com`                                |
| `AUTH0_CLAIM_NAMESPACE` | The same value as the Action's `CLAIM_NAMESPACE` secret (step 6), e.g. `https://speaksplit.example.com/` |
| `AUTH0_CLIENT_ID` (dev) | The Native app's Client ID (step 3). Only `pnpm auth:login` uses it; the API doesn't.                    |

## 1. Tenant

1. Sign up at auth0.com and create a tenant. Choose the region closest to your users. You can't
   change the region later, and it decides where user data is stored.
2. Go to **Settings → General** and set the friendly name and logo. They appear on the login page.
3. **Custom domain** (optional): you can set one under **Branding → Custom Domains**, such as
   `login.speaksplit.example.com`. Then `AUTH0_ISSUER_URL` becomes that domain. Check
   auth0.com/pricing first, because the free plan may require a credit card for this or not
   include it at all. The `*.auth0.com` domain works fine for testing.

## 2. API (audience)

Go to **Applications → APIs → Create API**:

- **Name:** `SpeakSplit API`
- **Identifier:** `https://api.speaksplit.example.com`. This becomes `AUTH0_AUDIENCE`. It is only
  a label (Auth0 never calls it), and you can't change it later.
- **JSON Web Token profile:** Auth0
- **Signing algorithm:** RS256. The API rejects every other algorithm.

Then, on the API's **Settings** tab:

- **Allow Offline Access:** on. Without it, the app gets no refresh token.
- **Token Expiration:** `3600` (one hour). The app refreshes silently, so short-lived access
  tokens cost nothing.
- **RBAC / Add permissions in the access token:** off. The API checks group membership itself.
- **JSON Web Encryption:** off. The API can't read encrypted tokens.

## 3. Mobile app (Native)

Go to **Applications → Applications → Create Application** and choose **Native**. Call it
`SpeakSplit`.

On **Settings**:

- **Allowed Callback URLs** and **Allowed Logout URLs.** These depend on the sign-in library the
  Expo app uses. With `react-native-auth0`, and assuming the package / bundle ID is
  `app.speaksplit`, they are:

  ```
  app.speaksplit.auth0://<tenant domain>/android/app.speaksplit/callback,
  app.speaksplit.auth0://<tenant domain>/ios/app.speaksplit/callback
  ```

  **(dev)** Also add `http://localhost:3999/callback`, which `pnpm auth:login` uses. Leave it
  out of the production tenant.

- **Refresh Token Rotation:** on. Each refresh returns a new refresh token and invalidates the
  old one, so a leaked refresh token stops working.
- **Refresh Token Expiration:** turn on both the absolute and the inactivity expiry. For example,
  set an inactivity lifetime of 30 days (the user stays signed in while they use the app) and an
  absolute lifetime of 365 days.

Under **Advanced Settings → Grant Types**, keep only **Authorization Code** and **Refresh Token**.

On the **Connections** tab, turn on **email** (step 4) and **google-oauth2** (step 5). Turn off
**Username-Password-Authentication** so nobody can sign up with a password.

Copy the **Client ID**. The mobile app uses it, and so does `AUTH0_CLIENT_ID` **(dev)**. A Native
app has no client secret.

## 4. Email code sign-in (passwordless)

1. Go to **Authentication → Passwordless → Email** and turn it on.
2. Choose **Code** (OTP), not Magic Link. A code is typed into the app, so it works even when the
   email is opened on another device. A magic link opens a browser and doesn't come back to the
   app with a refresh token.
3. Set the OTP length (6) and expiry (5 minutes, which is 300 s). Edit the email template if you
   want different wording.
4. On the connection's **Applications** tab, turn on `SpeakSplit`.
5. **Email provider:** Auth0's built-in sender is for testing only and has a low rate limit. In
   production, set a real provider under **Branding → Email Provider** (SES, SendGrid, Postmark or
   SMTP) and send from your own domain with SPF and DKIM set up.

A user who signs in with a code is created with `email_verified: true`. Entering the code proves
they own the address.

## 5. Google

1. Go to **Authentication → Social → Create Connection → Google / Gmail**.
2. Auth0's development keys are fine for a quick test. For real users, create an OAuth client
   (type: **Web application**) in Google Cloud Console → APIs & Services → Credentials:
   - **Authorized redirect URI:** `https://<tenant domain>/login/callback` (use the custom domain
     if you set one up).
   - Copy the Client ID and secret into the Auth0 connection.
   - Configure the Google consent screen and publish it, or only listed test users can sign in.
3. **Attributes:** basic profile and email.
4. On the connection's **Applications** tab, turn on `SpeakSplit`.

**Same email, two sign-in methods.** By default, Auth0 treats a person who signs in with Google
and then with an email code as two separate users. Each gets its own `sub`, so the API creates two
accounts. The API never gives one email address to two active accounts, so the second account
just has no email. If this becomes a problem, add account linking: a post-login Action that merges
users with the same verified email, using the Management API. Until then, tell friends to always
use the same sign-in method.

## 6. Post-login Action (profile claims)

By default, Auth0 access tokens carry only the user ID (`sub`). The API needs the verified email
to match friend requests sent by email, and the name to label new accounts.
[`post-login.js`](post-login.js) copies these onto the access token as namespaced claims.

1. Go to **Actions → Library → Create Action → Build from scratch**.
   - **Name:** `Add profile claims`
   - **Trigger:** Login / Post Login
   - **Runtime:** the newest Node version offered
2. Replace the code with the contents of [`post-login.js`](post-login.js).
3. Open **Secrets** (the key icon) and add `CLAIM_NAMESPACE` = `https://speaksplit.example.com/`.
   Use exactly the same value as `AUTH0_CLAIM_NAMESPACE`. The namespace must be a URL you
   control, but nothing is ever fetched from it.
4. Click **Deploy**.
5. Go to **Actions → Triggers → post-login**, drag `Add profile claims` into the flow and click
   **Apply**.

If the secret is missing, the Action denies sign-in. This way a misconfigured tenant fails at
login instead of quietly creating accounts with no email.

The tests in [`apps/api/src/auth/auth0-action.test.ts`](../../apps/api/src/auth/auth0-action.test.ts)
run this exact file and check that the API reads the claims it sets. If you change the Action in
the dashboard, copy the change back here too.

## 7. Check it end to end

Put the values in the repo-root `.env`: `AUTH0_ISSUER_URL`, `AUTH0_AUDIENCE`,
`AUTH0_CLAIM_NAMESPACE`, and **(dev)** `AUTH0_CLIENT_ID`. Then run:

```sh
pnpm --filter @speaksplit/api build
pnpm --filter @speaksplit/api auth:login
```

The command prints a login URL. Open it, sign in with an email code or Google, and the command
receives the token on `localhost:3999`. It then checks the token exactly the way the API does
(signature against the tenant's keys, issuer, audience, expiry, RS256) and the profile claims.
Every problem comes with the setting to fix:

```
✓ Got a refresh token (offline access works)
✓ AUTH0_ISSUER_URL matches the tenant (https://speaksplit-dev.eu.auth0.com/)
✓ Signature, issuer, audience and expiry are valid (sub email|65f…)
✓ Verified email asha@example.com: friend requests by email will reach this user
! No name claim: new users are named after their email's local part
```

(Email-code users have no name until they set one in their profile, so that last warning is
expected.)

To check a token from somewhere else, such as the app's debug log, run:

```sh
pnpm --filter @speaksplit/api auth:check-token <access token>
```

## Common failures

| Symptom                                       | Fix                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| "This isn't a JWT" or "encrypted (JWE) token" | The app didn't send `audience=<AUTH0_AUDIENCE>` when signing in, or JWE is on (step 2).                     |
| "Issued by … but the API expects …"           | `AUTH0_ISSUER_URL` is missing the trailing slash, points at the other tenant, or a custom domain is in use. |
| "No refresh token"                            | Allow Offline Access (step 2), the Refresh Token grant (step 3), and request the `offline_access` scope.    |
| "No email claim"                              | The Action isn't in the post-login flow, or `CLAIM_NAMESPACE` ≠ `AUTH0_CLAIM_NAMESPACE`.                    |
| `Callback URL mismatch` on the login page     | Add the exact URL to Allowed Callback URLs (step 3).                                                        |
