# Source-to-target mapping and compatibility

## Schema boundary

Keep the existing Supabase `public.leads`, `public.conversations`, and `public.course_knowledge` tables in place for the current n8n/Avni workflows. Replit-owned application tables are now present as empty tables in the private `aichm` schema, created by additive Stage 1 migrations. No records have been copied.

Current Drizzle definitions use `pgTable` and much raw SQL is unqualified. A future app pool can use `search_path=aichm,public` so unqualified application table names resolve to `aichm`; audit and rewrite explicit `public.*` references and generated foreign-key references before cutover. Do not apply current `migrations/0000`–`0011` unchanged: they were generated for the Replit source schema, and the Calendar migration contains explicit `public` references. Generate a fresh target schema from the reconciled current schema and add it without altering the existing public tables.

Use a dedicated least-privilege server role for the application schema. Do not grant `anon` or `authenticated` access to private AICHM tables and do not put a service-role key or database URI in browser code. Keep existing n8n access to the current public tables and their policies intact. The current migration connection is the privileged `postgres` role and is for preparation only, not the future application runtime role.

## Table-by-table mapping

Counts are development / production rows. All source `public.*` application tables map to `aichm.*` with their primary keys preserved. Empty tables are still included to preserve schema, FKs, and forward compatibility.

| Domain | Source table | Target table | Dev / Prod rows | Dependencies / treatment |
|---|---|---|---:|---|
| LMS identity | `public.lms_users` | `aichm.lms_users` | 2 / 2 | Root identity table; preserve IDs and scrypt hashes byte-for-byte. |
| LMS identity | `public.lms_user_roles` | `aichm.lms_user_roles` | 2 / 2 | After users; preserve roles and enum definition. |
| LMS identity | `public.sessions` | `aichm.sessions` | 1 / 2 | Preserve only with the existing session format and unchanged `SESSION_SECRET`; expired sessions remain expired. |
| LMS identity | `public.lms_password_setup_tokens` | `aichm.lms_password_setup_tokens` | 1 / 2 | After users; preserve token hashes/expiry/consumption state only, never raw tokens. |
| LMS identity | `public.lms_auth_rate_limits` | `aichm.lms_auth_rate_limits` | 4 / 19 | Preserve hashed keys and expiry/window state; no key values in reports. |
| LMS identity | `public.lms_otp_challenges` | `aichm.lms_otp_challenges` | 0 / 0 | Preserve the schema; no active rows observed. |
| Admissions | `public.admissions_capture_limits` | `aichm.admissions_capture_limits` | 0 / 4 | Preserve throttling state and expiry. |
| Admissions | `public.admissions_leads` | `aichm.admissions_leads` | 0 / 1 | Stable UUID lead identity; preserve the UUID and registration/source metadata. |
| Admissions | `public.inquiries` | `aichm.inquiries` | 12 / 8 | Preserve every submission ID and full questionnaire payload; keep its existing lead FK. |
| Admissions | `public.counselling_delivery_attempts` | `aichm.counselling_delivery_attempts` | 0 / 1 | After inquiries; preserve delivery audit metadata and original inquiry ID. |
| Admissions | `public.admissions_vsl_events` | `aichm.admissions_vsl_events` | 0 / 1 | After admissions lead; preserve observed event UUIDs/timestamps. |
| Admissions | `public.admissions_vsl_playbacks` | `aichm.admissions_vsl_playbacks` | 0 / 1 | After admissions lead; preserve playback UUID and validated progress ranges. |
| CRM | `public.admissions_crm_profiles` | `aichm.admissions_crm_profiles` | 0 / 0 | After inquiries and users; schema retained although empty. |
| CRM | `public.admissions_crm_activities` | `aichm.admissions_crm_activities` | 0 / 0 | After inquiries and users; schema retained although empty. |
| LMS content | `public.lms_courses` | `aichm.lms_courses` | 2 / 1 | After users; preserve course IDs/status enums. |
| LMS content | `public.lms_modules` | `aichm.lms_modules` | 10 / 1 | After courses. |
| LMS content | `public.lms_chapters` | `aichm.lms_chapters` | 38 / 1 | After modules; source content differs between environments. |
| LMS content | `public.lms_lessons` | `aichm.lms_lessons` | 39 / 2 | After chapters; source content differs between environments. |
| LMS assessment | `public.lms_assessments` | `aichm.lms_assessments` | 0 / 0 | After chapters. |
| LMS assessment | `public.lms_assessment_versions` | `aichm.lms_assessment_versions` | 0 / 0 | After assessments and users. |
| LMS assessment | `public.lms_assessment_questions` | `aichm.lms_assessment_questions` | 0 / 0 | After assessment versions. |
| LMS assessment | `public.lms_assessment_options` | `aichm.lms_assessment_options` | 0 / 0 | After questions. |
| LMS enrollment | `public.lms_enrollments` | `aichm.lms_enrollments` | 1 / 1 | After users and courses. |
| LMS progress | `public.lms_lesson_progress` | `aichm.lms_lesson_progress` | 2 / 2 | After enrollments and lessons. |
| LMS assessment | `public.lms_assessment_attempts` | `aichm.lms_assessment_attempts` | 0 / 0 | After assessments, versions, and enrollments. |
| LMS certificates | `public.lms_certificates` | `aichm.lms_certificates` | 1 / 1 | After enrollments and users. |
| LMS invitations | `public.lms_invitation_codes` | `aichm.lms_invitation_codes` | 0 / 0 | After courses and users. |
| LMS invitations | `public.lms_invitation_redemptions` | `aichm.lms_invitation_redemptions` | 0 / 0 | After invitation codes, enrollments, and users. |
| LMS staffing | `public.lms_trainer_assignments` | `aichm.lms_trainer_assignments` | 0 / 0 | After courses and users. |
| LMS sessions | `public.lms_live_sessions` | `aichm.lms_live_sessions` | 0 / 0 | After courses and users; Calendar must link rather than duplicate. |
| LMS attendance | `public.lms_attendance` | `aichm.lms_attendance` | 0 / 0 | After live sessions and users; remains attendance system of record. |
| LMS resources | `public.lms_resources` | `aichm.lms_resources` | 0 / 0 | After lessons/users; retain `bytea` and storage-key compatibility if populated later. |
| LMS notifications | `public.lms_notifications` | `aichm.lms_notifications` | 0 / 0 | After users; Calendar migration adds priority/link/metadata/idempotency fields. |
| LMS audit | `public.lms_audit_logs` | `aichm.lms_audit_logs` | 1 / 1 | After users; preserve audit events. |

`drizzle.__drizzle_migrations` is migration-tool history, not application data; do not copy it as the target baseline. `_system.replit_database_migrations_v1` is platform-owned and remains in Replit. Supabase `auth`, `realtime`, `storage`, `vault`, and `supabase_migrations` objects are platform-managed and are not source-app mappings.

## Supabase-owned public tables: no-copy rule

| Existing target table | Rows | Policy |
|---|---:|---|
| `public.leads` | 31 | Keep in place for n8n/Avni; never overwrite or import Replit rows here. |
| `public.conversations` | 300 | Keep in place for n8n/Avni; never overwrite or import Replit messages here. |
| `public.course_knowledge` | 54 | Keep in place; preserve its current published-content RLS policy. |

The AICHM Chat Bot already uses Supabase nodes for these tables. Do not change its workflow or credentials as part of migration preparation.

## Crosswalk and duplicate reconciliation

The existing Replit lead identity is `admissions_leads.id` (UUID); `inquiries.lead_id` links a questionnaire submission to it. Keep every inquiry as a separate submission record and preserve numeric inquiry IDs, submission IDs, and existing stable lead UUIDs.

Do not merge by phone alone. A future private crosswalk should record source system/table/primary key, target schema/table/ID, match evidence, match method, review state, reviewer and timestamp. Automatically link only an exact stable ID or explicit, verified source identifier. Normalized Indian E.164 phone matches are candidate evidence only; ambiguous, repeated, or many-to-one matches require human review. The present inventory did not read phone values or compare identities, so overlap with the 31 existing Supabase leads is **unknown**.

Conflict policy for a future apply phase: never overwrite a target row. If a primary key already exists, compare a private deterministic integrity digest and classify it as identical or conflict; never resolve a differing row by last-write-wins. Preserve unrelated target records and send unresolved identity candidates to a review queue.

## Custom authentication

The current app owns authentication in `lms_users`, `lms_user_roles`, `sessions`, password setup tokens, OTP challenges, and rate-limit tables. Passwords use Node `scrypt`; the `aroma.sid` cookie/session depends on `SESSION_SECRET`. Supabase `auth.users` is empty. Keep this custom auth model initially; do not migrate to Supabase Auth as part of this work.

Preserve password hashes exactly, keep `SESSION_SECRET` unchanged, and retain session serialization/cookie conventions. Before cutover, test existing owner login, session refresh, password setup/reset expiry and single-use behavior, and all role checks. Expired transient tokens may remain expired; do not revive them.

## Calendar additions

Workspace migrations `0010_0010_aichm_calendar_push.sql` and `0011_0011_calendar_reminder_event_version.sql` describe these future app-owned tables. They are absent from both source databases and Supabase today. Map them to `aichm` only after generating a fresh target migration:

`calendar_resources`, `calendar_batches`, `calendar_batch_students`, `calendar_events`, `calendar_event_attendees`, `staff_availability`, `availability_exceptions`, `notification_preferences`, `push_subscriptions`, `calendar_reminder_jobs`, `notification_delivery_logs`, `calendar_activity`.

Keep `lms_notifications` as the inbox record table and add its Calendar-specific fields additively. Preserve separate `/admin` and `/learn` service-worker scopes. No VAPID keys, scheduler hookup, Calendar schema, or push rows are active in either database.

## Files and unmapped sources

- `lms_resources` has 0 rows in both source environments; the schema supports `bytea` content and storage keys.
- Replit App Storage has 458 objects; the VSL HLS prefix contains a playlist plus 228 segments. The listing API does not expose size metadata. Supabase Storage has no buckets or objects. Inventory sizes/checksums and choose a non-destructive transfer path before any media move.
- No payment/fee-ledger table exists in either source schema. Payment history, if any, is external/unmapped; the owner must identify its authoritative source and export/API before a complete all-data migration can be promised.
- No Google Calendar, Cal.com, Outlook, or other external calendar database is part of this mapping.

## Type and schema compatibility

Source PostgreSQL is 16.x and Supabase is 17.11. Core types (`uuid`, `integer`, `text`, `jsonb`, `timestamptz`, `bytea`, arrays) are compatible, but custom enum types, defaults, sequence ownership/high-water marks, partial indexes, constraints, RLS, and `sessions.expire` without timezone require explicit schema comparison and restore rehearsal. The complete types/defaults/nullability and FK/index definitions are in the inventory JSON files.
