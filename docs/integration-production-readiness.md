# CRM, AVNI, and Meta integration readiness

This is a source-level readiness contract. It does not claim that Production
credentials, external permissions, migrations, or provider behavior have been
verified.

## Replit CRM database

- Production must provide `AICHM_APP_DATABASE_URL`. Startup fails with the
  stable code `APP_DATABASE_URL_REQUIRED` rather than falling back to the
  platform `DATABASE_URL`.
- The application URL must match the internal host, port, database, and
  transport policy referenced by `DATABASE_URL`, and use a distinct login
  name.
- Startup verifies the connected role, database, primary/read-write state,
  required CRM privileges, and the single non-admin group membership. It
  rejects unsafe role attributes, extra memberships, role-admin membership,
  and a broad or incorrectly configured `aichm_app_runtime` group.
- The admin readiness endpoint reports the mode and whether this startup check
  passed. If startup fails, the server does not expose application routes.

## AVNI

- CRM counselling submission, lead context/upsert, consent/opt-out, follow-up
  controls, and bounded read-only due-candidate lookup remain on their existing
  authenticated Replit routes.
- CRM conversation history remains a read-only Supabase reader. The admin
  panel can explicitly run its reader diagnostic; that check uses a restricted
  session, catalog/privilege queries, and synthetic empty lookups only.
- No Supabase runtime writer is attached. The conversation runtime SQL files
  are drafts and the required non-login owner/runtime-login rollout has not
  been verified. Do not treat a present runtime URL as proof of a valid
  least-privilege writer.
- The pilot route is code-level disabled. Its Evolution HTTP client is not
  proof of the deployed provider contract, and no request is sent by readiness
  checks. Automated follow-up/campaign execution state in n8n is outside this
  application's source and is not verified here.
- A future server-only HMAC provider may be configured with
  `AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_JSON`, a strict JSON object shaped like:

  ```json
  {
    "activeKeyId": "key-2026-a",
    "keys": [
      { "keyId": "key-2026-a", "keyBase64": "<base64-encoded random key>" }
    ]
  }
  ```

  Each decoded key must be 32–256 bytes; IDs must be unique and bounded; the
  active key must be retained. During rotation, keep old keys in the ring until
  aliases created with them are no longer required. The application does not
  generate or provision keys. No browser or n8n caller supplies key material.

## Meta Lead Ads

- The current webhook remains `POST /api/webhooks/meta/leadgen`; its raw-body
  signature validation, configured Page check, Graph lead fetch, phone aliases,
  canonical phone matching, and Meta lead-ID idempotency are unchanged.
- An admin can manually invoke `GET /api/admin/meta/lead-ads-diagnostics`.
  It performs only Graph reads for token/Page identity (`/me`), Page app
  subscription, and a one-form access probe. It never subscribes, fetches lead
  submissions, or returns Page/app/form IDs, names, or credential values.
- The integrated admin panel distinguishes configuration presence from those
  live checks. Graph version format can be checked without a provider call;
  token/Page identity and permissions are unverified until the explicit
  read-only check is run.

## Current safety boundary

Readiness routes are admin-only and non-cacheable. They return booleans, safe
reason codes, and (for Meta Graph failures) allowlisted numeric error metadata.
They do not authorize provider sends. This code update applies no migration
and backfills no data; live Production migration state is not asserted here.
Startup and normal page load make no Meta or Evolution calls.
