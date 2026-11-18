# AICHM operational database and AVNI integration

Updated 2026-11-07. This is a historical workspace implementation note, not
evidence of current production state. Production runtime connection selection
has since changed as described below.

## Database boundary

- At the time this note was written, the normal `pg.Pool` and Drizzle
  connection used `DATABASE_URL`. Current Production code requires
  `AICHM_APP_DATABASE_URL`, verifies its distinct least-privilege role, and
  fails closed rather than falling back to `DATABASE_URL`.
- The app's runtime does not import the Supabase connection factory.
  `server/db/supabase-migration.ts` is only used by opt-in migration/import code.
- Production catalog inspection found the 34 existing application tables:
  `admissions_capture_limits`, `admissions_crm_activities`,
  `admissions_crm_profiles`, `admissions_leads`, `admissions_vsl_events`,
  `admissions_vsl_playbacks`, `counselling_delivery_attempts`, `inquiries`,
  `lms_assessment_attempts`, `lms_assessment_options`,
  `lms_assessment_questions`, `lms_assessment_versions`, `lms_assessments`,
  `lms_attendance`, `lms_audit_logs`, `lms_auth_rate_limits`,
  `lms_certificates`, `lms_chapters`, `lms_courses`, `lms_enrollments`,
  `lms_invitation_codes`, `lms_invitation_redemptions`,
  `lms_lesson_progress`, `lms_lessons`, `lms_live_sessions`, `lms_modules`,
  `lms_notifications`, `lms_otp_challenges`, `lms_password_setup_tokens`,
  `lms_resources`, `lms_trainer_assignments`, `lms_user_roles`, `lms_users`,
  and `sessions`.
- Production's Drizzle ledger records only migrations `0000`-`0002`, despite
  many later application tables being present. Do not replay missing historical
  migrations blindly. The new additive reconciliation is
  `migrations/0013_replit_operational_reconciliation.sql`.
- The latest inspected production schema did not contain the VSL observed
  progress fields, counselling idempotency/source fields, conversation-history
  table, or any Calendar tables. Routes detect missing schema and fail closed.
  No production DDL or data changes were made.

## AVNI contract

All integration endpoints use exactly one request header:
`x-aichm-webhook-secret`, compared against the server-only
`N8N_VSL_REGISTRATION_WEBHOOK_SECRET`. Comparison is timing-safe. Missing
configuration returns a generic 503; values are never sent to the client or
logged. Current production secret-name inspection found
`N8N_VSL_REGISTRATION_WEBHOOK_SECRET` and
`N8N_VSL_REGISTRATION_WEBHOOK_URL` absent.

- `POST /api/integrations/n8n/leads/lookup` (existing): normalized-phone
  identity/status lookup, including already-saved questionnaire state.
- `GET /api/integrations/n8n/leads/:leadId/status` (existing): stable-ID
  status lookup.
- `POST /api/integrations/n8n/leads/upsert`: creates/reuses the canonical
  `admissions_leads` identity and one CRM inquiry anchor; does not mark VSL
  registration or completion.
- `POST /api/integrations/n8n/conversations/messages`: idempotently persists
  an inbound or pending outbound WhatsApp message before provider delivery.
- `PATCH /api/integrations/n8n/conversations/messages/:messageId/delivery`:
  records final outbound sent/failed state.
- `GET /api/integrations/n8n/leads/:leadId/conversations` and
  `POST /api/integrations/n8n/conversations/read`: read the saved chronological
  conversation history. Message content is available only to the authenticated
  server-to-server integration or the authorized CRM detail API.
- Existing `/api/integrations/n8n/counselling/*` endpoints remain in place and
  continue to use the existing questionnaire validation/persistence path.

All these endpoints use Replit PostgreSQL. Phone input is normalized to the
n8n convention `91` + ten Indian digits. The form's existing 29-question
schema and separate contact consent are unchanged.

## Calendar booking contract

The new server-to-server routes use the same secret header and require:
verified stored VSL completion, a saved completed questionnaire, a persisted
inbound `booking_confirmation` message, and an active `admin` or `admissions`
staff member. Availability is computed from staff schedules, exceptions,
existing Calendar events, resources, and scheduled LMS sessions. Booking,
rescheduling, cancellation, attendee links, Calendar audit, CRM booking
evidence, and durable reminder jobs are committed in one PostgreSQL
transaction. Stable idempotency records preserve command results across
retries. Lead and inquiry overlap locks prevent a prospect being double-booked.
Questionnaire date/time preferences are never considered confirmed bookings.

Paths:

- `GET /api/integrations/n8n/calendar/availability`
- `POST /api/integrations/n8n/calendar/bookings`
- `PATCH /api/integrations/n8n/calendar/bookings/:bookingId`
- `POST /api/integrations/n8n/calendar/bookings/:bookingId/cancel`

The CRM displays saved conversation messages and Calendar booking evidence
only when their tables exist. Calendar push keys are configured with
`AICHM_VAPID_PUBLIC_KEY` and `AICHM_VAPID_PRIVATE_KEY`; both names were absent
in the latest production secret-name check. The durable runner command exists
(`npm run calendar:run-reminders`), but no reliable scheduled invocation is
configured by this change.

## Legacy Supabase import

`server/db/supabase-legacy-import.ts` contains pure, synthetic-testable mapping
and reconciliation rules. `server/db/supabase-legacy-import-runner.ts` and
`script/aichm-import-supabase-legacy.ts` provide a default read-only dry-run
planner and an opt-in batched import path. The Supabase factory enforces the
approved project and strict TLS. At the time of this 2026-11-07 note, the
target pool used `DATABASE_URL`; current Production runtime requires
`AICHM_APP_DATABASE_URL`. The tool does not write to Supabase.

The latest read-only Supabase inventory available to this workspace recorded
31 `public.leads`, 301 `public.conversations`, and 54
`public.course_knowledge` rows. These counts are historical, not re-probed by
this change. The new planner has not been run against live records.

Lead matching rules:

1. An exact source ID plus exact canonical phone can be linked automatically.
2. No phone match is an insert candidate with the source UUID preserved.
3. A unique phone match is review-required, never an automatic merge.
4. Multiple phone matches, invalid phones, and ID/phone conflicts are held for
   human review. If a distinct person shares an existing unique phone, the
   current `admissions_leads.canonical_phone` uniqueness prevents a second
   canonical record; keep that source lead and its conversations held until an
   explicit identity-model decision.
5. Conversation rows retain their Supabase source ID and side (`message` or
   `ai_response`); historical outbound delivery is marked `unknown`, not
   falsely `sent`. Knowledge rows preserve the original UUID and are never
   overwritten; source-ID or slug collisions are skipped/reported.

Import apply requires `--apply`, a signed reviewed reconciliation manifest
verified with `AICHM_MIGRATION_APPROVAL_PUBLIC_KEY`, and the disabled
`AICHM_SUPABASE_LEGACY_IMPORT_ENABLED=true`, `NODE_ENV=production`, plus
`AICHM_SUPABASE_LEGACY_IMPORT_TARGET=production` gates. It checks distinct
source/target identities, required schema, and explicit decisions before
opening a target transaction. It is not enabled or executed in this task.

## Configuration and release gates

Historical 2026-11-07 production secret-name presence check: missing
`N8N_VSL_REGISTRATION_WEBHOOK_SECRET`, `N8N_VSL_REGISTRATION_WEBHOOK_URL`,
`N8N_VSL_DISPATCH_ENABLED`, `AICHM_VAPID_PUBLIC_KEY`, and
`AICHM_VAPID_PRIVATE_KEY`. No secret values were read.

The migration/deployment and untouched-data statements below record the
2026-11-07 audit only; they do not establish current live state. Replit's
managed production schema changes require the reviewed Publish schema diff;
do not run `npm run db:migrate` against an unreconciled production ledger.
Recheck current deployment and Supabase records through an approved read-only
path before relying on this historical snapshot.

The existing app mentions Aroma LEAP fee/scholarship details in its current
counselling copy. This change does not edit or select new course fees or
scholarship amounts; no fee source was imported or reconciled.
