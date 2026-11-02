#!/usr/bin/env bash
# End to end on the real image: docker compose up from a fresh volume, first-run setup through the
# GitHub App manifest flow, then an install webhook and a deep scan run as workflows on the Postgres
# World. GitHub and the model are fakes (docker/test/fakes.mjs); everything else is real.
#
#   docker build -f docker/Dockerfile -t sandchest:local .
#   docker/test/e2e.sh
#
# Env: SANDCHEST_IMAGE (default sandchest:local), E2E_PORT (3000), E2E_PROJECT (sandchest-e2e),
# E2E_KEEP=1 to leave the stack running. Containers and volumes are removed at the end.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DOCKER_DIR=$(dirname "$HERE")
PORT=${E2E_PORT:-3000}
PROJECT=${E2E_PROJECT:-sandchest-e2e}
IMAGE=${SANDCHEST_IMAGE:-sandchest:local}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sandchest-e2e.XXXXXX")
BASE="http://localhost:$PORT"

compose() { docker compose -p "$PROJECT" --env-file "$WORK/.env" -f "$DOCKER_DIR/compose.yml" -f "$HERE/compose.test.yml" "$@"; }
sql() { compose exec -T postgres psql -U postgres -d sandchest -tAc "$1"; }
# Reads all of its input before matching, so the writer never dies of a closed pipe under pipefail.
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

step "A test repository and an App key"
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
# Readable by the container's user, whoever owns it on this machine.
chmod -R a+rX "$WORK/git"
HEAD_SHA=$(git -C "$WORK/src" rev-parse HEAD)
openssl genrsa -out "$WORK/app.pem" 2048 2>/dev/null
chmod 644 "$WORK/app.pem"
pass "repo at $HEAD_SHA"

ADMIN_TOKEN=$(openssl rand -hex 24)
cat >"$WORK/.env" <<ENV
SANDCHEST_IMAGE=$IMAGE
SANDCHEST_PORT=$PORT
POSTGRES_PASSWORD=$(openssl rand -hex 32)
SANDCHEST_APP_URL=$BASE
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
LLM_BASE_URL=http://fakes:4010/v1
LLM_API_KEY=e2e
LLM_MODEL=e2e-model
SANDCHEST_ADMIN_TOKEN=$ADMIN_TOKEN
E2E_DIR=$WORK
E2E_HEAD_SHA=$HEAD_SHA
ENV

step "Compose refuses to start without a required value"
grep -v '^LLM_MODEL=' "$WORK/.env" >"$WORK/.env.incomplete"
if out=$(docker compose -p "$PROJECT" --env-file "$WORK/.env.incomplete" -f "$DOCKER_DIR/compose.yml" -f "$HERE/compose.test.yml" config 2>&1); then
  fail "compose accepted a config without LLM_MODEL"
fi
grep -q "Set LLM_MODEL" <<<"$out" || fail "unclear error: $out"
pass "$(grep -o 'Set LLM_MODEL[^"]*' <<<"$out" | head -1)"

step "First start: migrations, then the server in setup mode"
started=$(date +%s)
compose up -d --wait --wait-timeout 180 >/dev/null || fail "stack did not become healthy"
pass "healthy in $(($(date +%s) - started)) s"
compose logs --no-color web | contains "Database is up to date" || fail "migrations did not run"
pass "migrations ran: $(compose logs --no-color web | grep -o 'Database is up to date[^.]*')"
[ "$(sql "select count(*) from drizzle.__drizzle_migrations")" -ge 3 ] || fail "app migrations missing"
[ "$(sql "select count(*) from workflow_drizzle.workflow_migrations")" -ge 20 ] || fail "World migrations missing"
[ "$(sql "select count(*) from pg_namespace where nspname = 'graphile_worker'")" = 1 ] || fail "queue schema missing"
[ "$(sql "select rolsuper from pg_roles where rolname = 'sandchest'")" = f ] || fail "the app's role is a superuser"
pass "app, World and queue schemas present; the app's role is not a superuser"

expect_status "$BASE/" 200
expect_status "$BASE/sign-in" 200
curl -s "$BASE/sign-in" | contains "connected to GitHub yet" || fail "sign-in does not explain setup mode"
pass "sign-in explains that setup comes first"

step "The health check follows the database, before setup too"
expect_status "$BASE/api/health" 200
compose stop postgres >/dev/null 2>&1
sleep 3
expect_status "$BASE/api/health" 503
compose start postgres >/dev/null 2>&1
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")" = 200 ] && break
  sleep 1
done
expect_status "$BASE/api/health" 200

step "Setup is shut without the token"
curl -s "$BASE/setup" | contains "Connect GitHub" || fail "/setup did not ask for the token"
curl -s "$BASE/setup" | contains 'name="manifest"' && fail "/setup showed the form without the token"
pass "/setup asks for the token and shows no form"
expect_status "$BASE/setup/unlock?token=wrong" 303
curl -s -D - -o /dev/null "$BASE/setup/unlock?token=wrong" | contains -i '^set-cookie' && fail "a wrong token got a cookie"
curl -s "$BASE/setup/callback?code=e2e-code&state=1.2.3" | contains "Start again" || fail "callback without a session did not refuse"
pass "wrong token: no cookie; callback without a session: refused before any exchange"

step "The workflow routes are unreachable from outside"
for path in /.well-known/workflow/v1/flow "/.well-known/workflow/v1/flow?__health" /x/../.well-known/workflow/v1/flow /%2Ewell-known/workflow/v1/flow //.well-known/workflow/v1/flow /.well-known/workflow/v1/webhook/x; do
  for method in GET POST; do
    expect_status "$BASE$path" 404 --path-as-is -X "$method" -d '{}'
  done
done
inside=$(compose exec -T web wget -q -O - "http://127.0.0.1:3001/.well-known/workflow/v1/flow?__health" 2>&1 || true)
[ -n "$inside" ] || fail "the flow route did not answer on loopback inside the container"
pass "inside the container, loopback reaches it: ${inside:0:60}"
# Next's image optimiser fetches its url parameter from inside the server: it must not be a way in.
for path in "/_next/image?url=%2F.well-known%2Fworkflow%2Fv1%2Fwebhook%2Fx&w=64&q=75" "/_next/image?url=%2Fsandchest-logo-dark.svg&w=64&q=75"; do
  expect_status "$BASE$path" 404
done
direct=$(compose exec -T web wget -q -S -O /dev/null "http://127.0.0.1:3001/_next/image?url=%2Fsandchest-logo-dark.svg&w=64&q=75" 2>&1 || true)
grep -q "HTTP/1.1 200" <<<"$direct" && fail "the image optimiser is on"
compose logs --no-color web | contains -i "resumeWebhook\|webhook/x" && fail "a workflow handler ran for the image route"
pass "the image optimiser is off in Next as well, and no workflow handler ran"

step "The web container is locked down"
compose exec -T web touch /app/probe 2>/dev/null && fail "the root file system is writable"
[ "$(compose exec -T web grep CapEff /proc/1/status | tr -d '[:space:]')" = "CapEff:0000000000000000" ] || fail "the server has capabilities"
compose exec -T web grep -q NoNewPrivs:.*1 /proc/1/status || fail "privilege escalation is not blocked"
pass "read-only root, no capabilities, no new privileges"

step "Setup with the token from the log"
TOKEN=$(compose logs --no-color web | grep -o 'setup/unlock?token=[A-Za-z0-9_-]*' | tail -1 | cut -d= -f2)
[ -n "$TOKEN" ] || fail "no setup link in the log"
JAR="$WORK/cookies"
location=$(curl -s -c "$JAR" -o /dev/null -w '%{redirect_url}' "$BASE/setup/unlock?token=$TOKEN")
[ "$location" = "$BASE/setup" ] || fail "unlock redirected to $location"
page=$(curl -s -b "$JAR" "$BASE/setup")
grep -q 'name="manifest"' <<<"$page" || fail "no manifest form after unlocking"
STATE=$(grep -o 'github.com/settings/apps/new?state=[^"]*' <<<"$page" | head -1 | cut -d= -f2)
[ -n "$STATE" ] || fail "no state in the form"
grep -q "$BASE/api/github/webhooks" <<<"$page" || fail "the manifest does not name the webhook URL"
pass "form posts to github.com with a signed state; manifest names $BASE/api/github/webhooks"

curl -s -b "$JAR" "$BASE/setup/callback?code=e2e-code&state=tampered$STATE" | contains "Start again" || fail "a tampered state was accepted"
pass "tampered state refused"
callback=$(curl -s -b "$JAR" -D "$WORK/callback.headers" "$BASE/setup/callback?code=e2e-code&state=$STATE")
grep -q "GITHUB_APP_ID=424242" <<<"$callback" || fail "the callback did not show the App's keys"
grep -qi '^cache-control:.*no-store' "$WORK/callback.headers" || fail "the keys page may be cached"
# The env block, as the operator would copy it.
node -e '
  const html = require("fs").readFileSync(0, "utf8");
  const pre = html.match(/<pre[^>]*aria-label="Environment variables"[^>]*>([\s\S]*?)<\/pre>/)[1];
  const text = pre.replace(/<!-- -->/g, "").replace(/&quot;/g, "\"").replace(/&#x27;/g, "\x27").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  process.stdout.write(text + "\n");
' <<<"$callback" >"$WORK/app.env"
grep -q '^GITHUB_APP_PRIVATE_KEY="-----BEGIN' "$WORK/app.env" || fail "env block has no private key line"
pass "keys shown once, not cacheable: $(cut -d= -f1 "$WORK/app.env" | tr '\n' ' ')"
curl -s -b "$JAR" "$BASE/setup/callback?code=e2e-code&state=$STATE" | contains "Already shown" || fail "the keys could be shown twice"
pass "reloading the page cannot show them again"
WEBHOOK_SECRET=$(grep '^GITHUB_WEBHOOK_SECRET=' "$WORK/app.env" | cut -d= -f2)
if compose logs --no-color web | contains -E "$WEBHOOK_SECRET|e2e0client0secret|PRIVATE KEY"; then fail "a secret reached the log"; fi
pass "no secret in the server log"

step "Restart with the App's keys"
cat "$WORK/app.env" >>"$WORK/.env"
compose up -d --wait --wait-timeout 180 >/dev/null || fail "did not come back healthy"
expect_status "$BASE/setup" 404
expect_status "$BASE/setup/unlock?token=$TOKEN" 404
compose logs --no-color web | tail -20 | contains "not connected to GitHub" && fail "still printing the setup link"
pass "setup is gone once the App is configured"

step "Install webhook → recon, run as a workflow"
payload='{"action":"created","installation":{"id":77,"account":{"id":900,"login":"acme","type":"Organization"}}}'
signature="sha256=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -r | cut -d' ' -f1)"
expect_status "$BASE/api/github/webhooks" 401 -X POST -H 'x-github-event: installation' -H 'x-github-delivery: d-0' -H 'x-hub-signature-256: sha256=00' -d "$payload"
response=$(curl -s -X POST "$BASE/api/github/webhooks" -H 'content-type: application/json' -H 'x-github-event: installation' -H "x-github-delivery: e2e-$(date +%s)" -H "x-hub-signature-256: $signature" -d "$payload")
grep -q '"status":"handled"' <<<"$response" || fail "install webhook: $response"
pass "signed with the secret from setup: $response"

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

model_delay() { compose exec -T fakes wget -q -O /dev/null --post-data '' "http://127.0.0.1:4010/control?delayMs=$1"; }

step "Deep scan from the operator route, with the server restarted mid-scan"
expect_status "$BASE/api/scans" 401 -X POST -d '{"repo":"acme/app"}'
model_delay 20000
response=$(curl -s -X POST "$BASE/api/scans" -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"repo":"acme/app"}')
grep -q scanId <<<"$response" || fail "deep scan: $response"
started=$(date +%s)
for _ in $(seq 1 30); do
  [ "$(sql "select status from scans where kind = 'deep'")" = running ] && break
  sleep 1
done
[ "$(sql "select status from scans where kind = 'deep'")" = running ] || fail "the deep scan never started"
sleep 3
compose restart web >/dev/null
model_delay 0
pass "restarted the server $(($(date +%s) - started)) s into the scan"
wait_for_scan deep 900
pass "deep scan completed $(($(date +%s) - started)) s after it started"
findings=$(sql "select severity || ' ' || title from findings")
grep -q "high SQL injection in login" <<<"$findings" || fail "expected the SQL injection finding, got: $findings"
pass "finding stored: $findings"
leftovers=$(compose exec -T web find /tmp -mindepth 1 -maxdepth 1 -name 'sandchest-*')
[ -z "$leftovers" ] || fail "scan workspaces left behind: $leftovers"
pass "no scan workspace left in /tmp"

step "Pull request opened → in-progress Check, review, failing Check"
pr=$(cat <<JSON
{"action":"opened","number":5,"installation":{"id":77},"repository":{"id":1001,"full_name":"acme/app","private":true,"default_branch":"main"},"sender":{"login":"dev"},"pull_request":{"number":5,"draft":false,"author_association":"MEMBER","head":{"sha":"$HEAD_SHA","ref":"feature","repo":{"id":1001,"full_name":"acme/app"}},"base":{"sha":"$HEAD_SHA","ref":"main","repo":{"id":1001}}}}
JSON
)
signature="sha256=$(printf '%s' "$pr" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -r | cut -d' ' -f1)"
response=$(curl -s -X POST "$BASE/api/github/webhooks" -H 'content-type: application/json' -H 'x-github-event: pull_request' -H "x-github-delivery: e2e-pr-$(date +%s)" -H "x-hub-signature-256: $signature" -d "$pr")
grep -q '"status":"handled"' <<<"$response" || fail "pull_request webhook: $response"
started=$(date +%s)
wait_for_scan pr_review
pass "review completed in $(($(date +%s) - started)) s"
posted=$(compose exec -T fakes wget -q -O - http://127.0.0.1:4010/posted)
node -e '
  const { checks, reviews } = JSON.parse(process.argv[1]);
  const fail = (message) => { console.error(message, JSON.stringify({ checks, reviews })); process.exit(1); };
  if (checks.length !== 1) fail("expected one Check run");
  const [check] = checks;
  if (check.headSha !== process.argv[2] || check.createdAs !== "in_progress" || check.firstTitle !== "Scanning…") fail("the Check did not start in progress on the head commit");
  if (check.status !== "completed" || check.conclusion !== "failure") fail("the Check did not fail on a high finding");
  if (!check.detailsUrl?.startsWith(process.argv[3] + "/dashboard/scans/")) fail("the Check does not link to the scan");
  if (reviews.length !== 1 || reviews[0].commitId !== process.argv[2]) fail("expected one review on the head commit");
  const [comment] = reviews[0].comments;
  if (reviews[0].comments.length !== 1 || comment.path !== "app.js" || comment.line !== 4) fail("expected one inline comment on app.js line 4");
  console.log(`Check: in_progress → ${check.conclusion} ("${check.title}"); review: ${reviews[0].comments.length} inline comment at ${comment.path}:${comment.line}`);
' "$posted" "$HEAD_SHA" "$BASE" >"$WORK/pr.txt" || fail "pull request outcome: $(cat "$WORK/pr.txt")"
pass "$(cat "$WORK/pr.txt")"
runs=$(sql "select status || '=' || count(*) from workflow.workflow_runs group by status order by 1" | tr '\n' ' ')
grep -q "completed=3" <<<"$runs" || fail "workflow runs: $runs"
pass "workflow runs on the Postgres World: $runs"
stats=$(compose exec -T fakes wget -q -O - http://127.0.0.1:4010/stats)
grep -q '"tokensRefused":0' <<<"$stats" || fail "an installation token was refused: $stats"
pass "fakes: $stats"

step "A bad setting stops the server instead of failing every request"
if out=$(compose run --rm --no-deps -T -e SANDCHEST_ADMIN_TOKEN=too-short web 2>&1); then fail "the server started with a 9-character admin token"; fi
grep -q "Sandchest cannot start" <<<"$out" && grep -q "SANDCHEST_ADMIN_TOKEN: Too small" <<<"$out" || fail "unclear exit: $out"
grep -q "too-short" <<<"$out" && fail "the bad value reached the log"
pass "exited non-zero: $(grep -A1 'Sandchest cannot start' <<<"$out" | tr -s ' \n' ' ')"

step "All checks passed"
