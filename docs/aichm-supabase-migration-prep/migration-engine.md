# AICHM migration engine: workspace implementation

## Safety state

Stage 1 of the target migration has been applied as empty-schema DDL only. No application records were copied, and no source schema/data, runtime routing, secrets, or deployment was changed. `server/db.ts` continues to use `DATABASE_URL`.

The existing Supabase target now has the private `aichm` schema, its migration-control tables, and the 34 empty application tables from `aichm-app-schema-v1`. The existing `public` n8n/Avni tables are preserved. The data-copy engine remains a separate stage and has not been run.

## Runner behavior

`npm run aichm:migrate` and `npm run aichm:migrate -- --dry-run` use only the captured metadata snapshots. They do not open a database connection.

`npm run aichm:migrate -- --live-dry-run` is an explicit, read-only live operation. It requires the production-source and Supabase connection settings, strict TLS, the audited production database identity, and every mapped target table. It scans rows in primary-key order in memory to classify insert/skip/review/conflict counts and compare checksums. This task did not invoke that mode.

Apply requires all of the following together:

- `--apply` **and** the separate `--production-cutover` flag.
- `NODE_ENV=production`; the engine rejects development/test execution.
- `AICHM_SOURCE_PROD_DATABASE_URL`, pointing to database `neondb` with `sslmode=require` and certificate/hostname verification.
- `SUPABASE_DATABASE_URL` and `SUPABASE_DB_SSL_CA`, validated by the existing strict Supabase TLS factory for project `xylqezjvqqqjozenuygh`.
- `AICHM_BACKUP_ENCRYPTION_KEY` (minimum length checked; never logged).
- `AICHM_MIGRATION_APPROVAL_PUBLIC_KEY`.
- A source and target backup manifest with artifact IDs, SHA-256 checksums, sizes, creation times, and independently verified isolated restore records.
- A signed reconciliation manifest covering every `admissions_leads` and `lms_users` identity. Lead decisions are explicit (`create-distinct` or `link-existing-public-lead`); user decisions preserve the current custom auth account. The manifest cannot silently merge by phone.
- A signed compatible schema-version manifest. It must match the live source/target schema fingerprints and the applied control-schema version.
- A separate owner-signed cutover approval binding the exact backup, reconciliation, and schema manifests to the production source and approved Supabase project.

Manifest files are supplied as CLI paths and are not emitted by the runner. The public signing key is configuration, not a substitute for owner review. Missing or mismatched prerequisites stop before data-copy writes. No data-copy apply command has been run.

## Copy behavior

- The explicit source allowlist maps application tables from `public.*` to `aichm.*` in deterministic FK order. IDs and values are preserved unless a versioned, reviewed column transform is added.
- `public.leads`, `public.conversations`, and `public.course_knowledge` are not copy destinations. Existing public records are only checked for existence when an approved crosswalk points to a lead; they are never updated or merged.
- `admissions_leads` and `lms_users` require signed row-level review. An approved public-lead link is stored in the private crosswalk while the source AICHM lead remains its own `aichm` row.
- Existing rows are skipped only when all mapped columns match in memory. Primary-key or unique-key collisions with differing values become conflicts; there is no upsert/overwrite.
- Batches use target transactions. `ON CONFLICT DO NOTHING` handles races; an unexpected differing row rolls back the current batch. Checkpoint updates and crosswalk writes share that transaction. Reruns resume from the committed primary-key checkpoint or classify existing equal rows as skips.
- Integer/identity sequences are advanced monotonically only after the copy completes. Sequence operations are idempotent but PostgreSQL sequence changes are not transactional; the target must remain offline until all verification gates pass.
- SHA-256 batch-chain checksums cover canonicalized non-secret columns. Secret fields (including password hashes and token/session data) are excluded from logged checksums but are still compared in memory for conflict detection. Logs contain only allowlisted table names, counts, batch numbers, and aggregate digests.
- Calendar tables are excluded. Existing expiring sessions, OTP/password-setup tokens, and rate-limit rows are deferred for an explicit sign-out/expiry decision. Custom `lms_users` password hashes and role rows remain custom auth, not Supabase Auth.
- Payments and App Storage objects are not inferred or copied. Payments have no audited source table; VSL/media objects need a separate hashed object manifest and transfer plan.

## Applied Stage 1 schema

The versioned files `supabase/migrations/20261106_aichm_migration_control_v1.sql` and `supabase/migrations/20261106_aichm_app_schema_v1.sql` were applied through `script/apply-aichm-stage1-schema.ts`. Verification confirmed 34 empty application tables matching the current production-primary catalog, with RLS enabled and no browser policies or grants. `supabase-migration-control-schema.sql` is reference-only; do not execute it directly.

No Calendar or payment tables were created. `aichm` was not added to database-level PostgREST schema settings; confirm the project-level Data API exposed-schema list in the Supabase Dashboard before any future API access.

## Safe validation

Unit tests use synthetic in-memory stores only:

```sh
npx tsx --test server/db/aichm-migration-engine.test.ts \
  server/db/aichm-source-migration.test.ts \
  server/db/supabase-migration.test.ts \
  server/db/aichm-migration-plan.test.ts
```

They cover prerequisite refusal, signatures, backup/restore manifest validation, identity/TLS checks, FK order, protected tables, review gates, conflicts, secret-safe logging, stable IDs/auth hashes, transactional rollback, checkpoint resume, rerun skips, and transform restrictions.

Do not run data-copy modes until a fresh production-primary backup is independently restored, reconciliation and schema manifests are reviewed, and all separate owner approval gates are satisfied. The data-copy engine does not create backups or run schema DDL; Stage 1 schema creation is a separate completed operation.
