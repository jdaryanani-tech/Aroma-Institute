# AICHM database migration runbook

**Current phase:** preparation only. This runbook is not authorization to export, migrate, change secrets, or cut over.

## 0. Hard safety rules

- Keep `DATABASE_URL` as the active app database until a separate owner-approved cutover.
- Keep the existing Supabase public AICHM/n8n tables untouched.
- Never run historical migrations `0000`–`0011` as a batch against either Supabase or production Replit.
- The current `script/aichm-supabase-migration-prep.ts` reads committed metadata snapshots only. It has no database connection or writer; `--apply` exits with an error.
- Do not use `executeSql`'s production read-only replica as a backup/export source.
- No live n8n request, WhatsApp send, Calendar reminder, or deployment is needed for schema/data preparation.

## 1. Source and target identity preflight

Before a future dry-run against live databases:

1. Capture source identity through a secure database connection without logging URIs, credentials, or record contents. Identify environment explicitly as development or production.
2. Use the approved Supabase migration factory. It validates the exact Supavisor host, port, database path, expected project ref, one `sslmode=require`, the CA, chain, and hostname. Confirm the Node socket is encrypted and authorized, authorization error absent, and SNI matches the expected host.
3. Reject same-source/target identity, unexpected database/project identity, wrong environment, schema drift, missing required secrets, or any existing target object that is not on the reviewed allowlist.
4. Record exact counts, schema fingerprint, and sizes with a UTC timestamp. No primary-key or applicant values are printed.

Current required server-only connection settings are `SUPABASE_DATABASE_URL` and `SUPABASE_DB_SSL_CA`. The application still uses `DATABASE_URL`. A later least-privilege runtime role and target URI are a separate security decision.

## 2. Backup and restore rehearsal — required before any copy

No source or target backup was created in this preparation task. Before a migration:

1. Arrange separate owner-approved, supported exports/backups for the **production primary source** and **development source**. Do not use only Replit's read-only production query replica as the production backup. Use the supported database backup/export route or a securely provisioned direct dump from a controlled environment. Do not paste DSNs into chat or place them in shell history/logs.
2. Export schema, table data, sequences, enum/type definitions, constraints, indexes, triggers, RLS policies, and migration metadata needed for restoration. Keep Replit platform-owned migration metadata separate from AICHM application data.
3. Encrypt each export at rest with access limited to the owner/migration operator. Record environment, timestamp, scope, exact file size, and SHA-256 checksum of each encrypted artifact. Keep keys separately in an approved secret manager.
4. Take a target backup of the existing Supabase project before creating `aichm` or changing its policies. Preserve the existing n8n/Avni public tables and policies.
5. Restore development and production exports into **separate**, isolated, disposable PostgreSQL 16-compatible databases, then run count, schema, sequence, FK, and checksum reconciliation for each. Restore rehearsal must succeed before any target copy.
6. Retain all source and target backups through the agreed rollback window. Do not delete or overwrite either original database.

**Current blocker:** Replit's production query tool in this audit is read-only and does not produce a verified dump or restore rehearsal. The owner/operator must select and validate the supported production export/backup path before migration work can advance.

## 3. Dry-run reconciliation

Run only a reviewed, read-only inventory/dry-run after backups are verified. The existing scaffold can render its captured snapshot plan; it does not connect to databases. A future live dry-run must:

- Compare all source/target table names, columns, types, defaults, nullability, constraints, indexes, RLS, sequences, and relation sizes.
- Build a table-by-table PK/FK plan. Preserve source IDs and use the dependency order in `server/db/aichm-migration-plan.ts`.
- Report exact source/target counts, PK collision counts, unique-key collisions, missing FK targets, and row-level digest mismatch counts. Never print rows, phone numbers, names, emails, questionnaire answers, hashes, tokens, sessions, or secrets.
- Classify each existing target key as absent, byte/semantically identical, or conflicting. Stop on a conflict; never update an existing target row.
- Exclude `public.leads`, `public.conversations`, and `public.course_knowledge` from copy operations. Display their counts only.
- Detect admissions identity candidates without silently joining by phone. Stable `admissions_leads.id` and explicit source/submission identifiers are primary evidence. Normalized Indian phone is candidate-only; ambiguous matches require a human-approved crosswalk.

### Integrity checksum strategy

For each table and deterministic PK-ordered batch (for example, 1,000 rows):

1. Canonicalize each row with explicit type tags; normalize timestamps to UTC; sort JSON object keys; preserve array order and exact bytea bytes.
2. Compute an HMAC-SHA-256 over length-prefixed canonical rows using a one-run private audit key. Log only table name, batch ordinal, row count, and digest. Do not log or persist canonical row payloads or per-person hashes.
3. Compare source and target batch HMACs and total counts. Recompute after retries. A mismatch blocks completion.

The future key may be provisioned as `AICHM_MIGRATION_AUDIT_KEY` through Replit Secrets for the migration environment only. It is not configured or used now. The checksum of an encrypted backup file is a separate artifact-integrity check, not a row-equivalence check.

## 4. Staged schema and data preparation

1. Review a fresh additive, idempotent `aichm` schema migration. Do not execute it in this phase. Ensure it does not alter existing public tables, Supabase Auth, Storage policies, or n8n objects.
2. Make application schema/SQL access explicit for `aichm`; retain `public` in the search path only for intentionally accessed Supabase-owned tables. Use a narrowly privileged server role, no browser database client, and no broad `anon`/`authenticated` grants.
3. Apply schema only to an isolated restore/rehearsal target first. Validate RLS and role grants there.
4. Copy in dependency order with bounded transactions/batches. Persist an append-only checkpoint per table/batch and source-key digest so a rerun skips identical rows. Use insert-only/no-overwrite semantics; conflicts stop the batch and require review.
5. Preserve primary keys, enum values, timestamps, FK relationships and sequence state. Set sequences only after validating the target maximum ID.
6. Reconcile legacy public leads using a private crosswalk. Do not merge or overwrite by phone. Keep all inquiries as separate historical submissions.
7. Copy/verify App Storage assets separately, with manifest/checksum validation; retain the Replit source objects until an approved post-cutover retention date.

## 5. Verification gates

Before requesting cutover approval, verify:

- Exact per-table counts and HMAC batch checksums; zero unexplained differences.
- PK/unique constraints, validated FKs, enum/default/index/sequence state, timezone fidelity, and no migration-table replay.
- Existing `public.leads` (31), `public.conversations` (300), `public.course_knowledge` (54), their policies, and n8n/Avni use remain unchanged.
- Custom owner login with the existing scrypt hash, role, cookie/session semantics and unchanged `SESSION_SECRET`; admin authorization; LMS student/trainer access; counselling records and webhook retry metadata; VSL registration/playback tracking; Calendar schema/API; notification isolation.
- RLS tests prove private AICHM tables are inaccessible to browser roles; app server role can perform only approved operations.
- All copied media references resolve and playback is verified without deleting source objects.
- Security review of the existing mutable-search-path `public.update_updated_at_column` function and the existing public-table RLS policies.
- Restore from the verified backup remains available.

No production cutover until the owner separately approves the exact source/target identities, backup verification, reconciliation report, security/RLS review, test results, and rollback window.

## 6. Cutover, rollback and retention

At a future, separately approved cutover:

1. Freeze source writes briefly, capture a final delta and repeat count/checksum verification.
2. Switch runtime routing only after explicit approval; keep `DATABASE_URL` unchanged until this point.
3. Monitor login, CRM, admissions, counselling, LMS, attendance, Calendar and notification checks.
4. Keep the source production database intact and read-only during the agreed rollback period.
5. If rollback is needed before target writes, route back to the untouched source. If target writes have occurred, do not simply switch back; first reconcile the target delta into the source through an approved, conflict-aware procedure.
6. Remove/retire old database access and backups only after the owner approves final verification and retention expiry.
