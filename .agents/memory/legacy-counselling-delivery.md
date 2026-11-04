---
name: Legacy counselling delivery
description: How to handle counselling inquiries created before webhook delivery tracking existed.
---

Do not replay older counselling inquiries whose delivery outcome was never recorded. Ask those leads to complete the counselling form again.

**Why:** The user chose lead resubmission instead of best-effort replay for legacy records with unknown delivery outcomes.

**How to apply:** Keep legacy untracked inquiries ineligible for resend. Allow an admin-confirmed resend only for tracked failures with the original saved payload and timestamp.
