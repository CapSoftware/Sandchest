#!/usr/bin/env bash
# Builds the web app the way the deploy does: from a clean checkout of HEAD,
# with no .env files and no server settings. A page that reads the database,
# the session or server config while it is prerendered fails here instead of
# in the deploy. Run before pushing: `bun run check:build`.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
dir=$(mktemp -d)/sandchest-build
git -C "$root" worktree add --quiet --detach "$dir" HEAD
cleanup() { git -C "$root" worktree remove --force "$dir" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cd "$dir"
bun install --frozen-lockfile >/dev/null
# Only what any build has: the public address, never secrets or a database.
env -i PATH="$PATH" HOME="$HOME" NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_SITE_URL=https://example.com \
  bun run --cwd apps/web build
