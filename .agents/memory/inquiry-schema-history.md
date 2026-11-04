---
name: Inquiry schema history
description: Existing counselling columns in the development database do not fully match the checked-in migration history.
---

Check the live development schema before relying on the migration journal for inquiry-table changes. Historical schema pushes mean the existing schema and migration ledger may not agree; do not assume an unapplied journal entry means its columns are missing.

**Why:** The schema was previously synchronized with `db:push`; blindly running the historical migration chain can try to add existing columns or recreate existing tables.

**How to apply:** Prefer `db:push` without forced data-loss approval for development setup and Replit Publish for managed production. Inspect the schema before replaying historical migrations; do not switch unattended setup to journal replay without reconciling its history.
