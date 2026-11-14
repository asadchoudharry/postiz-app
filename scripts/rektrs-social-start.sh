#!/bin/sh
# REKTRS Social staged release entrypoint.
# Invariant: a container restart never applies schema changes or publishes content.
set -eu

if [ "$(printenv REKTRS_ALLOW_AUTOMATIC_SCHEMA_SYNC 2>/dev/null || printf false)" != "false" ]; then
  echo "REFUSED: automatic schema sync is disabled in the REKTRS runtime." >&2
  exit 64
fi

# Apply any reviewed schema changes separately, after an isolated restore.
nginx
pnpm --filter ./apps/backend run pm2
pnpm --filter ./apps/orchestrator run pm2
pnpm --filter ./apps/frontend run pm2
exec pm2 logs
