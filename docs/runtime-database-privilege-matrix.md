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
`AICHM_APP_DATABASE_URL` before any CRM apply. The existing
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
invalid app URL. Replit's official Helium Development database documentation
describes the database as running alongside the app, accessible only from
within the app, and never public. The verified Development service hostname is
the exact single-label `helium`; the app guard accepts that exact name alongside
the existing RFC1918 IPv4 and `.internal` cases. Replit also documents a legacy
managed PostgreSQL host shape of `<endpoint-id>.<region>.aws.neon.tech`. The
guard accepts only that exact two-label AWS Neon shape, only when both the app
and platform URLs use the same host, and only when both specify exactly one
`sslmode=require`. Other public DNS names, arbitrary Neon hosts, and public IP
addresses remain rejected. The app login username is intentionally allowed to
differ from the platform URL's username; otherwise a dedicated non-superuser
could not replace the historical `postgres` login. Host, effective port,
database name, and query/TLS policy must still match.
Startup then checks current database, login role, primary/read-write status,
non-superuser status, safe group memberships, required core privileges,
read-only assignment table ACLs, assignment-function EXECUTE, and absence of
schema CREATE before opening the HTTP listener. Development may retain legacy
`DATABASE_URL` behavior when the explicit app URL is absent. Production does
not: `AICHM_APP_DATABASE_URL` is mandatory and startup fails closed if it is
absent, mismatched, or not fully provisioned.

Replit's current database documentation describes using the Development
Database SQL console for PostgreSQL role statements, including `CREATE ROLE`
and `GRANT`; custom roles and permissions are environment-specific and their
passwords do not carry over to Production. This documents the available
provisioning path, but the actual Development database's permission to execute
the required statements has not been live-verified. Do not infer that the
current connection role can provision roles merely from these docs or from a
migration file.

The runner's default `--preview` reports a separate pre-apply role gate and the
full post-migration `runtimeRoleGate`. A blocked pre-apply gate means apply is
not allowed; it must stop before ledger creation or migration SQL. The explicit
`--preflight-app-role` mode checks the candidate login, pinned database, and
role memberships without requiring any CRM assignment/history tables or
functions. The migration path does not switch application credentials. The
application uses `AICHM_APP_DATABASE_URL` in Production and performs the full
runtime role and CRM readiness checks before opening its listener. The
platform `DATABASE_URL` is comparison-only in Production; it is never a
fallback. Development can continue using legacy behavior only when the
explicit app URL is absent. If the Production app secret is made available
before required CRM objects and grants exist, startup intentionally fails
closed. Confirm safe secret scoping and migration sequencing with the owner;
do not restart Production as part of preparation.

### Pre-apply app-role requirements

Before a forward migration can create/update its ledger or execute SQL, the
runner requires `AICHM_APP_DATABASE_URL` and checks it through a separate
read-only pool. It must be the same internal Development host, effective port,
database, and query/TLS policy as both the platform endpoint and pinned CRM
operator endpoint. The application login name may differ from the operator
login. The operator connection independently verifies the pinned PostgreSQL
system identifier. The app connection must report the expected database name
and OID, not be in recovery or transaction-read-only, and authenticate as a
non-superuser LOGIN that is not a database owner or member of
`aichm_crm_owner`/`aichm_crm_migrator`.

The candidate must be a direct member of only `aichm_app_runtime`. That group
must already exist as NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT,
NOBYPASSRLS, and have no memberships of its own. This is intentionally a
pre-migration check: 0016 can create the owner and migrator groups later, but
the application login and runtime group must exist before any CRM migration.
After 0016, the existing full runtime gate separately verifies table/function
privileges and history immutability.

`DATABASE_URL` is used only as an in-memory endpoint comparison reference; it
is never a connection fallback. The dedicated app URL is not printed or
included in diagnostics. A missing, invalid, mismatched, or incorrectly
provisioned candidate must block before the ledger and migration write path.

Before switching the application secret, test startup and representative
routes using the new role in an isolated preview, then retain the previous
secret/configuration for rollback. Credential rotation behavior and a
no-downtime role switch are not proven by this code-only work. Publish and
Production role provisioning require separate approval.

### Controlled Development role bootstrap and rollout sequence

1. Stop the Development app workflow before adding
   `AICHM_APP_DATABASE_URL`. When this secret is present, app startup switches
   to it and requires the post-migration CRM objects. Starting the app before
   0014–0016 are applied can therefore fail closed.
2. Create a strong alphanumeric password of at least 32 characters and store it
   only as the temporary Replit Secret `AICHM_APP_ROLE_PASSWORD`. Do not put it
   in chat, source, a command argument, SQL text, shell history, or logs.
3. Run the helper without arguments for its read-only preview:

   ```sh
   npx tsx script/provision-crm-app-role.ts
   ```

   It connects only through `AICHM_CRM_FORWARD_DATABASE_URL`, checks the full
   pinned Development identity, and reports safe role-state and planned-action
   fields. Do not proceed if identity or existing role state is unsafe.
4. Provision only after separately approving the role writes. Both the flag and
   exact confirmation are required:

   ```sh
   AICHM_CRM_APP_ROLE_PROVISION_CONFIRM=PROVISION_AICHM_APP_LOGIN_IN_PINNED_DEVELOPMENT \
     npx tsx script/provision-crm-app-role.ts --apply-development-app-role
   ```

   The helper creates or validates `aichm_app_runtime` and
   `aichm_app_login`, grants only the runtime-group membership, and verifies
   the result. It rejects unsafe pre-existing attributes or memberships instead
   of changing them. Applying also sets the login password to the supplied
   temporary secret, including when the valid login already exists.
5. Construct the app URL locally by copying the current Development
   `DATABASE_URL` and replacing only the username with `aichm_app_login` and the
   password with the secret value. Preserve the host, port, database path, and
   query policy (including `sslmode`) exactly. Do not paste or print the URL.
6. Add that URL as the Replit Secret `AICHM_APP_DATABASE_URL`. After confirming
   it is saved, remove the temporary `AICHM_APP_ROLE_PASSWORD` secret; it is
   not needed by the application. Then run the read-only candidate check:

   ```sh
   npx tsx script/crm-forward-migrate.ts --preflight-app-role
   ```

   It must verify the pinned Development identity and the candidate login/group
   boundary. Stop if blocked or ambiguous.
7. Only after reviewing the read-only migration preview, separately authorize
   the CRM migration apply. It requires the existing explicit apply flag and
   confirmation value, and reruns the app-role check under the advisory lock
   before creating/updating the ledger or executing migration SQL.
8. After migrations, run ordinary `--preview` to verify full postconditions and
   runtime grants. Restart the Development app only with separate approval;
   test authentication, admissions, LMS, CRM list/detail, assignment, and
   history-read routes on a controlled Development preview.
9. Keep the prior Development runtime configuration available through the
   approved secret workflow for rollback. In Development only, removing
   `AICHM_APP_DATABASE_URL` can restore legacy `DATABASE_URL` behavior; that
   is not a least-privilege state. Production fails closed when its explicit
   URL is absent.
10. Treat Production role provisioning and deployment as separately approved
    operations. Replit's Publish database migration does not carry custom
    roles, function bodies, triggers or grants; each must be independently
    provisioned, reviewed, and approved before changing a Production app
    credential or deployment.

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
