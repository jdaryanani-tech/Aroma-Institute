# Supabase public-table least-privilege proposal

**Status: review only — NOT APPLIED.** This document is a proposed change, not a
migration or an instruction to run it now. No Supabase grant, policy, schema,
data, or migration-ledger change was made for this review.

## Scope and evidence basis

The proposal is limited to table-level grants for:

- `public.leads`
- `public.conversations`
- `public.course_knowledge`

The basis is the owner-reported read-only catalog query from 2026-11-21, not a
query run by this proposal. It reports that both `anon` and `authenticated`
have `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REFERENCES`, `TRIGGER`, and
`TRUNCATE` on each table, with no grant option. The reported policies are none
on `leads` and `conversations`, and one `authenticated` `SELECT` policy on
`course_knowledge` restricted to `status = 'published'`.

Re-run the preflight below on the intended Supabase primary immediately before
any separately approved change. Stop if the observed grants, role memberships,
table owners, RLS flags, or policy inventory differ from the supplied
observation. In particular, do not use this proposal to remove access supplied
by `PUBLIC`, inherited roles, or another client.

## Proposed grant change

This removes direct table privileges from `anon` and `authenticated` on all
three tables, then restores only authenticated `SELECT` on
`course_knowledge`. Its existing published-row RLS policy must remain enabled
and unchanged. The SQL does not change policies, table owners, schema, rows,
functions, default privileges, other roles, or migration history. It does not
grant any option to delegate privileges.

Run only after review and explicit approval, and only if the preflight matches:

```sql
BEGIN;

REVOKE ALL PRIVILEGES ON TABLE
  public.leads,
  public.conversations,
  public.course_knowledge
FROM anon, authenticated;

GRANT SELECT ON TABLE public.course_knowledge TO authenticated;

COMMIT;
```

The `course_knowledge` policy is not recreated or modified. Confirm after the
change that its existing `authenticated` `SELECT` policy still restricts rows
to `status = 'published'`.

## Read-only preflight

Run these queries against the intended primary, before the proposed SQL. They
read catalog and privilege metadata only; they do not read application rows.

### 1. Table identity, owner, and row-security flags

```sql
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  c.relkind,
  owner.rolname AS table_owner,
  c.relrowsecurity AS row_level_security_enabled,
  c.relforcerowsecurity AS row_level_security_forced
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_roles AS owner ON owner.oid = c.relowner
WHERE n.nspname = 'public'
  AND c.relname IN ('leads', 'conversations', 'course_knowledge')
ORDER BY c.relname;
```

Expect exactly these three ordinary tables and record their owners/RLS flags.
Stop if a table is missing, has an unexpected relation kind, or its RLS state
differs from the approved baseline.

### 2. Direct table ACL entries and grant-option status

```sql
SELECT
  c.relname AS table_name,
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
  grantor.rolname AS grantor,
  acl.privilege_type,
  acl.is_grantable
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(
  COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))
) AS acl
LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = acl.grantor
WHERE n.nspname = 'public'
  AND c.relname IN ('leads', 'conversations', 'course_knowledge')
  AND (
    acl.grantee = 0
    OR grantee.rolname IN ('anon', 'authenticated')
  )
ORDER BY c.relname, grantee, acl.privilege_type, grantor;
```

The supplied observation implies 42 direct grant entries: seven privileges for
each of two roles on each of three tables, all with `is_grantable = false`.
Record the actual grantors. Stop rather than expanding the proposal if the ACL
is not exactly accounted for; this proposal intentionally does not revoke
`PUBLIC` privileges or alter other grantors/roles.

### 3. Effective privileges, including inherited access

```sql
WITH target_tables(table_name) AS (
  VALUES ('leads'), ('conversations'), ('course_knowledge')
),
target_roles(role_name) AS (
  VALUES ('anon'), ('authenticated')
)
SELECT
  r.role_name,
  t.table_name,
  has_table_privilege(r.role_name, 'public.' || t.table_name, 'SELECT') AS can_select,
  has_table_privilege(r.role_name, 'public.' || t.table_name, 'INSERT') AS can_insert,
  has_table_privilege(r.role_name, 'public.' || t.table_name, 'UPDATE') AS can_update,
  has_table_privilege(r.role_name, 'public.' || t.table_name, 'DELETE') AS can_delete,
  has_table_privilege(r.role_name, 'public.' || t.table_name, 'REFERENCES') AS can_references,
  has_table_privilege(r.role_name, 'public.' || t.table_name, 'TRIGGER') AS can_trigger,
  has_table_privilege(r.role_name, 'public.' || t.table_name, 'TRUNCATE') AS can_truncate
FROM target_roles AS r
CROSS JOIN target_tables AS t
ORDER BY r.role_name, t.table_name;
```

Before the change, verify the supplied effective-privilege observation. After
the change, expect every value to be `false`, except `authenticated.can_select`
for `course_knowledge`, which should be `true`. These checks include privileges
available through role membership, not only direct ACL entries. Stop if
unexpected effective access remains.

### 4. RLS policy inventory

```sql
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_catalog.pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('leads', 'conversations', 'course_knowledge')
ORDER BY tablename, policyname;
```

Before and after, compare this output with the approved baseline: no policies on
`leads` or `conversations`, and the existing `authenticated` `SELECT` policy
on `course_knowledge` with the published-status predicate. Do not drop,
recreate, broaden, or otherwise change that policy as part of this proposal.

## Read-only postflight

After an approved application, rerun queries 1–4. Confirm:

1. All three table identities, owners, and RLS flags are unchanged.
2. `anon` has no effective table privilege on any of the three tables.
3. `authenticated` has no effective privilege on `leads` or
   `conversations`, and only `SELECT` on `course_knowledge`.
4. No `anon` or `authenticated` ACL entry has a grant option.
5. The policy inventory is unchanged, including the published-row policy.

If any condition fails, stop dependent client access and use the rollback below
only after confirming that it is appropriate for the current ACL state.

## Exact privilege-set rollback

This restores only the seven privileges reported for `anon` and
`authenticated` on the three named tables. It does not restore grant options,
change policies, or touch other roles or objects. Run only as a separately
approved recovery action after a read-only ACL/effective-access check.

```sql
BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE
  public.leads,
  public.conversations,
  public.course_knowledge
TO anon, authenticated;

COMMIT;
```

The preflight records the original grantor. The privilege set above is the
reported rollback target; if restoration must also preserve the original
grantor identity, execute under the original authorized grantor/owner and
verify the resulting ACL against the saved preflight output. Do not add
`WITH GRANT OPTION`.

## Application compatibility checks before approval

The current application source has no `@supabase/supabase-js` dependency,
`createClient` use, or direct browser REST request for these tables. The AVNI
transcript reader is server-side and uses a dedicated PostgreSQL reader
connection with bounded `aichm_private` RPCs; it is designed not to have direct
`SELECT` on `public.leads` or `public.conversations`. The repository's
`20261107_aichm_two_database_contract.sql` is marked not applied, so its
proposed grants are not evidence of live privileges.

This source audit does not establish which credentials or roles active n8n or
other external clients use. Repository documentation says the AICHM Chat Bot
uses Supabase nodes, but does not prove whether those nodes access these tables
directly or which role they use today. Before approval, an owner must inventory
the active workflows and other Supabase consumers, confirm their actual roles
and table/API calls, and test the intended published-content read path. The
proposed change may break any consumer relying on the currently reported broad
`anon` or `authenticated` grants. Do not proceed until those dependencies and
the preserved `course_knowledge` policy behavior are confirmed.

**No live catalog was queried for this document, and the proposal has NOT been
applied.** No database grants, policies, schema, rows, migration ledger,
credentials, workflows, or deployment were changed.
