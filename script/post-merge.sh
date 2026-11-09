#!/usr/bin/env bash
set -euo pipefail

# Reinstall from the committed lockfile, then verify the merged app before
# workflow restart. Schema synchronization is deliberately never automatic.
npm ci --no-audit --no-fund
echo "Skipping post-merge schema sync. Run an explicitly guarded development-only command when a schema change is intended."
npm run check
npm test
npm run build
