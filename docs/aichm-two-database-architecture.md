# AICHM two-database ownership contract

This workspace architecture note is not live verification. Historical
preparation records document an additive empty-schema Supabase stage; current
Supabase catalog state, data-copy state, deployment, and routing must be
verified from fresh evidence before any operational decision.

## Ownership

- Replit PostgreSQL owns operational AICHM records: admissions leads,
  enquiries, VSL registration/progress, counselling submissions, LMS and
  Calendar state. Production runtime uses the least-privilege
  `AICHM_APP_DATABASE_URL`; it does not fall back to `DATABASE_URL`.
- Supabase owns AVNI's WhatsApp transcript and provider-delivery records,
  AI-interaction logs, conversation summary/memory, and `course_knowledge`.
  Existing `public.leads` is a conversation identity/index, not a second CRM.
- n8n remains the orchestrator and writes conversation history/knowledge to
  Supabase. Evolution API remains the WhatsApp delivery provider.
- `SUPABASE_DATABASE_URL` is reserved for migration tooling. It must not be used
  by the application runtime or CRM history reader.

## Stable identity and linking

`admissions_leads.id` is the permanent Replit UUID. The authenticated
`POST /api/integrations/n8n/leads/upsert` response returns it as `leadId`.
n8n must save this UUID in `public.leads.replit_lead_id` for the conversation
participant it has actually resolved. The proposed Supabase migration adds a
partial unique index so one canonical Replit lead cannot be attached to two
Supabase lead-index rows.

No automatic backfill is included. Existing records without that value remain
unlinked. A unique or ambiguous phone candidate is a review item, not proof of
identity; the read-only legacy planner never assigns it.

## Replit integration contracts

All n8n requests use `x-aichm-webhook-secret`, checked against the
server-only `N8N_VSL_REGISTRATION_WEBHOOK_SECRET`. It is never returned or
logged. The request rate limiter remains in Replit PostgreSQL.
The existing outbound counselling-form delivery continues to use its separate
`N8N_COUNSELLING_WEBHOOK_URL` / `N8N_COUNSELLING_WEBHOOK_SECRET` settings and is
unchanged by this workspace update.

- `GET /api/integrations/n8n/health`: Replit operational API readiness and
  whether the Supabase read-only CRM reader is configured.
- `POST /api/integrations/n8n/leads/upsert`: normalize the Indian mobile,
  resolve/create the canonical Replit lead, and return its UUID plus minimal
  VSL/questionnaire context. It does not save a transcript.
- `POST /api/integrations/n8n/leads/lookup`: normalized-phone operational
  lookup. `GET /api/integrations/n8n/leads/:leadId/status` and
  `GET /api/integrations/n8n/leads/:leadId/context` read the authoritative VSL
  milestones, saved questionnaire answers/status, and contact consent.
  Enrollment and payment are explicitly reported unavailable until a verified
  source and safe lead-to-student relation exist; no payment source is inferred.
- `GET /api/integrations/n8n/counselling/questions`,
  `POST /api/integrations/n8n/counselling/validate-answer`,
  `POST /api/integrations/n8n/counselling/submit`, and
  `POST /api/integrations/n8n/leads/:leadId/counselling` use the same secret
  header. Assisted submissions save validated answers to Replit through the
  same canonical inquiry persistence path as the public form.
- Existing Calendar availability/booking/reschedule/cancel routes remain
  Replit-owned: `GET /api/integrations/n8n/calendar/availability`,
  `POST /api/integrations/n8n/calendar/bookings`,
  `PATCH /api/integrations/n8n/calendar/bookings/:bookingId`, and
  `POST /api/integrations/n8n/calendar/bookings/:bookingId/cancel`. Booking
  requires eligible VSL/form records, an idempotency key, and a
  Supabase-verified inbound confirmation message reference before its Replit
  transaction commits.

The former Replit conversation write/read routes now return `410` after
integration authentication. They do not accept message bodies, delivery
updates, or transcript reads. CRM conversation history is a separate,
admin-authorized, read-only view from Supabase.

## Supabase CRM history reader

The workspace-only Supabase migration adds:

- `public.leads.replit_lead_id` and a partial unique index.
- Separate inbound/outbound provider-message IDs and delivery states on
  `public.conversations`; existing transcript rows are not rewritten.
- RLS-protected `public.conversation_memory` and
  `public.ai_interaction_logs` tables for Supabase/n8n ownership.
- Two fixed-search-path security-definer functions in the non-API
  `aichm_private` schema: one returns a single linked lead's paginated
  conversation entries; one verifies a typed inbound booking/cancellation
  confirmation without returning message text.
- A dedicated `aichm_crm_reader` role with no direct table privileges, granted
  execution of those two private-schema functions. It has no direct table or
  sequence grants, no `BYPASSRLS`, and a read-only default transaction.

Before CRM history or Calendar confirmation checks can work, apply the
reviewed Supabase migration separately, set a password for that dedicated role
in Supabase, and place its URI in the server-only Replit Secret
`SUPABASE_AVNI_READONLY_DATABASE_URL`. It must use the approved Supavisor host
and port, `sslmode=require`, and `SUPABASE_DB_SSL_CA`; the Node pool enforces
certificate-chain and hostname verification and sets every session
`default_transaction_read_only=on`. Do not use `SUPABASE_DATABASE_URL` for this
purpose. The credential must not be exposed to browser code. Before production
use, review Supabase's existing `PUBLIC` function grants for unexpected
security-definer entry points; the migration grants this role no direct table
or sequence access and does not change global function grants.

## Migration/import boundaries

- `migrations/0013_replit_operational_reconciliation.sql` now excludes new
  Replit transcript and course-knowledge tables. Existing legacy structures
  are not dropped or cleaned up.
- `supabase/migrations/20261107_aichm_two_database_contract.sql` is a proposal
  only and is not applied.
- The former Replit-to-Supabase operational data-copy CLI now rejects `--apply`
  under this architecture. Its snapshot/live-dry-run modes remain read-only.
- `npm run aichm:import:legacy` is now an aggregate-only, read-only identity
  reconciliation planner. It counts Supabase conversations and knowledge but
  does not read their bodies or create Replit rows. Any `--apply` attempt fails
  closed. No import has been run for this change.
- Existing Supabase leads/conversations/course knowledge are preserved.

## Required configuration / remaining rollout

Replit Secrets required before full integration verification:

1. `N8N_VSL_REGISTRATION_WEBHOOK_SECRET` — shared n8n/Replit server-to-server
   authentication secret.
2. `SUPABASE_AVNI_READONLY_DATABASE_URL` — only after the dedicated role and
   function grants are reviewed and provisioned in Supabase.
3. Existing `SUPABASE_DB_SSL_CA` is used for strict TLS. The admin
   `SUPABASE_DATABASE_URL` remains migration-only.

The workspace's Calendar migration includes durable jobs, but reminders still
need the approved external scheduler hookup and push VAPID secrets before
notifications are live. Existing fee/scholarship values were not changed or
selected; conflicting course-fee content is flagged for owner review, and
payment/enrollment remain unavailable until a verified operational source is
identified.

Safe next order: review/apply the Supabase schema proposal; set the dedicated
read-only role password and Replit Secret; separately review the updated
Replit migration through the normal schema-change process; update n8n to save
`replit_lead_id` and continue writing transcripts only to Supabase; then run
synthetic API and authenticated CRM history tests before any production
deployment or workflow cutover.
