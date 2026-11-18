# AVNI conversation runtime migration draft

`supabase/migrations/20261118_avni_conversation_runtime_v1.sql`,
`supabase/migrations/20261118_avni_conversation_runtime_v2_preflight.sql` are unapplied,
review-only migration drafts. They were not run against Supabase, Development,
or Production. Their verification suite uses only a disposable
loopback PostgreSQL cluster created by the explicit
`script/test-crm-persistence.ts --run-isolated-ephemeral-postgres
--suite=avni-conversation-runtime` command.

`migrations/0019_avni_dispatch_grants.sql` and
`migrations/0020_avni_dispatch_authorization_fence.sql` are also drafts and
have not been applied. They add a Replit consent epoch and reference/hash-only
dispatch-grant ledger, then bind grants to an active LMS actor and assignment.
They are not in the Drizzle journal because the repository's manual post-0012
migration chain must be reconciled before enabling them through the normal
migration runner. Migration 0019 deliberately grants no runtime table access;
0020 is required for the ownership/ACL hardening and constrained application
role grant. Do not apply 0019 alone.

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

The claim RPC only leases bounded work; it does not authorize sending. The
final `begin_conversation_send` RPC has no caller-supplied consent boolean and
atomically checks the current lease, attempt, control version, AI ownership,
open/mapped thread, and exact queued message, idempotency key, and payload hash.
It only claims assistant-authored AI work; human-authored outbox rows are never
claimable until a separate trusted human-send authorization boundary exists.
Replit must hold its consent-row/grant transaction while invoking that fixed
Supabase RPC. A successful `begin_send` is the in-flight linearization point.
Provider-observed outbound messages are recorded as `unknown`, never `queued`,
and that ingress path creates no outbox item. An expired `claimed` lease is
retryable; an expired `sending` lease becomes `unknown` and is not blindly
retried. The SQL cannot independently query Replit PostgreSQL. No provider
sender, transport route, or credential is installed by this migration.

The Replit database trigger, not an application caller, owns `consent_epoch`.
It advances the epoch for effective consent/opt-out transitions and consent
metadata/version changes, and revokes unused `issued` grants in the same
transaction. The Replit coordinator locks the active LMS actor, current roles,
canonical lead, assignment, consent preference, then grant; it refreshes the
database clock after locks. Each grant binds that actor/role and exact
assignment version as well as the canonical Replit lead, Supabase
thread/outbox/message/attempt, consent epoch, conversation control version,
attempt number, lease-token hash, idempotency key, payload SHA-256, and bounded
expiry. Redemption rechecks actor activity/role, assignment, lead, and consent
under locks before calling the fixed Supabase `begin_send` callback. It checks
database time again after the callback; an ambiguous or late result becomes
unknown and is not blindly retried. This is not distributed ACID: if Supabase
commits `begin_send` but the Replit commit or response is lost, the protocol
must stop and reconcile; no provider call is made by this implementation.

Human takeover increments the control version and cancels pending or claimed
assistant outbox rows in the same transaction. If takeover wins before
`begin_send`, the send is denied. If `begin_send` wins first, a later takeover
blocks future work but cannot recall an already in-flight provider request.
Likewise, a later consent revocation/opt-out invalidates future grants but
cannot guarantee recall of a request that crossed the in-flight boundary. This
is an explicit policy requiring owner approval before live sending is enabled.
The migration does not create a provider sender or enable any messaging.

## Access and rollout prerequisites

- The migration creates two `NOLOGIN`, `NOINHERIT`, non-superuser,
  non-`BYPASSRLS` roles: `aichm_conversation_owner` and
  `aichm_conversation_runtime`. The owner owns only these seven private tables
  and their RPCs; forced RLS has a policy only for that non-login owner. The
  owner has no memberships or schema `CREATE` after migration. The runtime role
  receives schema `USAGE` and narrowly scoped `EXECUTE` for event, thread,
  enqueue, claim, begin-send, and send-result RPCs, not table or sequence
  privileges. The control-transition RPC remains owner-only; generic runtime
  credentials cannot assert an LMS actor. No password, login, secret, service
  credential, or role membership is created.
- `anon`, `authenticated`, `service_role`, and `aichm_crm_reader` receive no
  direct privilege on the seven new tables and no execute privilege on the
  write RPCs. RLS is enabled with no client policies. `service_role` is not
  granted the new runtime functions.
- The migration revokes table and function ACLs from all pre-existing database
  roles except the owner, re-grants only the runtime RPC boundary, and
  postconditions reject any unexpected table/function ACL. Runtime membership
  must be a direct, explicitly approved membership with `admin_option=false`;
  unexpected or broad role membership is a readiness failure.
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

## Replit preflight and dispatch protocol boundary

`server/crm/avni-conversation-authorization.ts` is a server-only adapter, not an
HTTP route. It reads actor identity only from the authenticated LMS session,
reloads active status and current role rows, applies the existing canonical
assignment predicate, locks and checks the canonical lead and contact
preference rows, then calls the dedicated read-only Supabase preflight RPC.
The Supabase reader role is used; no writer connection or service credential is
introduced. The public adapter result contains only a safe status/code,
conversation mode/version, and the constant `sendAuthorized: false`; it never
returns lead, Supabase, or thread identifiers.

`server/crm/avni-conversation-control.ts` is also a server-only capability, not
an HTTP route. It derives control actor identity from the current CRM session,
reloads active user/role/assignment and consent for the exact crosswalk, and
hands only server-derived control intent to an injected persistence adapter.
No browser or n8n control route exists. Resume fails closed without current
granted consent and no explicit opt-out. The draft Supabase control RPC is not
granted to the generic runtime role until that trusted adapter is connected
through a separately reviewed server-only writer boundary. This is not a
delivery path.

This is intentionally only a preflight. It does not enqueue, claim, mutate a
conversation, or contact a provider. The preflight result is never permission
to send. The separate local grant protocol below models the cross-database
boundary, but it is not wired to a live Supabase writer or provider. The
background `avni-followup-reader` capability remains separate and cannot call
this interactive adapter or read the grant ledger.

The local dispatch protocol is separate from that preflight. Its in-transaction
grant helpers require current consent and epoch, and a supplied fixed
`begin_send` callback. They return `providerCallAllowed: false` in every case;
no route or caller wires them to a provider. The `N8N_AVNI_FOLLOWUP_READ_SECRET`
candidate-read capability is not broadened and cannot access grants or send.
The server-only keyed HMAC boundary for provider references remains a hard
prerequisite; no key or adapter is created here.

The Replit-only migration `0020` also requires the existing
`aichm_crm_owner`, `aichm_app_runtime`, and `aichm_app_login` roles with their
safe source-defined attributes. It assigns the dispatch ledger to
`aichm_crm_owner`, allows only `aichm_app_runtime` SELECT/INSERT/UPDATE, and
requires exactly one non-admin membership (`aichm_app_login` -> runtime) with
no other runtime/login memberships. Unexpected direct ACLs abort the migration;
it does not provision or repair any roles or credentials.

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
its created roles and objects atomically in the disposable database. The
Replit-side focused PostgreSQL test applies migrations 0019 and 0020 only to
the socket-only throwaway CRM database, verifies trigger-owned epoch increments,
direct-SQL grant invalidation, actor/assignment revalidation, lock-wait expiry,
and rollback, using synthetic records. The Supabase suite uses its separate
disposable loopback cluster and includes lock-wait lease expiry, takeover,
receipt ordering, human-outbox exclusion, role/ACL postconditions, and injected
rollback. Tests do not call live Supabase or a provider. A fake transport
acceptance/crash is represented only as a state-machine result; no transport is
installed.
