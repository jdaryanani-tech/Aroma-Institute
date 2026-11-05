---
name: Isolated authentication testing
description: Verify actual authentication without asking for user credentials or writing test identities into the app database.
---

A missing externally provisioned test database need not block authentication verification. Check for installed PostgreSQL server tools before asking the user to arrange one.

**Why:** This Nix host can run a disposable, Unix-socket-only PostgreSQL cluster. That allows real password verification, authorized test identities, and persistent-cookie browser checks without touching application data or requesting an end user's credentials.

**How to apply:** Keep the temporary cluster isolated with TCP disabled, apply the current schema only to that empty database, and stop and remove it afterward. Do not repoint the preview or use the managed application database for test fixtures. Follow the project's testing instructions for prerequisites.
