#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Schema pushes are intentionally opt-in. Production uses reviewed migrations.
if [ "${ALLOW_DB_SCHEMA_PUSH:-false}" = "true" ]; then
  pnpm --filter @workspace/db run push
fi
