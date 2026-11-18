# AVNI single-recipient pilot: implementation status

## Safety status

The admin route is registered at `POST /api/admin/integrations/avni/pilot-dispatch`,
but it is deliberately not wired to a dispatcher. Its default feature gate is
off. Even if the gate and allowlisted recipient are configured, the registered
route returns `dispatch_runtime_unavailable` while the server-only adapters are
unconfigured. No message is sent by the current application.

The request is an authenticated CRM admin session, passes the existing same-
origin/CSRF guard, supplies a canonical Replit lead UUID, the approved E.164
recipient, current conversation control version, and a stable UUID
`Idempotency-Key` header. Message text is fixed in server code; the browser
cannot choose it. The recipient must match the explicit server-side pilot
allowlist and the lead's normalized canonical phone. Responses contain only a
status, fixed code and correlation ID.

## Implemented server-side boundaries (not wired)

- Replit authorization resolves the actor only from the current LMS session,
  rechecks active status and the current admin role, validates the lead's
  canonical phone against the approved recipient, checks canonical assignment
  state, and reads current consent, opt-out and `consent_epoch`.
- The existing dispatch-grant transaction holds the Replit consent row lock,
  issues and consumes one scoped grant, and calls the Supabase
  `begin_human_pilot_send` fence. That function checks the human-owned open
  thread, exact outbox/message/attempt, control version, lease and payload
  fingerprint. The successful `begin_send` commit is the in-flight boundary:
  later opt-out or takeover prevents future attempts but cannot recall a
  request already authorized at that boundary.
- Supabase draft migration
  `supabase/migrations/20261118_avni_human_pilot_dispatch_v3.sql` adds
  server-only pilot RPCs and control-version cancellation of stale queued
  messages. It is ordered after runtime v1 and read preflight v2. None of the
  Supabase migrations is applied by this work.
- The Evolution adapter accepts an injected transport only. Its production
  HTTP client is intentionally absent because this repository does not define
  the deployed Evolution endpoint, authentication/header format, request body,
  idempotency guarantees, or authoritative definite-rejection responses.
  Timeouts and ambiguous results are `unknown`; they are never blindly retried.
  No provider receipt callback is connected by this feature. `accepted` means
  only that a future transport reports provider acceptance; it is not a
  delivered/read claim.
- The Supabase writer accepts injected pools and uses fixed RPCs. No writable
  runtime pool or credential is connected. The existing CRM reader is not
  promoted to a writer.
- HMAC provider-reference signing requires an injected key ring. Synthetic
  keys are used only by tests; no real key is generated, configured or stored.

## Configuration names introduced in source

- `AVNI_SINGLE_RECIPIENT_DISPATCH_ENABLED` — explicit boolean gate, default off.
- `AVNI_PILOT_RECIPIENT_E164` — one-recipient allowlist. No value is set here.
- A reviewed, dedicated Supabase conversation runtime login/pool is still
  required. The source already names `SUPABASE_AVNI_RUNTIME_DATABASE_URL` and
  `SUPABASE_DB_SSL_CA`; those are presence-only readiness names, not proof of
  a correctly scoped login, reachable primary, or valid TLS configuration.
  No writer pool is created and no values are read or changed here.
- A secure server-only HMAC key-provider integration and key-ID rotation policy
  remain prerequisites. No key name or value is invented here; the owner must
  approve a workspace-managed secret contract before a provider key source is
  wired.
- The Evolution API URL, credential name/header, request shape and response
  contract are not specified by this repository. No Evolution configuration
  names are invented; obtain the deployment's documented contract first.

## Required before a controlled send can be considered

1. Review and apply, through the approved Supabase rollout process, the
   conversation runtime migrations in order: v1, v2 preflight, then v3 pilot.
   Verify primary-target catalog postconditions and the dedicated runtime role
   before wiring a writer pool. The Replit grant/consent boundary also requires
   its separate CRM migrations `migrations/0019_avni_dispatch_grants.sql` and
   `migrations/0020_avni_dispatch_authorization_fence.sql`; their live
   application state has not been checked by this source-only work.
2. Obtain and verify the Evolution deployment's exact endpoint, auth contract,
   request/response format, idempotency behavior, timeout semantics and
   definite rejection classification. Implement it behind the injected
   transport and test ambiguous acceptance with no retries.
3. Wire a dedicated, least-privilege Supabase runtime writer and the approved
   HMAC key provider using workspace-managed secrets. Do not use `service_role`
   or the read-only CRM pool.
4. Obtain separate owner approval of the in-flight boundary and the exact
   recipient/message before enabling any send. This code-only work does not
   itself authorize dispatch.
5. Keep the gate off until all prerequisites pass and the admin confirms the
   pilot. This implementation did not perform that confirmation, send a
   provider request, or change production.
