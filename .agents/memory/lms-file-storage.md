---
name: LMS file storage
description: Workspace storage setup constraint for secure learning resources.
---

Replit App Storage's SDK requires a provisioned default bucket. In this workspace, resolving that bucket failed at server startup, so LMS learning files use the existing PostgreSQL database instead.

**Why:** A missing App Storage bucket prevented the application from starting, while the existing database is already configured and persistent.

**How to apply:** Keep any new LMS resource storage bounded and private in the database unless App Storage is explicitly provisioned and verified before the SDK is initialized.
