---
name: Inquiry schema history
description: Existing counselling columns in the development database do not fully match the checked-in migration history.
---

Check the live development schema before relying on the migration journal for inquiry-table changes. The `counselling_answers` column already exists in the development database even though older migration snapshots do not record it, and there is no Drizzle migration ledger table.

**Why:** The schema was previously synchronized with `db:push`; blindly running the historical migration chain can try to add existing columns or recreate existing tables.

**How to apply:** Prefer `db:push` for development schema changes and Replit Publish for managed production. If adding a migration that includes the existing counselling column, keep that statement idempotent with `IF NOT EXISTS`.
