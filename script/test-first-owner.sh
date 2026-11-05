#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Never use an app database: create a fresh local socket-only database and destroy it.
for tool in initdb pg_ctl createdb; do command -v "$tool" >/dev/null || exit 1; done
mkdir -p generated-artifacts
test_root="$(mktemp -d "$PWD/generated-artifacts/first-owner-db-XXXXXX")"
started=false
cleanup() {
  result=$?
  trap - EXIT
  if [ "$started" = true ]; then pg_ctl -D "$test_root/data" -m fast -w stop || exit 1; fi
  rm -rf -- "$test_root"
  exit "$result"
}
trap cleanup EXIT
initdb -D "$test_root/data" -U first_owner_test --auth-local=trust --auth-host=reject --encoding=UTF8 --locale=C --no-instructions
pg_ctl -D "$test_root/data" -l "$test_root/postgres.log" \
  -o "-c listen_addresses='' -c unix_socket_directories='$test_root' -p 55448" -w start
started=true
createdb -h "$test_root" -p 55448 -U first_owner_test first_owner_test
export FIRST_OWNER_TEST_DATABASE_URL="postgresql://first_owner_test@localhost/first_owner_test?host=$test_root&port=55448"
export FIRST_OWNER_TEST_DB_APPROVAL=SOCKET_ONLY_DISPOSABLE_DATABASE
export DATABASE_URL="$FIRST_OWNER_TEST_DATABASE_URL"
npm run db:push -- --force
NODE_ENV=test npx tsx --test server/lms/first-owner.test.ts
LMS_AUTH_TEST_DATABASE_URL="$DATABASE_URL" \
LMS_AUTH_TEST_DB_WRITE_APPROVED=I_ACKNOWLEDGE_THIS_IS_A_NONPRODUCTION_DATABASE \
NODE_ENV=test npx tsx --test server/lms/password-auth.integration.test.ts
