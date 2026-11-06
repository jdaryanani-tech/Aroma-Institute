# AICHM migration exceptions and Supabase backup status

**As of:** 2026-11-06  
**Scope:** Read-only exception review and encrypted Supabase backup/restore rehearsal only. No mapping decision or data import was performed.

## Identity exceptions

Case labels are assigned by stable primary-key sort order within the source table. Raw identifiers and personal fields are intentionally omitted.

### Custom-auth users

The source has three `lms_users` records; the target `aichm.lms_users` and `aichm.lms_user_roles` tables are empty. No record was matched or moved to Supabase Auth. The migration run requires an authorized reconciliation decision for every custom-auth user.

| Case | Source entity | Dependent records | Why unresolved | Safe human decision options |
| --- | --- | --- | --- | --- |
| CASE-AUTH-01 | Custom-auth user | 1 role row; 1 enrollment row | No approved reconciliation entry exists for this account. | Approve preserving this account as a distinct custom-auth row with its stable source key and role; or leave it held pending verification. |
| CASE-AUTH-02 | Custom-auth user | 1 role row; 5 audit rows | No approved reconciliation entry exists for this account. | Approve preserving this account as a distinct custom-auth row with its stable source key and role; or leave it held pending verification. |
| CASE-AUTH-03 | Custom-auth user | 2 role rows | No approved reconciliation entry exists for this account. | Approve preserving this account as a distinct custom-auth row with its stable source key and roles; or leave it held pending verification. |

The 10 dependent role, enrollment, and audit rows must remain blocked until their parent account decisions are approved. Password material and role values are not included in this report.

### Admissions lead

| Case | Source entity | Matching evidence | Dependent records | Why unresolved | Safe human decision options |
| --- | --- | --- | --- | --- | --- |
| CASE-LEAD-01 | Admissions lead | No exact stable-ID match was found in `public.leads`. One normalized-phone candidate was found among 31 public leads; this is phone-only evidence, not proof of identity. | 1 inquiry, 1 VSL event, 1 playback | No signed, reviewed crosswalk exists. The source lead is not linked to any public lead. | A reviewer may approve a crosswalk only after verifying identity with evidence beyond phone; approve a distinct AICHM lead if confirmed to be a separate person; or leave it held. Never overwrite the existing public lead. |

The three lead-dependent records remain blocked pending the lead decision. No phone number, name, email, or raw identifier is included.

## Refreshed encrypted Supabase backup

- Encrypted artifact: `.local/aichm-backup-export/aichm-supabase-application-2026-11-06T15-28-16-554Z-b8e173217c2b.dump.aesgcm`
- Manifest: `.local/aichm-backup-export/aichm-supabase-application-2026-11-06T15-28-16-554Z-b8e173217c2b.manifest.json`
- Created: `2026-11-06T15:28:16.554Z`
- Ciphertext size: 170,266 bytes
- Ciphertext SHA-256: `a9f0ef53848691393d9de3dc8ab7249a0210615b1f428bfc07b9f85c58c86b2b`
- Plaintext archive SHA-256: `e7d24e20a50321b8fccbe476f03ba7440939367101088eb6918d7584390bddfc`
- `pg_dump` 17.6 completed with exit code 0 against PostgreSQL 17.11.
- AES-GCM authentication and streamed plaintext checksum verification passed.
- Isolated restore **failed**: `pg_restore_disposable_object_conflict`, exit code 1. The encrypted artifact is retained for diagnosis; the restore is not marked verified. Scratch restore data was removed. The failing object was not inspected.

Counts captured in the backup manifest:

- 34 AICHM application tables in `aichm`: **0 rows each**.
- Migration control tables: `schema_migrations` **2**; `migration_checkpoints` **0**; `migration_crosswalk` **0**.
- Preserved public tables: `leads` **31**; `conversations` **301**; `course_knowledge` **54**.

## Safety status

No source or Supabase application records were copied, updated, or deleted. No schema, permissions, routing, or deployment was changed. Do not proceed to data migration until the isolated restore failure is resolved and the four parent identity cases receive explicit human decisions.
