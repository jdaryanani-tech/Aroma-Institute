---
name: First-owner recovery boundary
description: Why one-time owner creation must stay separate from later owner recovery.
---

First-owner bootstrap must not promote, activate, or reset an existing account,
even when its phone matches the approved owner. Existing-account recovery is a
separate authorization decision. Unrelated student accounts must remain unchanged.

**Why:** The owner explicitly restricted the bootstrap to creating the first
administrator without altering existing accounts. Permanent closure is intentional,
including when a setup link is lost or an admin role is later removed.

**How to apply:** Do not delete audit evidence, relax the zero-admin guard or rerun
bootstrap to resolve later access problems. Explain the recovery blocker and seek
approval for a separately verified, audited recovery action. The owner confirmed
that republishing after adding the production bootstrap secret enabled setup and
sign-in; verify the published app has received secret changes before troubleshooting
the first-owner page as a code failure.
