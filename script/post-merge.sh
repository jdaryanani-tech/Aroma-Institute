#!/usr/bin/env bash
set -euo pipefail

# Reinstall from the committed lockfile, apply additive migrations to the
# development database, then verify the merged app before workflow restart.
npm ci --no-audit --no-fund
npm run db:migrate
npm run check
npm test
npm run build
