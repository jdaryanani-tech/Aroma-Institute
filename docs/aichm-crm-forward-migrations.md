# AICHM CRM forward-only migration path

The canonical CRM assignment migrations are registered only in
`migrations/crm-forward/registry.json`. They are deliberately absent from the
ordinary Drizzle journal and the separate AICHM baseline journal. This preserves
the historical record; the runner does not manufacture ledger rows or replay
older migrations.

## Fail-closed target policy

**This approved CRM forward path uses a non-TLS database connection. The
connection itself is not encrypted with TLS. This trade-off is restricted to
the matching internal Replit Helium Development endpoint; it is not a general
remote-database mode and must never be used for Production or arbitrary hosts.**

The runner requires `AICHM_CRM_FORWARD_DATABASE_URL` as its only connection
source. It reads `DATABASE_URL` only as an in-memory, compare-only reference; it
never uses that value to construct a pool or as a fallback. Before opening a
socket, it parses both URLs and requires their normalized host, effective port
(fixed `5432` when omitted), username, and database name to match. The verified
Replit Helium service hostname is the exact single-label `helium`; the guard
also retains explicit RFC1918 IPv4 and `.internal` cases. It rejects arbitrary
single-label names and public DNS/IP endpoints. Runtime URL query overrides for
host, port, user, password, or database are rejected so the comparison cannot
silently disagree with the app's `pg` parser.

The dedicated AICHM URL must contain exactly one query parameter,
`sslmode=disable`. Any TLS-enabled mode, duplicate, extra parameter, missing
mode, public host, absent/malformed runtime `DATABASE_URL`, or endpoint
mismatch fails before a socket is opened. The pool is explicitly configured
with `ssl: false`; no TLS helper or certificate option is used in this mode.
Stable user-facing failure codes identify these Development-only rejection
cases without printing either URL or any component.

After the endpoint preflight, the runner verifies the live server in a
read-only transaction before any metadata query or write. The allowlisted
Development identity is exactly:

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

The runner is not a startup or publish hook. It defaults to a read-only preview
and requires the named Development URL even for that preview. The preview
connects only to verify the pinned identity and current migration state; it
reports a sanitized identity match, migration registry/ledger status, whether
the ledger schema and table exist and contain rows, per-migration recorded
checksum matches, schema state, prerequisites, conflicts, and exactly which
files are pending. It does not create the custom ledger:

```sh
npx tsx script/crm-forward-migrate.ts --preview
```

Applying requires both `--apply-crm-migrations` and the exact confirmation
variable `AICHM_CRM_FORWARD_APPLY_CONFIRM=APPLY_CRM_FORWARD_MIGRATIONS_TO_PINNED_DEVELOPMENT`.
Without both, the runner cannot apply. Supply the URL through a securely
configured environment, not source or command history:

```sh
npx tsx script/crm-forward-migrate.ts --apply-crm-migrations
```

The apply path prints the verified preview, obtains a database advisory lock
after checking identity, then rechecks identity and state under the lock before
writing. It revalidates the pinned identity immediately before each migration
and ledger write and releases the lock in a `finally` path; if unlock cannot be
confirmed, it destroys the connection so PostgreSQL releases the session lock.
The URL and database errors are never printed. Only allowlisted stable error
codes/categories may appear in the sanitized runner diagnostic. Failures also
identify the phase (including lock, app-role gate, ledger setup, individual
migration execution/postcondition/ledger commit, unlock, and final readiness);
when a migration phase fails, its ID is limited to the four registered CRM
migrations. Raw error text, stack traces, SQL, URLs, and credentials are never
reported.

## Ordering and prerequisites

The dedicated order is `0014_crm_canonical_assignments`, then
`0015_crm_assignment_audit_invariants`, then
`0016_crm_runtime_role_separation`, then `0017_meta_lead_ads_schema`. Before 0014, the runner requires the
existing `admissions_leads`, `lms_users`, and `lms_user_roles` tables and the
columns used by the new constraints. Before 0015, it requires a recorded 0014
entry plus the 0014 assignment/history tables, functions, and validation and
immutability triggers. Before 0016, it requires a recorded 0015 entry and the
assignment/history tables and deferred history-pairing trigger. It verifies
the complete stage-specific postconditions after each migration. Before 0017,
it requires a matching 0016 ledger checksum, the reviewed application-role
pre-migration gate, the required `admissions_leads` and `inquiries` columns,
and no pre-existing Meta table, index, or conflicting relation. Any partial
Meta installation is a conflict and stops the runner.

Migration 0017 is the approved semantic installation of the four additive
tables and nine indexes defined by historical
`migrations/0012_meta_lead_measurement.sql`: consent events, lead touchpoints,
Meta lead crosswalks, and the outbound event queue. It does not replay 0012,
run 0013, backfill records, or alter `admissions_leads`/`inquiries`. The
historical Drizzle journal remains unchanged. A prior read-only inspection
recorded the 0012 journal entry but no matching checksum in the live Drizzle
ledger; this remains a migration-policy reconciliation question and is not
resolved by inventing a Drizzle ledger row or rewriting history. Do not use
ordinary `db:migrate` or `db:push` to install these CRM objects.

The new tables are owned by the non-login `aichm_crm_owner`. When needed, 0017
temporarily grants that owner `CREATE` on `public` solely to transfer ownership,
then restores the prior privilege state inside the same migration transaction.
It grants `aichm_app_runtime` only `SELECT, INSERT` on the link and touchpoint
tables and `SELECT, INSERT, UPDATE` on the consent and outbox tables. It grants
no `DELETE`, `TRUNCATE`, `REFERENCES`, or `TRIGGER` rights, and does not alter
the reviewed base-table or sequence grants on `admissions_leads` and
`inquiries`. Postconditions verify all columns/defaults, foreign-key and
check-constraint definitions/actions, primary and explicit indexes, ownership,
effective privileges, direct ACLs, and absence of sequences on the four tables.

If a prerequisite is missing, or if migration objects exist without matching
entries in the dedicated ledger, the runner fails for review. Postconditions
compare the exact assignment-table columns/defaults, constraints and foreign-key
actions, indexes and predicates, trigger event/timing/enabled state, relevant
PL/pgSQL source/configuration, and the history-table PUBLIC mutation grants.
Unexpected, missing, disabled, or drifted objects fail closed. It does not run
0013 or any earlier migration, does not edit either old journal, and does not
insert a synthetic baseline/history row. A migration and its checksum row in
`aichm_crm_forward_meta.schema_migrations` are committed in one transaction;
that row is written only after that migration's SQL actually ran and its
postconditions passed. The control ledger schema/table may be created and
committed separately before the first migration transaction, so a failed first
migration can leave an empty ledger without any migration entry.

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
0000–0013. The suite then applies 0017 after 0014–0016 twice, checks ownership,
ACL and catalog postconditions, exercises allowed runtime reads/writes and
denied mutations, and confirms that 0017 leaves existing `admissions_leads`
and `inquiries` rows unchanged.

Every subprocess has a bounded timeout. SIGINT/SIGTERM requests stop active
children and enter the same cleanup path; cleanup status/stop commands remain
available during signal handling. Scratch files are removed only after `pg_ctl`
confirms PostgreSQL stopped. If stop or state verification fails, the scratch
directory and PostgreSQL diagnostics are preserved and the runner exits
non-zero.
