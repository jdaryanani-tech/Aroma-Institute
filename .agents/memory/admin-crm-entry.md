---
name: CRM entry point decision
description: Keep the admissions CRM at /admin rather than introducing /crm.
---

Keep `/admin` as the CRM entry point for now. Do not create `/crm` or redirect `/admin` there without a new user decision.

**Why:** The user explicitly decided to retain the working `/admin` entry point while completing the lifecycle CRM and iPhone/PWA experience.

**How to apply:** Extend the existing admin authentication and dashboard. Preserve the separate LEAP login and learning portal.
