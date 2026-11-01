#!/bin/sh
# Migrates the database (safe to run on every start, and from several servers at once), then starts the server.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. With docker compose it is built from POSTGRES_PASSWORD in .env." >&2
  exit 2
fi
# The World stores workflow runs in the same database unless told otherwise.
export WORKFLOW_POSTGRES_URL="${WORKFLOW_POSTGRES_URL:-$DATABASE_URL}"

# Scan workspaces left by a server that stopped mid-scan. One server per container, so none is in use.
find "${TMPDIR:-/tmp}" -mindepth 1 -maxdepth 1 -name 'sandchest-*' -exec rm -rf {} +

node /app/migrate.mjs
exec node /app/server.mjs
