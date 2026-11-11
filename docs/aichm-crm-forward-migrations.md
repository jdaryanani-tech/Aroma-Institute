# AICHM CRM forward-only migration path

The canonical CRM assignment migrations are registered only in
`migrations/crm-forward/registry.json`. They are deliberately absent from the
ordinary Drizzle journal and the separate AICHM baseline journal. This preserves
the historical record; the runner does not manufacture ledger rows or replay
older migrations.

## Fail-closed target policy

The runner reads only `AICHM_CRM_FORWARD_DATABASE_URL`. It never reads
`DATABASE_URL` or the AICHM backup-source variable. Before any schema or ledger
write, it opens a strict certificate- and hostname-verified TLS connection and
checks the server in a read-only transaction. The allowlisted Development
identity is exactly:

- database: `heliumdb`
- database OID: `16384`
- database user: `postgres`
- PostgreSQL system identifier: `7609038573599248406`
- not in recovery and not configured read-only by default

The known Production identity (`neondb`, OID `16395`, user `neondb_owner`) and
every other tuple are rejected. The values are code-pinned and are never
updated automatically. If Development is recreated or any identity field
changes, the runner stops and requires fresh manual verification and a reviewed
code change. Inability to read the system identifier also stops the runner.

The runner is explicit and is not a startup or publish hook:

```sh
AICHM_CRM_FORWARD_DATABASE_URL='<secure Development connection>' npx tsx script/crm-forward-migrate.ts
```

Do not put the URL in source, command history, output, or logs. The connection
is never printed. Before each migration transaction, the runner rechecks the
same pinned identity on its single connection.

## Ordering and prerequisites

The dedicated order is `0014_crm_canonical_assignments` followed by
`0015_crm_assignment_audit_invariants`. Before 0014, the runner requires the
existing `admissions_leads`, `lms_users`, and `lms_user_roles` tables and the
columns used by the new constraints. Before 0015, it requires a recorded 0014
entry plus the 0014 assignment/history tables, functions, and validation and
immutability triggers. It also verifies the deferred history-pairing trigger
after 0015.

If a prerequisite is missing, or if migration objects exist without matching
entries in the dedicated ledger, the runner fails for review. It does not run
0013 or any earlier migration, does not edit either old journal, and does not
insert a synthetic baseline/history row. A migration and its checksum row in
`aichm_crm_forward_meta.schema_migrations` are committed in one transaction;
that row is written only after that migration's SQL actually ran and its
postconditions passed.

The database checks enforce active-administrator actor and active admissions
assignee membership, assignment-version progression, and an immutable
same-transaction history event. These database triggers can validate that a
claimed actor currently has the admin role, but PostgreSQL alone cannot prove
which HTTP user authenticated. The application route must source the actor from
the server-authenticated `req.lmsUser` session and reject actor fields in the
client payload. The application layer is the HTTP identity trust boundary.

## Disposable CRM persistence test

`server/crm/persistence.test.ts` remains skipped by default. It requires an
explicit one-run opt-in and a proof file created by the dedicated isolated test
runner:

```sh
npx tsx script/test-crm-persistence.ts --run-isolated-ephemeral-postgres
```

That command creates a new PostgreSQL cluster under a unique mode-0700
`/dev/shm/aichm-crm-test-*` directory, binds TCP only to `127.0.0.1`, creates a
random `aichm_test_<32 hex characters>` database, and verifies the database,
user, port, data directory, recovery status, and PostgreSQL system identifier
against the cluster it just initialized. The test process receives a minimal
environment with no `DATABASE_URL`, production credential, or Replit
Development URL. The persistence test independently checks the proof and live
server identity before creating its temporary schema. Its base CRM fixture is
created directly in the disposable test schema; it does not replay migrations
0000–0013.

Cleanup uses the existing stop-confirm-remove helper. Scratch files are removed
only after `pg_ctl` confirms PostgreSQL stopped. If stop or state verification
fails, the scratch directory and PostgreSQL diagnostics are preserved and the
runner exits non-zero. This runner has not been executed as part of the current
code-only change.
