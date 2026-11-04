#!/usr/bin/env bash
# End to end on the real image with Forgejo instead of a GitHub App: docker compose up from a fresh
# volume with only FORGEJO_* set, the sync that records the bot's repositories and adds the webhook,
# recon, a signed pull request webhook through to a commit status, a review and a comment, and sign-in
# with Forgejo through to the dashboard. Forgejo and the model are fakes (docker/test/fakes.mjs).
#
#   docker build -f docker/Dockerfile -t sandchest:local .
#   docker/test/e2e-forgejo.sh
#
# Env: SANDCHEST_IMAGE (default sandchest:local), E2E_PORT (3000), E2E_PROJECT (sandchest-e2e-forgejo),
# E2E_KEEP=1 to leave the stack running. Containers and volumes are removed at the end.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DOCKER_DIR=$(dirname "$HERE")
PORT=${E2E_PORT:-3000}
PROJECT=${E2E_PROJECT:-sandchest-e2e-forgejo}
IMAGE=${SANDCHEST_IMAGE:-sandchest:local}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sandchest-e2e-forgejo.XXXXXX")
BASE="http://localhost:$PORT"

compose() { docker compose -p "$PROJECT" --env-file "$WORK/.env" -f "$DOCKER_DIR/compose.yml" -f "$HERE/compose.test.yml" -f "$HERE/compose.forgejo.yml" "$@"; }
sql() { compose exec -T postgres psql -U postgres -d sandchest -tAc "$1"; }
contains() {
  local text
  text=$(cat)
  grep -q "$@" <<<"$text"
}
step() { printf '\n== %s\n' "$*"; }
pass() { printf '   ok: %s\n' "$*"; }
fail() {
  printf '   FAILED: %s\n' "$*" >&2
  compose logs --no-color --tail 80 web >&2 || true
  exit 1
}
expect_status() { # url expected [curl args...]
  local url=$1 want=$2
  shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@" "$url")
  [ "$got" = "$want" ] || fail "$url answered $got, expected $want"
  pass "$url → $got"
}
cleanup() {
  if [ "${E2E_KEEP:-}" = 1 ]; then echo "Left running: docker compose -p $PROJECT ... down -v"; return; fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -r -f "$WORK"
}
trap cleanup EXIT

step "A test repository"
mkdir -p "$WORK/src" "$WORK/git/acme"
cat >"$WORK/src/app.js" <<'JS'
const express = require("express")
const app = express()
app.post("/login", async (req, res) => {
  const rows = await db.query("SELECT * FROM users WHERE email = '" + req.body.email + "'")
  res.json(rows)
})
module.exports = app
JS
git -C "$WORK/src" init -q -b main
git -C "$WORK/src" add .
git -C "$WORK/src" -c user.name=e2e -c user.email=e2e@example.com commit -qm init
git clone -q --bare "$WORK/src" "$WORK/git/acme/app.git"
chmod -R a+rX "$WORK/git"
HEAD_SHA=$(git -C "$WORK/src" rev-parse HEAD)
# The fakes also serve GitHub, which needs a key; nothing here uses it.
openssl genrsa -out "$WORK/app.pem" 2048 2>/dev/null
chmod 644 "$WORK/app.pem"
pass "repo at $HEAD_SHA"

WEBHOOK_SECRET=$(openssl rand -hex 32)
CRON=$(openssl rand -hex 32)
cat >"$WORK/.env" <<ENV
SANDCHEST_IMAGE=$IMAGE
SANDCHEST_PORT=$PORT
POSTGRES_PASSWORD=$(openssl rand -hex 32)
SANDCHEST_APP_URL=$BASE
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
LLM_BASE_URL=http://fakes:4010/v1
LLM_API_KEY=e2e
LLM_MODEL=e2e-model
FORGEJO_URL=http://fakes:4010/forgejo
FORGEJO_TOKEN=forgejo-bot-token
FORGEJO_WEBHOOK_SECRET=$WEBHOOK_SECRET
FORGEJO_OWNERS=acme
FORGEJO_CLIENT_ID=forgejo-e2e-client
FORGEJO_CLIENT_SECRET=forgejo-e2e-client-secret
E2E_DIR=$WORK
E2E_HEAD_SHA=$HEAD_SHA
E2E_CRON_SECRET=$CRON
ENV

step "Start with Forgejo only: no GitHub App, no setup mode"
started=$(date +%s)
compose up -d --wait --wait-timeout 180 >/dev/null || fail "stack did not become healthy"
pass "healthy in $(($(date +%s) - started)) s"
expect_status "$BASE/setup" 404
compose logs --no-color web | contains "not connected to GitHub" && fail "printed a setup link"
# React separates text nodes with empty comments.
page=$(curl -s "$BASE/sign-in" | sed "s/<!-- -->//g")
grep -q "Continue with Forgejo" <<<"$page" || fail "sign-in offers no Forgejo button"
grep -q "Use your Forgejo account" <<<"$page" || fail "sign-in still asks for a GitHub account"
grep -q "connected to GitHub yet" <<<"$page" && fail "sign-in thinks setup is still needed"
pass "sign-in offers Forgejo, and setup is closed"

step "The sync records the bot's repositories, adds the webhook and starts recon"
response=$(curl -s "$BASE/api/cron/sweep" -H "authorization: Bearer $CRON")
grep -q '"errors":0' <<<"$response" || fail "sweep: $response"
pass "sweep: $response"
[ "$(sql "select provider || ' ' || github_login || ' ' || installation_id from orgs")" = "forgejo acme 300" ] || fail "org: $(sql "select * from orgs")"
[ "$(sql "select provider || ' ' || full_name from repos")" = "forgejo acme/app" ] || fail "repo: $(sql "select * from repos")"
pass "org and repo recorded as Forgejo's"
posted=$(compose exec -T fakes wget -q -O - http://127.0.0.1:4010/posted)
node -e '
  const { forgejo } = JSON.parse(process.argv[1]);
  const [hook] = forgejo.hooks;
  if (forgejo.hooks.length !== 1 || hook.url !== process.argv[2] + "/api/forgejo/webhooks" || !hook.signed) { console.error(JSON.stringify(forgejo.hooks)); process.exit(1); }
  console.log(`webhook on acme: ${hook.type} → ${hook.url} (${hook.events.join(", ")})`);
' "$posted" "$BASE" >"$WORK/hook.txt" || fail "webhook: $(cat "$WORK/hook.txt")"
pass "$(cat "$WORK/hook.txt")"

wait_for_scan() { # kind [seconds]
  local status="" limit=${2:-180}
  for _ in $(seq 1 $((limit / 2))); do
    status=$(sql "select status from scans where kind = '$1' order by created_at desc limit 1")
    case "$status" in completed) return 0 ;; failed | refused | cancelled) fail "$1 scan $status: $(sql "select error from scans where kind = '$1' order by created_at desc limit 1")" ;; esac
    sleep 2
  done
  fail "$1 scan still $status after $limit s"
}
started=$(date +%s)
wait_for_scan recon
pass "recon completed in $(($(date +%s) - started)) s; threat model: $(sql "select threat_model->>'summary' from repo_memory limit 1")"
curl -s "$BASE/api/cron/sweep" -H "authorization: Bearer $CRON" >/dev/null
[ "$(compose exec -T fakes wget -q -O - http://127.0.0.1:4010/posted | node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).forgejo.hooks.length)')" = 1 ] || fail "a second sync added another webhook"
[ "$(sql "select count(*) from scans where kind = 'recon'")" = 1 ] || fail "a second sync started another recon"
pass "a second sync adds no webhook and no recon"

step "Webhooks need Forgejo's signature; the GitHub route takes nothing without an App"
signed() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -r | cut -d' ' -f1; }
ping='{"action":"created"}'
expect_status "$BASE/api/forgejo/webhooks" 401 -X POST -H 'x-forgejo-event: push' -H 'x-forgejo-delivery: d-0' -H "x-forgejo-signature: $(printf '%064d' 0)" -d "$ping"
expect_status "$BASE/api/github/webhooks" 401 -X POST -H 'x-github-event: push' -H 'x-github-delivery: d-0' -H 'x-hub-signature-256: sha256=00' -d "$ping"

step "Pull request opened → pending status, review, failing status and a summary comment"
pr=$(cat <<JSON
{"action":"opened","number":5,"repository":{"id":2001,"full_name":"acme/app","private":true,"default_branch":"main","owner":{"id":300,"login":"acme"}},"sender":{"id":7,"login":"dev"},"pull_request":{"number":5,"title":"Change the login query","draft":false,"user":{"id":7,"login":"dev"},"head":{"sha":"$HEAD_SHA","ref":"feature","repo_id":2001,"repo":{"id":2001,"full_name":"acme/app"}},"base":{"sha":"$HEAD_SHA","ref":"main","repo_id":2001}}}
JSON
)
response=$(curl -s -X POST "$BASE/api/forgejo/webhooks" -H 'content-type: application/json' -H 'x-forgejo-event: pull_request' -H 'x-gitea-event: pull_request' -H "x-forgejo-delivery: e2e-pr-$(date +%s)" -H "x-forgejo-signature: $(signed "$pr")" -d "$pr")
grep -q '"status":"handled"' <<<"$response" || fail "pull_request webhook: $response"
started=$(date +%s)
wait_for_scan pr_review
pass "review completed in $(($(date +%s) - started)) s"
posted=$(compose exec -T fakes wget -q -O - http://127.0.0.1:4010/posted)
node -e '
  const { forgejo } = JSON.parse(process.argv[1]);
  const fail = (message) => { console.error(message, JSON.stringify(forgejo)); process.exit(1); };
  const [first, last] = [forgejo.statuses[0], forgejo.statuses.at(-1)];
  if (forgejo.statuses.length !== 2) fail("expected two statuses: pending, then the result");
  if (first.sha !== process.argv[2] || first.state !== "pending" || first.context !== "Sandchest" || first.description !== "Scanning…") fail("the status did not start pending on the head commit");
  if (last.sha !== process.argv[2] || last.state !== "failure" || last.context !== "Sandchest") fail("the status did not fail on a high finding");
  if (!last.targetUrl?.startsWith(process.argv[3] + "/dashboard/scans/")) fail("the status does not link to the scan");
  if (forgejo.reviews.length !== 1 || forgejo.reviews[0].commitId !== process.argv[2] || forgejo.reviews[0].event !== "COMMENT") fail("expected one review on the head commit");
  const [comment] = forgejo.reviews[0].comments;
  if (forgejo.reviews[0].comments.length !== 1 || comment.path !== "app.js" || comment.line !== 4) fail("expected one inline comment on app.js line 4");
  if (forgejo.comments.length !== 1 || !forgejo.comments[0].title.startsWith("**Sandchest: Found 1 issue")) fail("expected one summary comment");
  console.log(`status: pending → ${last.state} ("${last.description}"); review: 1 inline comment at ${comment.path}:${comment.line}; comment: ${forgejo.comments[0].title}`);
' "$posted" "$HEAD_SHA" "$BASE" >"$WORK/pr.txt" || fail "pull request outcome: $(cat "$WORK/pr.txt")"
pass "$(cat "$WORK/pr.txt")"
runs=$(sql "select status || '=' || count(*) from workflow.workflow_runs group by status order by 1" | tr '\n' ' ')
grep -q "completed=2" <<<"$runs" || fail "workflow runs: $runs"
pass "workflow runs on the Postgres World: $runs"

step "Sign in with Forgejo, through to the dashboard"
JAR="$WORK/cookies"
start=$(curl -s -c "$JAR" -X POST "$BASE/api/auth/sign-in/social" -H 'content-type: application/json' -H "origin: $BASE" -d '{"provider":"forgejo","callbackURL":"/dashboard/repos"}')
authorize=$(node -e 'console.log(JSON.parse(process.argv[1]).url ?? "")' "$start")
case "$authorize" in http://fakes:4010/forgejo/login/oauth/authorize\?*) ;; *) fail "sign-in did not send to Forgejo: $start" ;; esac
grep -q "client_id=forgejo-e2e-client" <<<"$authorize" || fail "no client id: $authorize"
grep -q "redirect_uri=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$BASE/api/auth/callback/forgejo")" <<<"$authorize" || fail "unexpected redirect URI: $authorize"
STATE=$(node -e 'console.log(new URL(process.argv[1]).searchParams.get("state"))' "$authorize")
pass "sent to Forgejo's authorize page with the callback $BASE/api/auth/callback/forgejo"
location=$(curl -s -b "$JAR" -c "$JAR" -o /dev/null -w '%{redirect_url}' "$BASE/api/auth/callback/forgejo?code=forgejo-code&state=$STATE")
[ "$location" = "$BASE/dashboard/repos" ] || fail "the callback went to $location"
[ "$(sql "select provider_id || ' ' || account_id from accounts")" = "forgejo 501" ] || fail "account: $(sql "select provider_id, account_id from accounts")"
pass "callback → $location; account forgejo 501"
repos=$(curl -s -b "$JAR" "$BASE/dashboard/repos")
grep -q "acme/app" <<<"$repos" || fail "the dashboard does not list acme/app"
[ "$(sql "select login || ' ' || coalesce(github_user_id::text, '-') from users")" = "alice -" ] || fail "user: $(sql "select login, github_user_id from users")"
[ "$(sql "select permission from permission_cache")" = "admin" ] || fail "no access cached"
[ "$(sql "select count(*) from org_admins")" = 1 ] || fail "alice is not the org's admin"
pass "the dashboard lists acme/app; alice administers acme and has no GitHub identity"

step "No secret reached the log"
logs=$(compose logs --no-color web)
for secret in "$WEBHOOK_SECRET" forgejo-bot-token forgejo-user-token forgejo-e2e-client-secret forgejo-refresh; do
  grep -q -- "$secret" <<<"$logs" && fail "a secret reached the log"
done
pass "none of the bot's token, the webhook secret, the OAuth2 secret or the person's tokens"

step "All checks passed"
