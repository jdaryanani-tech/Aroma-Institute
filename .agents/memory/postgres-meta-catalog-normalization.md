---
name: PostgreSQL Meta catalog normalization
description: PostgreSQL catalog deparsing differences that matter when checking Meta schema postconditions.
---

PostgreSQL may deparse a declared `CHECK (column IN (...))` as `column = ANY (ARRAY[...])`, and may display the default null ordering explicitly for a descending index key. These are catalog presentation differences, not permission to accept changed checks or indexes.

**Why:** isolated PostgreSQL verification exposed both transformations while validating the additive Meta schema.

**How to apply:** normalize only known equivalent syntax for check expressions; validate index key order, direction, null ordering, collation, and operator class from catalog fields, while also checking the normalized full index definition. Keep all other mismatches fail-closed.
