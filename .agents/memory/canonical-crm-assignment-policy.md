---
name: Canonical CRM assignment policy
description: AICHM CRM authorization and the distinction between canonical lead assignments and legacy inquiry-level ownership.
---

CRM access is role-scoped: admins have full CRM access; admissions users can access only canonical leads assigned to their authenticated account; trainer, student, academic coordinator, and operations roles have no CRM access. Assignment is per canonical `admissions_leads` lead, not per inquiry. Existing inquiry-level CRM owner values remain legacy review data and must not be bulk-converted or treated as canonical assignments.

**Why:** The owner explicitly set this least-privilege policy because multiple inquiry records can belong to one canonical lead, and historical inquiry owners can conflict.

**How to apply:** Enforce authorization on the server before list, detail, update, or conversation reads. Only admins may assign or reassign to an active admissions user. Require a reason and preserve append-only assignment history. Keep legacy inquiry owners admin-visible for manual review; never auto-backfill them.
