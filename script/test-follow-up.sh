#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Only a new socket-only cluster, never either app database. No external transport.
for tool in initdb pg_ctl createdb; do command -v "$tool" >/dev/null || exit 1; done
mkdir -p generated-artifacts
test_root="$(mktemp -d "$PWD/generated-artifacts/follow-up-db-XXXXXX")"
started=false
cleanup() {
  result=$?
  trap - EXIT
  if [ "$started" = true ]; then pg_ctl -D "$test_root/data" -m fast -w stop || exit 1; fi
  rm -rf -- "$test_root"
  exit "$result"
}
trap cleanup EXIT
initdb -D "$test_root/data" -U follow_up_test --auth-local=trust --auth-host=reject --encoding=UTF8 --locale=C --no-instructions
pg_ctl -D "$test_root/data" -l "$test_root/postgres.log" \
  -o "-c listen_addresses='' -c unix_socket_directories='$test_root' -p 55447" -w start
started=true
createdb -h "$test_root" -p 55447 -U follow_up_test follow_up_test
export FOLLOW_UP_TEST_DATABASE_URL="postgresql://follow_up_test@localhost/follow_up_test?host=$test_root&port=55447"
export FOLLOW_UP_TEST_DB_APPROVAL=SOCKET_ONLY_DISPOSABLE_DATABASE
export DATABASE_URL="$FOLLOW_UP_TEST_DATABASE_URL"
npm run db:push -- --force
NODE_ENV=test npx tsx --test server/admissions/follow-up.test.ts
