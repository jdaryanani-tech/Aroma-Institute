# Guarded development schema changes

The application runtime continues to use `DATABASE_URL`. Schema-changing
commands must not use that ambient value.

## Development database setup

Configure these values in the Replit **Development** environment only:

- `AICHM_DEVELOPMENT_DATABASE_URL`: a dedicated development database connection.
- `AICHM_SOURCE_PROD_DATABASE_URL`: the existing authoritative production-source
  connection, used only by the guard for a strict-TLS, read-only identity check.
- `AICHM_DEVELOPMENT_DATABASE_ID`: the identity fingerprint emitted by the
  read-only identification command below.

No connection string or credential is printed by the guard.

```sh
AICHM_SCHEMA_CHANGE_INTENT=development npm run db:identify:development
```

Copy the printed fingerprint to `AICHM_DEVELOPMENT_DATABASE_ID` in the
Development environment. The fingerprint covers the connected database, role,
server address/port/version, and configured endpoint. It is not a credential.
Repeat identification after the development database identity changes.

## Apply an approved development schema change

```sh
AICHM_SCHEMA_CHANGE_INTENT=development npm run db:push
AICHM_SCHEMA_CHANGE_INTENT=development npm run db:migrate
```

Both commands require the explicit intent, dedicated development URL, valid
allowlisted identity fingerprint, and a successful strict-TLS read-only check
of the configured production primary. The guard rejects an unknown target,
production identity, replica, missing production identity, missing allowlist,
and production runtime. The Drizzle child process receives the dedicated
development URL and verified identity only; it does not receive `DATABASE_URL`
or the production connection secret.

`db:generate` is non-mutating and uses `drizzle.generate.config.ts`, which has
no database credentials. The default `drizzle.config.ts` refuses to load unless
invoked by the guarded wrapper. The AICHM forward-only baseline remains on its
separate scratch-only configuration.

The post-merge hook skips schema synchronization unless
`AICHM_SCHEMA_CHANGE_INTENT=development` is explicitly set. If it is set but
any identity check fails, the guarded command exits non-zero before Drizzle is
started.

## Disposable socket-only integration tests

The first-owner, counselling follow-up, and LMS admin integration scripts create
temporary PostgreSQL clusters under `generated-artifacts/`, bind only through
Unix sockets, and use the explicit `disposable-test` intent. The guard still
checks the production primary read-only and permits only their known test
database names and generated-artifacts socket paths.
