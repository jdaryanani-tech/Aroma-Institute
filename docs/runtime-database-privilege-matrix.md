# Runtime PostgreSQL privilege matrix

## Scope and rollout boundary

This is a static inventory of application SQL issued through the shared pool in
`server/db.ts`, plus the `connect-pg-simple` session store that uses that pool.
It does not describe live grants, table ownership, RLS state, or the current
runtime login; those require a later read-only Development check. The previous
Development preflight is historical evidence that the CRM forward connection
used `postgres` and that its username matched the then-current `DATABASE_URL`
username. It is not proof of today's credentials or grants.

No runtime DDL is required. The session store is configured with
`createTableIfMissing: false`; schema changes belong to the separate migration
operator. No application `TRUNCATE` operation was found. Built-in PostgreSQL
functions used by the app include advisory-lock and timestamp/UUID functions;
no app-owned database function is called by the ordinary application path
except the planned assignment function in migration 0016.

`SELECT` is necessary for list/detail/authorization checks, not a grant of
human-user authorization. CRM visibility still must be scoped in server code
from `req.lmsUser`; the shared application DB role cannot identify the
individual human user on its own.

## Table operations

Operations below describe actual application behavior found by static review.
An operation not listed is not required by the inspected code and should not be
granted by the role migration. `UPSERT` means `INSERT` plus `UPDATE` on a
conflict path.

| Table | Required operations | Feature and representative source |
|---|---|---|
| `sessions` | SELECT, INSERT, UPDATE, DELETE | Express session persistence and expired-session cleanup; `server/lms/auth.ts`, `connect-pg-simple` 10.0.0 (`SELECT`, `INSERT … ON CONFLICT DO UPDATE`, touch `UPDATE`, expired-row `DELETE`) |
| `inquiries` | SELECT, INSERT, UPDATE | Admissions submissions, CRM inquiry detail/update, follow-up and identity matching; `server/admissions/*`, `server/crm/{model,read,write}.ts` |
| `counselling_delivery_attempts` | SELECT, INSERT, UPDATE | Counselling delivery status/history; `server/admissions/*`, `server/crm/read.ts` |
| `admissions_leads` | SELECT, INSERT, UPDATE | Lead registration, admissions workflows, CRM reads/writes; `server/admissions/*`, `server/crm/*` |
| `admissions_crm_profiles` | SELECT, INSERT, UPDATE | CRM stage/notes/owner updates and AVNI/calendar profile locking; `server/crm/*`, `server/calendar/avni.ts` |
| `admissions_crm_activities` | SELECT, INSERT | CRM activity timeline and audit entries; `server/crm/*` |
| `admissions_lead_assignments` | SELECT only for the runtime role | CRM assignment state. Migration 0016 moves all INSERT/UPDATE to the owner-controlled function; direct runtime DML is denied. `server/crm/assignment.ts` |
| `admissions_lead_assignment_history` | SELECT only for the runtime role | CRM assignment history. The owner-controlled function appends events; direct runtime DML is denied. `server/crm/read.ts`, `server/crm/assignment.ts` |
| `admissions_lead_contact_preferences` | SELECT, INSERT, UPDATE | Consent/opt-out reads and upserts, including `FOR UPDATE`; `server/admissions/follow-up.ts` |
| `admissions_registration_outbox` | SELECT, INSERT, UPDATE | Registration follow-up delivery and dispatch; `server/admissions/follow-up.ts`, `server/admissions/outbox-dispatcher.ts` |
| `admissions_vsl_playbacks` | SELECT, INSERT, UPDATE | VSL playback state; `server/admissions/*` |
| `admissions_vsl_events` | SELECT, INSERT | VSL event recording; `server/admissions/*` |
| `admissions_capture_limits` | SELECT, INSERT, UPDATE | AVNI integration throttling upsert with `RETURNING`; `server/integrations/avni.ts`, `server/admissions/routes.ts` |
| `admissions_marketing_consent_events` | SELECT, INSERT, UPDATE | Consent evidence and lead linkage; `server/meta/events.ts`, `server/meta/routes.ts` |
| `admissions_lead_touchpoints` | SELECT, INSERT | Lead attribution/touchpoint recording; `server/meta/events.ts` |
| `admissions_meta_lead_links` | SELECT, INSERT | Meta lead association; `server/meta/*` |
| `admissions_meta_event_outbox` | SELECT, INSERT, UPDATE | Consent-gated Meta event dispatch and retries; `server/meta/events.ts`, `server/meta/routes.ts` |
| `admissions_legacy_lead_links` | SELECT only, maintenance path | Read-only reconciliation in `server/db/supabase-legacy-import-runner.ts`; this script currently imports the shared pool but its Replit transaction is read-only. Do not use it for writes or give it migration privileges. |
| `lms_users` | SELECT, INSERT, UPDATE | Authentication, user management, password setup and CRM assignee eligibility; `server/lms/*`, `server/crm/*` |
| `lms_user_roles` | SELECT, INSERT | Authentication/authorization and role provisioning. The table lock previously used by first-owner setup is removed; CRM row locks move into the definer function. Runtime UPDATE/DELETE are not required. `server/lms/{auth,first-owner,management-routes}.ts` |
| `lms_courses` | SELECT, INSERT, UPDATE | Course management and LMS catalog; `server/lms/*` |
| `lms_enrollments` | SELECT, INSERT, UPDATE | Enrollment management and student access; `server/lms/*` |
| `lms_modules` | SELECT, INSERT, UPDATE | Course module management; `server/lms/*` |
| `lms_chapters` | SELECT, INSERT, UPDATE | Chapter management; `server/lms/*` |
| `lms_lessons` | SELECT, INSERT, UPDATE | Lesson management; `server/lms/*` |
| `lms_resources` | SELECT, INSERT | Lesson resource metadata; `server/lms/*` |
| `lms_invitation_codes` | SELECT, INSERT, UPDATE | Invitation creation, validation and redemption state; `server/lms/*` |
| `lms_invitation_redemptions` | INSERT | Invitation redemption evidence; `server/lms/*` |
| `lms_lesson_progress` | SELECT, INSERT, UPDATE | Student progress; `server/lms/*` |
| `lms_trainer_assignments` | SELECT, INSERT, DELETE | Trainer assignment and removal; `server/lms/management-routes.ts` |
| `lms_assessments` | SELECT, INSERT, UPDATE | Assessment management; `server/lms/*` |
| `lms_assessment_versions` | SELECT, INSERT | Versioned assessment snapshots; `server/lms/*` |
| `lms_assessment_questions` | SELECT, INSERT | Assessment questions; `server/lms/*` |
| `lms_assessment_options` | SELECT, INSERT | Assessment choices; `server/lms/*` |
| `lms_assessment_attempts` | SELECT, INSERT | Student assessment attempts; `server/lms/*` |
| `lms_live_sessions` | SELECT, INSERT, UPDATE | Live-session management and attendance workflow; `server/lms/*` |
| `lms_certificates` | SELECT, INSERT, UPDATE | Certificate issuance/review; `server/lms/management-routes.ts` |
| `lms_notifications` | SELECT, INSERT, UPDATE | Notification creation and read state; `server/lms/*`, `server/calendar/*` |
| `lms_audit_logs` | SELECT, INSERT | Security and administration audit records; `server/lms/*`, `server/crm/*` |
| `lms_password_setup_tokens` | SELECT, INSERT, UPDATE, DELETE | One-time password setup lifecycle; `server/lms/*` |
| `lms_auth_rate_limits` | SELECT, INSERT, UPDATE, DELETE | Authentication/bootstrap throttling with `RETURNING`, plus expired-bucket cleanup; `server/lms/{first-owner,password-auth}.ts` |
| `calendar_resources` | SELECT, INSERT | Calendar resource setup; `server/calendar/*` |
| `calendar_batches` | SELECT, INSERT | Calendar batch setup; `server/calendar/*` |
| `calendar_batch_students` | SELECT, INSERT | Batch membership; `server/calendar/*` |
| `calendar_events` | SELECT, INSERT, UPDATE | Calendar event lifecycle and row-locked edits; `server/calendar/*` |
| `calendar_integration_requests` | SELECT, INSERT | Calendar/AVNI integration requests; `server/calendar/*` |
| `calendar_event_attendees` | SELECT, INSERT, DELETE | Attendee replacement and lookup; `server/calendar/*` |
| `staff_availability` | SELECT, INSERT | Staff availability; `server/calendar/*` |
| `availability_exceptions` | SELECT, INSERT | Availability exceptions; `server/calendar/*` |
| `notification_preferences` | SELECT, INSERT, UPDATE | Notification preference upsert and read; `server/calendar/*` |
| `push_subscriptions` | SELECT, INSERT, UPDATE | Push-subscription upsert and management; `server/calendar/*` |
| `calendar_reminder_jobs` | SELECT, INSERT, UPDATE | Reminder leasing with `FOR UPDATE SKIP LOCKED`, retry and completion; `server/calendar/reminders.ts` |
| `notification_delivery_logs` | SELECT, INSERT | Notification delivery evidence; `server/calendar/*` |
| `calendar_activity` | INSERT | Calendar activity events; `server/calendar/*` |

The `lms_attendance` and `lms_otp_challenges` schema declarations had no
ordinary application SQL references in the inspected server code. They are not
granted by migration 0016. Add privileges only alongside a reviewed feature.
`admissions_conversation_messages` belongs to a separate Supabase read-only
connection, not the shared Replit pool, and is outside this matrix.

## Sequences, locks, functions, and DDL

- The migration grants `USAGE` on an `id` sequence only when the corresponding
  app-inserted table has a serial/identity sequence. It does not grant
  `UPDATE`, `SELECT`, or access to every sequence indiscriminately. UUID-keyed
  tables have no sequence grant.
- `FOR UPDATE` / `FOR SHARE` paths occur on tables the app already updates,
  such as calendar events, reminders, consent preferences, and CRM profiles.
  Assignment validation locks and the first-owner serialization use are moved
  out of ordinary runtime table privileges. In particular, first-owner setup
  retains a transaction advisory lock instead of a table-level
  `SHARE ROW EXCLUSIVE` lock that would require broad `lms_user_roles` write
  privilege.
- Application code uses PostgreSQL built-ins such as
  `pg_advisory_xact_lock`, `hashtext`, and `to_timestamp`; their built-in
  execution permissions are not a reason to grant arbitrary application
  functions. The runtime receives `EXECUTE` only on the specific CRM assignment
  function.
- Runtime needs `CONNECT` on its database and `USAGE` on `public`, but no
  `CREATE` on a schema, table ownership, migration-ledger access, `CREATE ROLE`,
  or DDL privilege.
- No `TRUNCATE` privilege is granted. Deletes are limited to the explicitly
  listed session, trainer-assignment, password-token, auth-rate-limit, and
  calendar-attendee cleanup paths.
- Table-level grants cannot reproduce all HTTP authorization rules. In
  particular, the application requires `INSERT` on `lms_user_roles` and
  `UPDATE` on `lms_users` for authorized account/role administration. A holder
  of the app database credential can issue direct SQL that bypasses those
  route checks, even though that role cannot own objects or mutate assignment
  history directly. This role split materially removes superuser/DDL and
  assignment-history powers, but it does not make a compromised app credential
  equivalent to an authenticated admin. A separate, DB-verifiable actor
  assertion or narrower role-management function is a future security
  improvement; a SECURITY DEFINER function that merely accepts an actor ID
  would not solve that trust problem.

## Role split and manual rollout requirements

Migration 0016 creates non-login `aichm_crm_owner`,
`aichm_app_runtime`, and `aichm_crm_migrator` roles. The CRM tables and
security-definer assignment function are owned by `aichm_crm_owner`. The
application group can read assignment state/history and execute that function,
but cannot directly mutate either assignment table or assume owner/migrator
roles. The function locks and validates active admin/assignee identities,
checks expected version and request-id idempotency, then commits assignment and
history together. Actor identity continues to come from the authenticated
server-side session (`req.lmsUser`), never from a request-body actor field.

The application login is deliberately not created by migration SQL and no
password is embedded. A platform/operator must provision a dedicated login
with membership in `aichm_app_runtime`, without membership in owner/migrator,
then place its connection string in Replit Secrets as
`AICHM_APP_DATABASE_URL`. The existing
`AICHM_CRM_FORWARD_DATABASE_URL` remains a separate migration-operator
connection. The current runner's pinned Development identity and explicit
apply confirmation remain mandatory.

The current forward runner still authenticates as the pinned `postgres`
Development identity so it can perform controlled role/object ownership
changes. `aichm_crm_migrator` is a non-login group prepared for a future
non-superuser migration operator; this migration does not switch the runner's
credential or prove that Replit permits that operator to perform every required
role/ownership operation. Replacing the runner's pinned `postgres` identity
requires a separate reviewed identity/permissions change and is not part of this
code-only preparation.

The app uses `AICHM_APP_DATABASE_URL` only when explicitly set. Its endpoint
must match the platform-provided `DATABASE_URL` endpoint in memory; the
platform URL is comparison-only and is never a fallback after an explicit
invalid app URL. The code currently accepts only RFC1918 IPv4 addresses or
hostnames ending in `.internal`; it rejects public-DNS and loopback-style
addresses before opening a socket. Replit's public docs describe the
Development URL as private and project-scoped but do not publish its hostname
syntax, so a legitimate URL outside this narrow syntax will fail closed until
that format is verified and deliberately supported. The app login username is
intentionally allowed to differ from the platform URL's username; otherwise a
dedicated non-superuser could not replace the historical `postgres` login.
Host, effective port, database name, and query/TLS policy must still match.
Startup then checks current database, login role, non-superuser
status, safe group memberships, required core privileges, read-only assignment
table ACLs, assignment-function EXECUTE, and absence of schema CREATE before
opening the HTTP listener. If the app URL is absent, existing behavior is
retained and startup warns that least privilege is not enabled. If it is
present but invalid or not fully provisioned, startup fails closed.

Replit's current database-publishing documentation says automated Publish
migration transfers schema objects such as tables, indexes, constraints,
sequences and RLS policies, but **does not** transfer custom database roles,
stored procedures, triggers, or explicit grants. Custom role passwords do not
carry over. These must be provisioned and verified separately in each
environment, including Production after a separately approved rollout. The
exact SQL-console/API capability for creating roles and granting membership in
this live Development database has not been verified here. Do not infer
platform support from the presence of a migration file.

The forward-runner preview reports a separate `runtimeRoleGate`; a blocked gate
means the schema is not rollout-ready, even if the schema migrations are still
pending or have been prepared. The migration path does not switch application
credentials. After the CRM role migration has been applied in a separately
approved Development change, the operator must create a dedicated login and
grant it membership in `aichm_app_runtime` only; do not make it a member of the
owner or migrator groups. Set `AICHM_APP_DATABASE_URL` only after those grants
and CRM postconditions are ready. On startup the app switches to that explicit
URL and refuses to listen unless the full role/privilege checks pass. If
`AICHM_APP_DATABASE_URL` is absent, the existing superuser-backed runtime
behavior remains active with a warning, so the feature is not considered
rolled out.

Before switching the application secret, test startup and representative
routes using the new role in an isolated preview, then retain the previous
secret/configuration for rollback. Credential rotation behavior and a
no-downtime role switch are not proven by this code-only work. Publish and
Production role provisioning require separate approval.

### Controlled Development rotation sequence

1. Obtain separate approval for the Development-only schema migration and
   confirm the pinned CRM migration preview, prerequisites, and role
   postconditions. Preview is read-only; applying remains a distinct action.
2. After the reviewed role migration is applied, provision one dedicated
   non-superuser login using Replit's supported database administration path.
   Grant only membership in `aichm_app_runtime`; verify it has no other role
   memberships, database ownership, role-creation, database-creation, or
   `BYPASSRLS` attributes. The role DDL contains no login password.
3. Create a Replit Secret named `AICHM_APP_DATABASE_URL` for the Development
   app login. Do not paste its value into chat, code, shell history, or logs.
   The app uses it immediately when present, so do this only after the database
   grants and assignment function are ready.
4. Validate startup and representative authentication, admissions, LMS, CRM
   list/detail, assignment, and history-read routes on a controlled preview.
   Startup must report the least-privilege role verified and refuse to listen
   for any mismatch or missing privilege.
5. Keep the prior secret/configuration available through Replit's approved
   secret workflow for rollback. Switching/removing the explicit app URL returns
   to legacy `DATABASE_URL` behavior with a warning; that is an emergency
   rollback, not a least-privilege state. Confirm any restart/outage behavior
   before changing the live Development secret.
6. Treat Production as a separate future operation. Replit's Publish database
   migration does not carry custom roles, function bodies, triggers or grants;
   each must be separately provisioned, reviewed, and approved before a
   Production application credential or deployment is changed.

No live Development role provisioning, secret rotation, connection test,
migration, or deployment was performed during this code-only preparation.

## Static-review limitations

This matrix is derived from source declarations and queries, not a live
`information_schema`/catalog inspection. Exact table existence, RLS flags and
policies, sequence names, owners, effective grants, custom role support, and
the active admissions-user count remain unverified until an explicitly
authorized read-only Development preflight. The legacy reconciliation script
is presently read-only, but because it imports the shared pool it must be run
only under an explicitly reviewed operator context.
