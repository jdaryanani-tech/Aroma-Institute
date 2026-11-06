---
name: Replit production pg_dump TLS
description: Verified libpq trust configuration for the AICHM production database backup.
---

For the AICHM production PostgreSQL source, libpq 17.6 successfully completed a read-only connection using `PGSSLMODE=verify-full` and `PGSSLROOTCERT=system`. The server certificate chain and hostname were authorized through the system trust store. Replit's documented Production Database Settings expose connection and advanced connection details; no downloadable source CA was documented in the checked docs.

**Why:** The app's Node PostgreSQL pool had already verified TLS, but the separate `pg_dump` libpq client initially lacked an explicit root certificate setting and failed at SSL.

**How to apply:** Keep strict `verify-full` and set `PGSSLROOTCERT=system` for production-source libpq tools. Do not reuse the Supabase CA for this source or weaken TLS verification.
