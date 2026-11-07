---
name: AICHM operational database
description: Owner-approved source-of-truth boundary for AICHM runtime data and legacy Supabase reconciliation.
---

Replit PostgreSQL is the sole operational database for AICHM application reads and writes. Supabase is a temporary legacy migration source only; do not use it as an app runtime database or mutate its existing records. Preserve existing Supabase leads, conversations, and course-knowledge records. Reconcile legacy identities through stable IDs and explicit human-reviewed crosswalks; a phone match alone is not sufficient to merge people.

**Why:** The owner explicitly selected the existing Replit PostgreSQL database as AICHM's operational source of truth and asked that Supabase legacy records remain intact during this change.

**How to apply:** Keep the main runtime pool on `DATABASE_URL`. Restrict Supabase access to explicit, read-only migration/import paths until a separately reviewed import is authorized. Do not apply schema or data changes in production without the owner's release approval.
