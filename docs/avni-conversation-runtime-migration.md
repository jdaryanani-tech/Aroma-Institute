# AVNI conversation runtime migration draft

`supabase/migrations/20261118_avni_conversation_runtime_v1.sql` is an
unapplied, review-only migration draft. It was not run against Supabase,
Development, or Production. Its verification suite uses only a disposable
loopback PostgreSQL cluster created by the explicit
`script/test-crm-persistence.ts --run-isolated-ephemeral-postgres
--suite=avni-conversation-runtime` command.

## Scope and ownership

- `aichm_private` is not a PostgREST-exposed schema. Seven normalized tables
  hold threads, provider events, messages, outbox rows, send attempts,
  delivery receipts, and control audit events.
- Admissions identity and WhatsApp consent/opt-out remain authoritative in
  Replit PostgreSQL. Supabase stores only the nullable exact `public.leads.id`
  cross-link. New provider thread keys must be a server-computed keyed hash;
  raw WhatsApp remote JIDs/phone numbers are not stored in the thread index.
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
payload. The SQL cannot independently query Replit PostgreSQL; no live sender,
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

- The migration creates only the `NOLOGIN` role
  `aichm_conversation_runtime`; it creates no password, login, secret, or
  service credential. It grants that role `USAGE` on the private schema and
  `EXECUTE` on the narrowly scoped RPCs, not direct table/sequence DML.
- `anon`, `authenticated`, `service_role`, and `aichm_crm_reader` receive no
  direct privilege on the seven new tables and no execute privilege on the
  write RPCs. RLS is enabled with no client policies. `service_role` is not
  granted the new runtime functions.
- A future DBA-reviewed setup must decide which authenticated Replit server
  login, if any, receives membership in the `NOLOGIN` runtime role. Do not
  reuse the broad Supabase `service_role` or give n8n a database credential.
- Before any live application, independently verify the existing 20261107
  contract and `public.leads.replit_lead_id` unique mapping on the intended
  Supabase primary. This draft does not infer that the old preparation SQL is
  applied.
- Apply only after a separate reviewed schema diff, role review, backup/
  recovery plan, and explicit owner approval. Do not backfill or dual-write
  legacy `public.conversations` as part of this draft.

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
RLS and absence of policies, indexes, the `NOLOGIN` role, no direct DML, and
the fixed-search-path `SECURITY DEFINER` function/execute boundary.
