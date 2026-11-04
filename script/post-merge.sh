#!/usr/bin/env bash
set -euo pipefail

# Reinstall from the committed lockfile, synchronize the development schema,
# then verify the merged app before workflow restart.
npm ci --no-audit --no-fund
# Development has historically used schema push; replaying the migration
# journal can collide with existing columns. Never pass --force: destructive
# or ambiguous changes must be reviewed, not approved by unattended setup.
npm run db:push </dev/null
npm run check
npm test
npm run build
