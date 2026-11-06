# AICHM → Supabase migration preparation

**Status:** preparation artifacts only. No DDL, DML, data copy, export, secret change, runtime routing change, publish, or cutover occurred.

**Inventory date:** 2026-11-06 UTC. The Supabase TLS/inventory probe completed at 2026-11-06T06:59:24Z; Replit development and production metadata were queried read-only during the same audit session. Counts are point-in-time snapshots and can change.

## Source and target snapshot

| Environment | Database label | PostgreSQL | Application tables / rows | Database size |
|---|---|---:|---:|---:|
| Replit development | `heliumdb` | 16.10 | 34 / 116 | 10,457,571 bytes |
| Replit production read-only replica | `neondb` | 16.15 | 34 / 53 | 10,141,696 bytes |
| Supabase target (`xylqezjvqqqjozenuygh`) | `postgres` | 17.11 | 3 existing public app tables / 385 rows | 11,540,147 bytes |

The Replit production inventory came from Replit's read-only production database query path, not a direct connection to the production app process. It is suitable for metadata planning, not a production backup or a cutover guarantee.

Detailed metadata-only inventories:

- [`source-development.json`](source-development.json)
- [`source-production.json`](source-production.json)
- [`supabase-target.json`](supabase-target.json)

These contain schema/catalog metadata and aggregate row counts only: no lead, student, applicant, conversation, password, session, or token contents. They include columns and types/defaults/nullability; constraints; indexes; sequences; triggers; routines; extensions; RLS/policies; relation sizes; and migration-table counts.

### Replit source facts

- Each environment has 34 application tables under `public`. Development has 116 rows; production has 53.
- Development metadata: 249 columns; 92 constraints (35 primary keys, 46 foreign keys, 8 unique, 3 check); 89 indexes; 26 sequences; no user triggers or routines; `plpgsql` extension.
- Production metadata: 254 columns; 93 constraints (36 primary keys, 46 foreign keys, 8 unique, 3 check); 91 indexes; 27 sequences; no user triggers or routines; `plpgsql` extension.
- Non-empty development tables: `inquiries` 12; `lms_audit_logs` 1; `lms_auth_rate_limits` 4; `lms_certificates` 1; `lms_chapters` 38; `lms_courses` 2; `lms_enrollments` 1; `lms_lesson_progress` 2; `lms_lessons` 39; `lms_modules` 10; `lms_password_setup_tokens` 1; `lms_user_roles` 2; `lms_users` 2; `sessions` 1.
- Non-empty production tables: `admissions_capture_limits` 4; `admissions_leads` 1; `admissions_vsl_events` 1; `admissions_vsl_playbacks` 1; `counselling_delivery_attempts` 1; `inquiries` 8; `lms_audit_logs` 1; `lms_auth_rate_limits` 19; `lms_certificates` 1; `lms_chapters` 1; `lms_courses` 1; `lms_enrollments` 1; `lms_lesson_progress` 2; `lms_lessons` 2; `lms_modules` 1; `lms_password_setup_tokens` 2; `lms_user_roles` 2; `lms_users` 2; `sessions` 2.
- Workspace migration journal has 12 entries (`0000`–`0011`), while the source `drizzle.__drizzle_migrations` table has 3 rows in both environments. Production also has 4 platform migration records in `_system.replit_database_migrations_v1` (2026-10-31 through 2026-11-05). Do not replay the workspace journal blindly.
- No payment or fee-ledger tables were found. CRM profile/activity tables, assessment tables, live-session/attendance tables, and several auth tables are present but empty.
- No `calendar_*`, `push_subscriptions`, `notification_preferences`, or calendar reminder tables exist in either source database. Calendar migrations `0010` and `0011` exist only in the workspace and are not applied to these databases.

### Supabase target facts

- Public AICHM tables are `public.leads` (31 rows), `public.conversations` (300), and `public.course_knowledge` (54). Keep these rows and their existing n8n/Avni use intact; do not bulk-copy Replit rows into these tables.
- `auth.users` has 0 rows. Supabase Auth is not the current app's login source.
- `storage.buckets` and `storage.objects` each have 0 rows.
- Supabase migration-history counts are `auth.schema_migrations` 82, `realtime.schema_migrations` 91, `storage.migrations` 80, and `supabase_migrations.schema_migrations` 1. These are Supabase/platform history, not the AICHM source journal.
- The metadata snapshot includes 10 persistent Supabase schemas, 45 base tables, 493 columns, 151 constraints, 158 indexes, 2 sequences, 16 triggers, 109 routines, and 5 extensions. Supabase's own auth/realtime/storage migration rows are cataloged separately; they are not AICHM app migrations.
- `public.leads` and `public.conversations` have RLS enabled and no policies; `public.course_knowledge` has RLS enabled and an authenticated read policy for published rows. Preserve current policies during preparation. The public `update_updated_at_column` trigger routine has no fixed `search_path`; review this security-advisor finding before exposing new client access.

### App Storage media

A read-only App Storage listing found **458 objects**: 229 under the VSL HLS prefix (one playlist and 228 segments) and 229 other objects. The supported listing API returns object names, not object sizes; names were not printed or saved. The Supabase target currently has no buckets or objects. No object was copied or deleted.

## Application-side Supabase TLS

The separate migration pool connected successfully with the CA normalized in memory and `rejectUnauthorized: true`. Node's client socket reported:

- `encrypted=true`, `authorized=true`, no authorization error
- SNI/servername exactly `aws-0-ap-northeast-1.pooler.supabase.com`, matching the configured pooler host
- Peer certificate subject `CN=*.pooler.supabase.com, O=Supabase Inc, C=US`
- Issuer `CN=Supabase Intermediate 2021 CA, O=Supabase Inc, C=US`
- SHA-256 fingerprint `03:70:9C:A4:4D:1B:06:E4:50:4D:A0:A8:3B:6C:A0:65:76:1E:DC:70:4C:D5:63:4B:CC:38:94:FD:5C:7B:32:48`; validity 2025-03-12 through 2030-03-11

The connection read only database identity, catalogs, and exact table counts. The separate factory is not used by the normal app; `server/db.ts` and `drizzle.config.ts` still use `DATABASE_URL`.

## Preparation files

- `mapping-compatibility.md` — complete source-table mapping, preserved n8n tables, reconciliation, schema/RLS approach, and unresolved sources.
- `runbook.md` — backup, restore rehearsal, dry-run, verification, rollback, and go/no-go sequence.
- `server/db/aichm-migration-plan.ts` and `script/aichm-supabase-migration-prep.ts` — deterministic snapshot-based dry-run planner. It has no database writer. `--apply` is deliberately rejected until a separately reviewed migration implementation exists.
- `server/db/aichm-migration-plan.test.ts` — planner safety/order tests.

The source remains `DATABASE_URL`. Current migration connection secrets are `SUPABASE_DATABASE_URL` and `SUPABASE_DB_SSL_CA`; no secret values are in these artifacts. A dedicated least-privilege runtime database role and an audit HMAC key are future decisions, not configured here.
