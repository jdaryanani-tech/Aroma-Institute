# Guarded development schema changes

In Development, application runtime may use `DATABASE_URL` when no explicit
least-privilege app URL is configured. Production requires
`AICHM_APP_DATABASE_URL` and fails closed; it never falls back to `DATABASE_URL`.
Legacy Drizzle schema commands never use the application runtime URL. They require both an explicit
intent and `AICHM_DEVELOPMENT_DATABASE_URL`; only local loopback targets with
an allowlisted development database name are accepted. Remote development
databases are intentionally unsupported because a URL alone cannot establish
that a remote target is not production.

## Explicit local development workflow

Start a local PostgreSQL database and create the explicitly allowlisted
database `aichm_dev_local`. Then run the guarded command with that database's
dedicated URL:

```sh
AICHM_SCHEMA_CHANGE_INTENT=development \
AICHM_DEVELOPMENT_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/aichm_dev_local' \
npm run db:push
```

`npm run db:migrate` uses the same guard. Do not set the dedicated URL to a
remote host or to a production database. The guard rejects production runtime,
missing intent, missing dedicated URL, unknown database names, non-loopback
hosts, custom Drizzle config overrides, and unsupported URL parameters. It
never reads or falls back to `DATABASE_URL`, and the Drizzle child process
receives only the dedicated local URL and the minimum required environment.

The default Drizzle config independently applies the same validation, so
invoking `drizzle-kit migrate` or `drizzle-kit push` directly without the
explicit development intent and dedicated local URL also fails closed.
`db:generate` is non-mutating and uses `drizzle.generate.config.ts`.

## Tests and post-merge behavior

Disposable integration tests may use `AICHM_SCHEMA_CHANGE_INTENT=disposable-test`
with `NODE_ENV=test` and their dedicated database URL. TCP targets must be
loopback and named `aichm_test_*`. Existing socket-only tests are limited to the
known test database names and socket paths under `generated-artifacts/`.

The Replit post-merge hook never runs a schema command. It prints a skip message
and continues with typechecking, tests, and build.

The separate AICHM forward-baseline runner is not a legacy Drizzle path. It
retains its own explicit scratch-only target validation and does not accept
`DATABASE_URL`.
