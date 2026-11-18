# AVNI conversation runtime migration draft

`supabase/migrations/20261118_avni_conversation_runtime_v1.sql` and
`supabase/migrations/20261118_avni_conversation_runtime_v2_preflight.sql` are unapplied,
review-only migration drafts. They were not run against Supabase, Development,
or Production. Their verification suite uses only a disposable
loopback PostgreSQL cluster created by the explicit
`script/test-crm-persistence.ts --run-isolated-ephemeral-postgres
--suite=avni-conversation-runtime` command.

## Scope and ownership

- `aichm_private` is not a PostgREST-exposed schema. Seven normalized tables
  hold threads, provider events, messages, outbox rows, send attempts,
  delivery receipts, and control audit events.
- Admissions identity and WhatsApp consent/opt-out remain authoritative in
  Replit PostgreSQL. Supabase stores only the nullable exact `public.leads.id`
  cross-link. Provider event/thread/message/receipt references are accepted by
  the SQL draft only as `hmac-sha256:v1:<hex>` tokens. The SQL checks token
  shape; it cannot prove a caller actually computed an HMAC. No HMAC adapter or
  key has been added because there is no approved server-only key boundary for
  it. A keyed, domain-separated server HMAC adapter is a hard prerequisite
  before any event can be persisted. Raw provider IDs, remote JIDs, phone
  numbers, and provider media IDs must never be passed to persistent columns.
  Media pointers are restricted to app-owned `media:v1:<uuid>` references.
- Foreign keys do not cascade transcript deletion; mapped lead/thread deletion
  is restricted until a separately reviewed retention/deletion policy exists.
- New threads start unmapped and human-owned. Mapping uses an exact existing
  Supabase lead/crosswalk, never a phone guess. Unmapped, ambiguous, held,
  closed, stale-version, and mismatched-ownership cases fail closed.
- The migration does not update the existing legacy CRM history RPC or any
  legacy rows. The old read-only CRM result is asserted byte-for-byte stable in
  the disposable integration fixture. No new normalized transcript is exposed
  to the existing CRM UI until a separate, reviewed reader cutover can prove
  legacy/new deduplication.

## Delivery and dispatch boundary

The normalized canonical receipt vocabulary is `queued`, `sent`, `delivered`,
`read`, `failed`, and `unknown` in both the TypeScript contract and this draft.
Provider receipt labels are kept separately in a bounded
`raw_provider_state`; only the normalized enum affects state. Per-attempt state
is monotonic: stale receipts remain auditable but do not regress the current
attempt or message. Retries use a new attempt number. `sent` means the provider
accepted the send; it is not reported as delivered.

The claim and final authorization RPCs compare the queue's control version,
thread mode, open lifecycle, mapping, lease, and a caller-supplied
`p_whatsapp_send_allowed` assertion. The assertion must come from a fresh,
server-side Replit consent/opt-out check, never from a client or provider
  payload. Provider-observed outbound messages are recorded as `unknown`, never
  `queued`, and that ingress path creates no outbox item. An expired `claimed`
  lease is retryable; an expired `sending` lease becomes `unknown` and is not
  blindly retried. The SQL cannot independently query Replit PostgreSQL; no live sender,
  transport route, or credential is installed by this migration. Until a trusted
Replit authorization layer and least-privilege database login are separately
provisioned, no runtime can execute the RPCs.

Human takeover increments the control version and cancels pending or claimed
assistant outbox rows in the same transaction. A sending/accepted message is
not recalled. Final send authorization must occur immediately before a future
provider call. Resume is compare-and-swap and requires a server-verified
granted-consent/non-opted-out assertion. The migration does not create a
provider sender or enable any messaging.

## Access and rollout prerequisites

- The migration creates two `NOLOGIN`, `NOINHERIT`, non-superuser,
  non-`BYPASSRLS` roles: `aichm_conversation_owner` and
  `aichm_conversation_runtime`. The owner owns only these seven private tables
  and their RPCs; forced RLS has a policy only for that non-login owner. The
  owner has no memberships or schema `CREATE` after migration. The runtime role
  receives schema `USAGE` and narrowly scoped `EXECUTE`, not table or sequence
  privileges. No password, login, secret, service credential, or role
  membership is created.
- `anon`, `authenticated`, `service_role`, and `aichm_crm_reader` receive no
  direct privilege on the seven new tables and no execute privilege on the
  write RPCs. RLS is enabled with no client policies. `service_role` is not
  granted the new runtime functions.
- A separate runtime-readiness check accepts only one explicitly approved
  `LOGIN` role as a direct member of the runtime capability, with no other
  memberships and no superuser, `BYPASSRLS`, create, replication, or inherit
  attributes. It does not grant membership or create a login. No runtime login
  has been provisioned. Do not reuse the broad Supabase `service_role` or give
  n8n a database credential.
- Before any live application, independently verify the existing 20261107
  contract and `public.leads.replit_lead_id` unique mapping on the intended
  Supabase primary. This draft does not infer that the old preparation SQL is
  applied.
- The ordered 20261118 v2 preflight extension grants the NOLOGIN conversation owner
  column-level `SELECT` on only `public.leads.id` and
  `public.leads.replit_lead_id`, plus a policy limited to rows with a non-null
  crosswalk when RLS is enabled. Its stable, fixed-search-path RPC accepts only
  the server-resolved Replit lead UUID and expected control version, resolves
  the exact crosswalk internally, and returns safe state plus an internal
  thread reference to the dedicated CRM reader role. The reader still has no
  direct table access. The app adapter strips all IDs from its result.
- Apply only after a separate reviewed schema diff, role review, backup/
  recovery plan, and explicit owner approval. Do not backfill or dual-write
  legacy `public.conversations` as part of this draft.
- The RPC layer is not the CRM authorization layer. Before invoking it, the
  trusted Replit server must re-check the authenticated staff actor, current
  assignment/ownership scope, canonical CRM-to-Supabase lead crosswalk,
  WhatsApp consent, opt-out, and any required rate limits. Client fields and
  provider webhook claims about actor, assignment, consent, or opt-out are
  never authoritative. These checks are not implemented by the SQL draft.

## Replit preflight adapter boundary

`server/crm/avni-conversation-authorization.ts` is a server-only adapter, not an
HTTP route. It reads actor identity only from the authenticated LMS session,
reloads active status and current role rows, applies the existing canonical
assignment predicate, locks and checks the canonical lead and contact
preference rows, then calls the dedicated read-only Supabase preflight RPC.
The Supabase reader role is used; no writer connection or service credential is
introduced. The public adapter result contains only a safe status/code,
conversation mode/version, and the constant `sendAuthorized: false`; it never
returns lead, Supabase, or thread identifiers.

This is intentionally only a preflight. It does not enqueue, claim, mutate a
conversation, or contact a provider. The Replit consent check and a Supabase
outbox write/provider call are not atomic across databases. A later sender must
not treat this result as permission to send; a separate cross-database
authorization protocol must be designed and tested first. The background
`avni-followup-reader` capability remains separate and cannot call this
interactive adapter.

## Objects in the draft

The seven private tables are `conversation_threads`,
`conversation_messages`, `conversation_events`, `conversation_outbox`,
`conversation_outbox_attempts`, `conversation_delivery_receipts`, and
`conversation_control_events`. Their unique constraints cover provider event
and message identity, stable idempotency keys, outbox identity, attempt number,
provider message identity, receipt identity, and control request/version.
Queue indexes support due-order and lease-expiry scans. Attempts are capped at
eight; claimed leases are recoverable, while an expired in-flight send is
marked unknown rather than blindly resent.

`assertAvniConversationRuntimePostconditions` checks table/column inventory,
forced RLS and the single owner-only policy per table, indexes, safe role
attributes/ownership, no role memberships, no direct runtime/client DML, no
sequences, and the fixed-search-path `SECURITY DEFINER` owner/execute boundary.
`assertAvniConversationRuntimeReadiness` is a separate, read-only check for a
future explicitly approved runtime login; it rejects missing, duplicate, or
broad memberships and performs no provisioning.

Control request IDs are serialized with transaction advisory locks. Exact
replays return `duplicate`; reuse with different control data returns
`request_id_conflict`. Provider and outbound idempotency keys must match their
HMAC token suffix. Injected failure tests verify the draft migration rolls back
its created roles and objects atomically in the disposable database.
