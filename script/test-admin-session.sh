#!/usr/bin/env bash
set -euo pipefail

# Requires PostgreSQL tools and an installed Playwright Chromium browser.
# All schema/data writes target a new socket-only cluster, never the app database.
cd "$(dirname "$0")/.."
for command in initdb pg_ctl createdb; do
  if ! command -v "$command" >/dev/null; then
    echo "Admin-session tests require the PostgreSQL tool: $command" >&2
    exit 1
  fi
done

mkdir -p generated-artifacts
test_root="$(mktemp -d "$PWD/generated-artifacts/admin-session-db-XXXXXX")"
cluster_started=false

cleanup() {
  status=$?
  trap - EXIT
  if [ "$cluster_started" = true ]; then
    if ! pg_ctl -D "$test_root/data" -m fast -w stop; then
      echo "Could not stop the disposable PostgreSQL cluster at $test_root" >&2
      exit 1
    fi
  fi
  rm -rf -- "$test_root"
  exit "$status"
}
trap cleanup EXIT

initdb -D "$test_root/data" -U admin_session_test \
  --auth-local=trust --auth-host=reject --encoding=UTF8 --locale=C --no-instructions
pg_ctl -D "$test_root/data" -l "$test_root/postgres.log" \
  -o "-c listen_addresses='' -c unix_socket_directories='$test_root' -p 55446" -w start
cluster_started=true
createdb -h "$test_root" -p 55446 -U admin_session_test admin_session_test

export LMS_AUTH_TEST_DATABASE_URL="postgresql://admin_session_test@localhost/admin_session_test?host=$test_root&port=55446"
export AICHM_SCHEMA_CHANGE_INTENT=disposable-test
export AICHM_DEVELOPMENT_DATABASE_URL="$LMS_AUTH_TEST_DATABASE_URL"
export NODE_ENV=test
export LMS_AUTH_TEST_DB_WRITE_APPROVED=I_ACKNOWLEDGE_THIS_IS_A_NONPRODUCTION_DATABASE
DATABASE_URL="$LMS_AUTH_TEST_DATABASE_URL" npm run db:push -- --force
npm run build
NODE_ENV=test npx tsx --test \
  server/lms/admin-session.integration.test.ts \
  server/lms/password-auth.integration.test.ts
