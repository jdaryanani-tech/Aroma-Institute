# AVNI single-recipient pilot: implementation status

## Safety status

The admin route is registered at `POST /api/admin/integrations/avni/pilot-dispatch`.
The dispatcher object is constructed, but registration passes `enabled: false`
and `supabaseWriter: null`; after session/admin/origin checks and request-shape
validation, the route returns `dispatch_disabled` before database or provider
dispatch work. No message is
sent by the current application. Setting the environment gate alone cannot
override this source-level off switch.

The request is an authenticated CRM admin session, passes the existing same-
origin/CSRF guard, supplies a canonical Replit lead UUID, the approved E.164
recipient, current conversation control version, and a stable UUID
`Idempotency-Key` header. Message text is fixed in server code; the browser
cannot choose it. The recipient must match the explicit server-side pilot
allowlist and the lead's normalized canonical phone. Responses contain only a
status, fixed code and correlation ID.
The durable outbox key is fixed to this pilot and canonical lead, so a second
client idempotency key cannot create a second message for the same lead.

The admin-only, read-only reconciliation route is
`POST /api/admin/integrations/avni/pilot-dispatch/status` with
`{ canonicalLeadId }` and the same `Idempotency-Key` header. It requires the
same admin session and same-origin protection, returns only the persisted
state, attempt number, fixed safe code and correlation ID, and sets no-store.
An `unknown` result is surfaced as `manual_provider_reconciliation_required`;
this route never queries Evolution, changes state or retries. It uses the
existing server-side read-only Supabase pool and the narrowly scoped
`find_human_pilot_outbound` RPC; it remains unavailable until the v3 migration
and reader grant are reviewed and present.

## Implemented server-side boundaries

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
  server-only pilot RPCs, a read-only pilot status grant for the existing
  reader, and control-version cancellation of stale queued messages. It is
  ordered after runtime v1 and read preflight v2. None of the Supabase
  migrations is applied by this work.
- The Evolution adapter accepts an injected transport only. Its server-side
  HTTP client targets the fixed host `https://evo.aromacafeinstitute.in` using
  the source-defined API shape: `POST /message/sendText/{instance}`, `apikey` header,
  JSON `{ number, text }`, and a response `key.id`. E.164 is validated before
  converting the recipient to digits for the request. Redirects are not
  followed, response bodies are size-bounded and never logged, and only
  authentication rejection statuses are definite failures; other HTTP errors,
  malformed responses and timeouts are `unknown`, with no blind retry.
  The deployed Evolution version and its instance/auth configuration have not
  been verified. Its API does not expose a documented idempotency contract in
  this repository/source check; duplicate protection is therefore the durable
  CRM/Supabase outbox key plus terminal handling of unknown outcomes, not a
  claim of provider-side deduplication. No provider receipt callback is
  connected. `accepted` is not a delivered/read claim.
- The Supabase writer accepts injected pools and uses fixed RPCs. No writable
  runtime pool or credential is connected. The existing CRM reader is not
  promoted to a writer.
- HMAC provider-reference signing has a server-only key-ring adapter at
  `server/integrations/avni-provider-reference-hmac-config.ts`. It reads
  `AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_JSON`, validates strict JSON and
  key-material shape, and keeps retained keys available for alias lookup.
  Synthetic keys are used only by tests; no real key is generated, configured,
  or stored. Secure key custody, rotation approval, and Production presence
  remain unverified.

## Configuration names introduced in source

- `AVNI_SINGLE_RECIPIENT_DISPATCH_ENABLED` — explicit boolean gate, default off.
- `AVNI_PILOT_RECIPIENT_E164` — one-recipient allowlist. No value is set here.
- `EVOLUTION_API_KEY` — dedicated Replit secret for the `apikey` header. It
  must not be copied from or read through the n8n credential reference.
- `EVOLUTION_API_INSTANCE` — Evolution instance path segment; no value is set
  here. The API host is fixed in server source, so there is no base-URL variable.
- A reviewed, dedicated Supabase conversation runtime login/pool is still
  required. The source already names `SUPABASE_AVNI_RUNTIME_DATABASE_URL` and
  `SUPABASE_DB_SSL_CA`; those are presence-only readiness names, not proof of
  a correctly scoped login, reachable primary, or valid TLS configuration.
  No writer pool is created and no values are read or changed here.
- `AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_JSON` is the source-defined key-ring
  name. No value or key is supplied here. Configure it only through the
  workspace secret manager after owner approval; never place it in browser or
  n8n configuration.
- Admin readiness reports presence/shape only where the server can safely
  parse configuration. It does not establish Production secret validity,
  database identity, Meta permissions, Evolution reachability, or workflow
  state.
- The app cannot consume an n8n Header Auth credential by reference. The
  dedicated Replit secret above is required; the n8n secret was not accessed.
- The dispatcher is hard-disabled in server registration as well as gated by
  `AVNI_SINGLE_RECIPIENT_DISPATCH_ENABLED`. The server also passes no
  `supabaseWriter`. Even if the HTTP transport, gate, recipient allowlist, and
  HMAC configuration are present, queueing and sending remain unavailable.

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
