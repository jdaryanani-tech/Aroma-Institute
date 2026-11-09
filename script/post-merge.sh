#!/usr/bin/env bash
set -euo pipefail

# Reinstall from the committed lockfile, synchronize the development schema,
# then verify the merged app before workflow restart.
npm ci --no-audit --no-fund
# Schema synchronization is opt-in and must pass the same production-identity
# and development-target guard as manual db:push. Without explicit intent, skip.
if [[ "${AICHM_SCHEMA_CHANGE_INTENT:-}" == "development" ]]; then
  npm run db:push </dev/null
else
  echo "Skipping post-merge schema sync: explicitly set AICHM_SCHEMA_CHANGE_INTENT=development to enable the guarded development target."
fi
npm run check
npm test
npm run build
