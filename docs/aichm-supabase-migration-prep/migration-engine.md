# AICHM migration engine: workspace implementation

## Safety state

This is migration code, not an authorization to migrate. No live database connection, DDL/DML, export, backup, restore, or data copy was run while implementing it. `server/db.ts` continues to use `DATABASE_URL`.

The target currently has no AICHM application schema. The control-schema SQL file is a draft and has not been applied. A full application-schema migration and compatibility review are still required before the engine can pass its target-table preflight.

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

Manifest files are supplied as CLI paths and are not emitted by the runner. The public signing key is configuration, not a substitute for owner review. Missing or mismatched prerequisites stop before any target writes. No apply command has been run.

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

## Prepared control schema

[`supabase-migration-control-schema.sql`](supabase-migration-control-schema.sql) creates only the private `aichm` schema-control, checkpoint, and crosswalk tables with RLS enabled and no browser policies. It is not applied. It is not the full AICHM application schema. Target mapped tables must be created by a separately reviewed additive schema migration first.

## Safe validation

Unit tests use synthetic in-memory stores only:

```sh
npx tsx --test server/db/aichm-migration-engine.test.ts \
  server/db/aichm-source-migration.test.ts \
  server/db/supabase-migration.test.ts \
  server/db/aichm-migration-plan.test.ts
```

They cover prerequisite refusal, signatures, backup/restore manifest validation, identity/TLS checks, FK order, protected tables, review gates, conflicts, secret-safe logging, stable IDs/auth hashes, transactional rollback, checkpoint resume, rerun skips, and transform restrictions.

Do not run the live modes until the owner has provisioned a supported production-primary connection and verified encrypted backups/restores, reviewed the full target schema, and supplied signed approval manifests. The engine does not create backups or run schema DDL.
