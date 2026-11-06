---
name: Supabase PostgreSQL TLS configuration
description: Secure staged connections to Supabase using node-postgres without changing the app's current database.
---

For the staged Supabase migration connection, keep the app's default `DATABASE_URL` pool unchanged. Validate the expected Supavisor target and required `sslmode`, remove `sslmode` from an in-memory URL copy, then pass the server-only CA with `rejectUnauthorized: true` and Node's normal hostname verification. Replit may provide a PEM secret with certificate markers but flattened line breaks; validate its base64 body and normalize PEM line wrapping in memory before parsing and connecting.

**Why:** The installed node-postgres connection-string parser replaces an explicit `ssl` object when an SSL query parameter is present. Also, `sslmode=require` encrypts traffic but does not verify the server certificate or hostname. Flattened PEM input can fail X.509 parsing even though its markers remain intact; normalizing the body avoids editing secrets while retaining strict verification.

**How to apply:** Use a separate, opt-in Supabase pool factory. Test the actual TLS handshake with the supplied CA before any migration work; never weaken certificate validation or switch the default app pool as part of preparation.
