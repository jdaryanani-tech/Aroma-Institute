# AICHM → Supabase migration preparation

**Historical status (2026-11-06 snapshot):** Saved preparation evidence recorded Stage 1 target schema as applied using additive DDL only, with no application records copied and no runtime routing change in that audit. This is not current live verification. Production CRM source now requires `AICHM_APP_DATABASE_URL`; it does not fall back to `DATABASE_URL`.

**Applied migration IDs:** `aichm-migration-control-v1` and `aichm-app-schema-v1`.

**Stage 1 verification:** 34 empty application tables, 246 columns, 34 primary keys, 46 foreign keys, 8 unique constraints, 3 check constraints, 88 application indexes, 25 sequences and 5 enum types. Three migration-control tables also exist; only the two migration-ledger rows are populated. All 34 application tables have RLS enabled, no policies and no grants to `PUBLIC`, `anon`, `authenticated` or `service_role`. The source schema was freshly inspected from the production primary using strict TLS. The source database was not changed.

Existing Supabase public counts remain `leads=31`, `conversations=300`, `course_knowledge=54`; their RLS/policy configuration was not changed. The migration did not alter PostgREST settings, and no database-level `pgrst.db_schemas` setting includes `aichm`. The project-level Data API exposed-schema setting was not independently visible to the database connection and should be checked in the Supabase Dashboard before any future client access. No client access is intended for this private schema.

**Inventory date:** 2026-11-06 UTC. The Supabase TLS/inventory probe completed at 2026-11-06T06:59:24Z; Replit development and production metadata were queried read-only during the same audit session. Counts are point-in-time snapshots and can change.

## Source and target snapshot

| Environment | Database label | PostgreSQL | Application tables / rows | Database size |
|---|---|---:|---:|---:|
| Replit development | `heliumdb` | 16.10 | 34 / 116 | 10,457,571 bytes |
| Replit production read-only replica | `neondb` | 16.15 | 34 / 53 | 10,141,696 bytes |
| Supabase target (`xylqezjvqqqjozenuygh`) | `postgres` | 17.11 | 3 existing public app tables / 385 rows | 11,540,147 bytes |

The JSON source inventory files are point-in-time audit snapshots. The Stage 1 schema was generated from a fresh metadata-only catalog export of the production primary, not by replaying those stale migration journals.

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

The 2026-11-06 connection read only database identity, catalogs, and exact table counts. At that time the separate factory was not used by the normal app and `server/db.ts` used `DATABASE_URL`. Current Production runtime instead requires `AICHM_APP_DATABASE_URL`; the historical observation must not be treated as current connection state.

## Preparation files

- `supabase/migrations/20261106_aichm_migration_control_v1.sql` — private migration-control tables.
- `supabase/migrations/20261106_aichm_app_schema_v1.sql` — generated empty application schema from a production-primary schema-only export; no row data.
- `server/db/aichm-schema-stage1.ts` and `script/generate-aichm-stage1-schema.ts` — allowlisted, metadata-only schema generator.
- `script/apply-aichm-stage1-schema.ts` — explicit transactional Stage 1 DDL runner with identity/TLS, schema, RLS, grants and preservation checks; rerun after success is read-only verification.
- `server/db/aichm-migration-plan.ts`, `server/db/aichm-migration-engine.ts`, and the migration scripts — data-copy planning/apply gates. The data-copy engine was not run in this stage.
- `runbook.md` and `migration-engine.md` — backup, restore, reconciliation, dry-run and cutover gates.

At the time of the snapshot, migration tooling used `SUPABASE_DATABASE_URL` and `SUPABASE_DB_SSL_CA`; the production-source factory was separately gated by `AICHM_SOURCE_PROD_DATABASE_URL` and verified `verify-full` TLS. Current app runtime uses `AICHM_APP_DATABASE_URL` in Production. Data-copy apply mode remains blocked until fresh backup/restore, reconciliation, schema manifests, and separate approvals are verified; do not infer current state or data-migration approval from the historical Stage 1 record.

The code-based engine, connection factories, apply gates and synthetic tests are described in [`migration-engine.md`](migration-engine.md). The statements about no data-copy/cutover and backup freshness refer to the 2026-11-06/07 audit evidence only; recheck current audit artifacts before relying on them. Calendar, payments and storage/media transfer were separate unresolved work in that snapshot.
