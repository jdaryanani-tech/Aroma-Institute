# One-time production owner setup

This feature is implemented in workspace only. It does not provision an account
at import/build/startup time, in development, or simply by publishing.
No production account, credential, schema, workflow or secret was changed.

## Owner release steps

1. In Replit Secrets, configure **ADMIN_BOOTSTRAP_SECRET** for the production runtime.
   Use a password manager to generate a cryptographically random 64-character hex
   value (32 random bytes). Keep it private: never paste it into chat, a URL,
   command history or logs. No example secret is supplied here.
   The server accepts only 43–128 URL-safe ASCII characters with at least 12
   distinct characters; missing, malformed or weak configuration stays disabled.
2. Review and publish the code yourself. No migration is needed for this feature.
3. Open **https://aromacafeinstitute.in/admin/first-owner** on the main domain,
   not the workspace preview or a secondary hostname.
4. Privately enter the approved owner's complete E.164 phone, enter the temporary
   secret, and check the confirmation for **\*\*\*8669**. No other phone is eligible.
5. Submit once. The successful response shows the private HTTPS setup URL and its
   expiry. Copy it privately before leaving. It is shown only once and is not
   recoverable from the database: only its hash is stored.
6. **Immediately remove ADMIN_BOOTSTRAP_SECRET from Replit Secrets** after the
   successful bootstrap. Follow any publishing UI instructions to apply that
   configuration update. The permanent database audit marker closes bootstrap
   even while an older process still has the previous secret.
7. Open the private setup URL and choose your password. The link expires exactly
   24 hours after issuance and succeeds only once. Then sign in at `/admin/login`.

The setup page uses `/learn/setup#token=…` because CRM and LEAP share the existing
account/password mechanism. This does not change LEAP roles, redirects or the
independent PWA. Setup URLs and bootstrap secrets must not be shared in screenshots.

If the success response is lost, the browser is closed before copying, or the link
expires, do not repeat provisioning or delete audit markers. Bootstrap deliberately
will not reset an existing account. A separately approved owner-recovery action
is required if there is no other functioning admin.

## Runtime behavior

- Page: `/admin/first-owner` (disabled explanation outside availability).
- Read-only readiness: `GET /api/admin/first-owner/status`.
- Provision: `POST /api/admin/first-owner`.
- POST body: `{phone: "<exact approved E.164>", secret: "<private value>", confirmOwner: true}`.
  Phone/secret are typed privately, never prefilled and never accepted via query.
- Success 201: `{maskedPhone: "***8669", setupUrl: "<private HTTPS URL>", expiresAt: "<ISO timestamp>"}`.
- The production runtime uses the **same existing db/pool and DATABASE_URL** as
  the rest of the app, never a new client, caller-supplied database or override URL.
- Requires production mode, valid secret configuration, HTTPS, canonical main host,
  exact same-origin POST, exact owner phone and explicit confirmation.
- No secret: 404. Wrong secret/origin: 403. Authorized but wrong phone/confirmation:
  400. Already closed/existing owner: 409. Rate limit: 429. Database failure: 503.
- Before creation, persistent limits allow five POST attempts per IP and 30
  globally per 15 minutes. Separate hashed buckets do not alter normal login limits.
- Failure audits contain static reasons and masked owner only; no submitted phone,
  IP, secret, setup URL, token or credential. Throttle audit entries are bounded;
  further throttled requests remain counted in the persistent limiter.
- All page/API responses are private/no-store with no-referrer and noindex headers.
  There is no analytics event, browser storage, clickable token URL or automatic
  navigation. Inputs clear after submission; output can be explicitly hidden.

## Transaction and permanence

An advisory transaction lock serializes requests. A role-table lock prevents
concurrent role writes while checking for zero admins (including inactive admins).
The existing owner phone must also be absent. Existing accounts are never
promoted, activated or reset by this flow. The student ending 6789 is untouched.

In a single transaction, create the new active `lms_users` row with null
`password_hash`, add its admin `lms_user_roles` row, issue the existing password
setup token and record `bootstrap.first_owner_created` in `lms_audit_logs`.
Any failure rolls all of these back.

The shared `issueLmsPasswordSetupLinkInTransaction` reuses the existing random-byte
token and SHA-256 storage conventions, records creation time and exactly 24-hour
expiry, and leaves all other users' tokens unchanged. The normal setup endpoint
continues to consume tokens once and establish the normal session.

Bootstrap checks permanent audit markers as well as current admin roles. A
successful bootstrap stays closed even if that admin role is later removed.
An authenticated-secret attempt encountering an existing admin/owner also records
`bootstrap.first_owner_locked`; it never changes that account. Readiness GET does
not write records. Existing CLI bootstrap audit markers also close the runtime flow.

No database schema changes or migrations are required. Production metadata was
checked read-only for the existing users, roles, audit, setup-token and limiter
tables/columns.

## Safe verification

Workspace results: TypeScript and production build passed. Default tests passed
45 checks with six expected opt-in integration skips. The isolated first-owner
suite passed both tests with no skips; the existing password/session integration
passed separately in that same disposable cluster. Three targeted Chromium
scenarios passed (the disabled-page assertion was corrected to distinguish its
two sign-in links). No live bootstrap request was submitted.

- `npm run test:first-owner`: creates a new socket-only PostgreSQL cluster in
  ignored generated-artifacts, checks its identity, uses fixtures only, then removes
  it. Includes disabled development/missing/weak secret, wrong secret/phone,
  confirmation, origin, rate limit, existing owner/admin, concurrent/replayed
  requests, permanent closure, insertion-failure rollback, no student/token changes,
  hash-only storage, exact expiry, expired-link rejection and single use.
  The existing password/session integration suite then runs in that same disposable
  database to check the transaction-helper refactor did not break normal auth.
- `tests/browser/first-owner.spec.ts`: mocks available/success/error API responses;
  tests private-input clearing, confirmation, one submission, no storage/token
  links, disabled workspace and iPhone-sized layout. Never provisions a real account.
- `npm run check`, `npm run build`, and default `NODE_ENV=test npm test`.

Do not change the normal `DATABASE_URL`, run a provisioning command in the workspace,
add deployment hooks, or use a development account as evidence of production access.
