---
name: Supabase schema metadata comparison
description: Comparing generated PostgreSQL table metadata across source and target schemas without false default-expression mismatches.
---

When validating a schema copied from `public` into an app-owned schema, compare column defaults semantically after normalizing schema qualification for sequence `regclass` references and custom enum casts. PostgreSQL may deparse equivalent defaults with a schema-qualified name in one schema and an unqualified name in another. Keep comparison strict for all other expression details.

**Why:** exact string comparison of `information_schema.columns.column_default` incorrectly rejected equivalent sequence and enum defaults during the empty-schema verification.

**How to apply:** use a consistent `search_path` on both connections and canonicalize only known schema-qualified sequence/enum references before comparing source and target metadata. Never weaken the comparison by ignoring all default expressions.
