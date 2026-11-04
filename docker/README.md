# Self-hosting Sandchest

A self-hosted Sandchest sends nothing to us. There's no telemetry and no billing, and plans and credits are switched off. The safety limits stay. Each repository gets one deep scan a day, each account runs at most two scans at a time, and repositories over a million lines aren't scanned.

You get two containers: `web`, which serves the dashboard and webhooks and runs scans, and `postgres`. You also get a GitHub App of your own, created in one click by the server's setup page.

## What you need

- **Docker** with the Compose plugin (`docker compose version` 2.20 or newer).
- **A machine with 2 or more CPUs and 4 GB of memory.** Each scan clones one repository into a temporary directory and indexes it, so leave disk space for your largest repository.
- **A public HTTPS address** that GitHub can send webhooks to: a domain with a reverse proxy, or a tunnel for a trial (see [Giving GitHub a way in](#giving-github-a-way-in)).
- **A model endpoint** that speaks the standard chat-completions protocol (`POST /chat/completions`), with streaming, tool calls and strict JSON-schema output. Sandchest is tuned for a fast model that reasons on request and caches long prompts.
- **A GitHub account**, or owner rights on the organisation that will own the App.

## Start it

```sh
git clone https://github.com/CapSoftware/Sandchest.git
cd Sandchest/docker
cp .env.example .env
```

Fill in the required values in `docker/.env`:

| Setting | What to put |
|---|---|
| `SANDCHEST_APP_URL` | The public HTTPS address, such as `https://sandchest.example.com`. No trailing slash. |
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 32`. Use letters and digits only, and set it before the first start: the database keeps the password it was created with. |
| `LLM_BASE_URL` | The endpoint's base URL, including the version segment, such as `https://models.example.com/v1`. |
| `LLM_API_KEY` | The endpoint's key. Use any value if it needs none. |
| `LLM_MODEL` | The model name the endpoint expects. One model does every job. |

Then build and start it:

```sh
docker compose up -d --build
```

The first build takes a few minutes. Each start migrates the database first, so give it a few seconds. If a required value is missing, Compose refuses to start and names it.

## Connect GitHub

The server starts in setup mode and prints a one-time link:

```sh
docker compose logs web | grep setup
```

```
Sandchest is not connected to GitHub yet. To create its GitHub App, open https://sandchest.example.com/setup/unlock?token=…
```

1. **Open the link** on your public address, or on the same machine at `http://localhost:3000/setup/unlock?token=…`. Without the token, `/setup` asks for it and shows nothing else.
2. **Choose who owns the App:** your account, or an organisation you own. Keep "Who can install it" on "Only the owner".
3. **Click Create on GitHub**, check the name, and confirm on GitHub. App names are unique across GitHub, so change it there if it is taken.
4. **GitHub sends you back to a page with the App's keys.** They are shown this once and stored nowhere. Copy them into `docker/.env`, replacing the empty `GITHUB_…` lines.
5. **Restart with the keys:**

   ```sh
   docker compose up -d
   ```

   The setup page disappears once the App is configured.
6. **Install the App** on the repositories to review, using the link on the keys page (`https://github.com/apps/<your-app>/installations/new`).
7. **Sign in** at your address with GitHub. Sandchest builds a threat model of each repository first, in a minute or two. From then on, every pull request gets a Sandchest check, and private repositories get inline review comments.

The App asks GitHub for these permissions: read code, metadata, issues, organisation members and email addresses; write pull requests and checks. It subscribes to pull request, push and issue comment events. GitHub sends installation events to every App without asking.

## Giving GitHub a way in

The `web` container listens on `127.0.0.1:3000` only, so nothing is exposed until you choose how.

**For a trial, use a tunnel.** For example, a quick tunnel with `cloudflared`:

```sh
cloudflared tunnel --url http://localhost:3000
```

Put the `https://….trycloudflare.com` address it prints into `SANDCHEST_APP_URL` before you run setup, then run `docker compose up -d` so the server picks it up. A quick tunnel's address changes every time it starts, so for anything you keep, use a named tunnel or a domain.

**To keep it, use a domain and a reverse proxy with TLS** on the same machine. With Caddy, for example:

```
sandchest.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

The proxy must pass the original `Host` header. Caddy does; with nginx, add `proxy_set_header Host $host;`. The setup page shows the address GitHub will send you back to, so check it before you continue.

Don't put a shared cache in front of Sandchest that keys on the URL alone. The landing page at `/` differs for signed-in people (it shows a Dashboard button), and Sandchest sends no `Vary: Cookie`. A plain proxy like the ones above is fine.

To listen on every interface instead, set `SANDCHEST_BIND=0.0.0.0` in `.env`. Set `SANDCHEST_PORT` to use another port.

If the address changes later, update `SANDCHEST_APP_URL`, restart, and in the App's settings on GitHub change the homepage, webhook URL (`<address>/api/github/webhooks`), callback URL (`<address>/api/auth/callback/github`) and setup URL (`<address>/dashboard`).

## Forgejo / Gitea

Sandchest can review repositories on a Forgejo or Gitea instance instead of, or beside, GitHub. Forgejo has no Apps, so Sandchest works as a bot account you create there, and you list which owners and repositories it covers. Nothing changes for GitHub: with no `FORGEJO_…` settings, Sandchest runs exactly as above. With `FORGEJO_URL` set, the `GITHUB_…` lines may stay empty, and the server skips setup mode. To add a GitHub App as well, either create it from the setup page before you set `FORGEJO_URL`, or remove `FORGEJO_URL` while you run setup.

It is tested against Forgejo 17 (Gitea API 1.22). It uses the API that Gitea and Forgejo share, so recent Gitea works the same way.

### 1. A bot account and its token

1. **Create a user for Sandchest**, such as `sandchest-bot`. Its name is what people see on statuses, reviews and comments.
2. **Give it access to the repositories** to review. Statuses, reviews and comments need write access. Checking who may run `/sandchest review` needs admin access. So add the bot to a team with admin access to those repositories, or as an admin collaborator. To let Sandchest add an organisation's webhook itself, add the bot to the organisation's Owners team instead.
3. **Create a token for the bot**: sign in as the bot, open Settings, Applications, and generate a token with these scopes:

   | Scope | Why |
   |---|---|
   | `repository`: read and write | Reading code, diffs and branches. Posting commit statuses and reviews. Repository webhooks. |
   | `issue`: read and write | The summary comment on a pull request. |
   | `organization`: read | Listing an organisation's repositories. Use read and write to let Sandchest add the organisation webhook itself. |
   | `user`: read | Listing a user's repositories. |

Scans clone over HTTPS with this token. Forgejo can't mint a short-lived token for one repository, as a GitHub App does, so keep the bot's reach to the repositories you want reviewed. The token travels as an HTTP header in the clone's environment, never in a URL, on a command line or in the log.

### 2. Settings

Add these to `docker/.env`:

| Setting | What to put |
|---|---|
| `FORGEJO_URL` | The instance's address, such as `https://git.example.com`. No trailing slash. |
| `FORGEJO_TOKEN` | The bot's token. |
| `FORGEJO_WEBHOOK_SECRET` | `openssl rand -hex 32` |
| `FORGEJO_OWNERS` | What Sandchest covers, comma-separated. Write `acme` for every repository of a user or organisation, and `acme/app` for one repository. |
| `FORGEJO_WEBHOOKS` | Optional. `auto` (the default) adds the webhooks itself; `manual` leaves them to you. |
| `FORGEJO_CLIENT_ID`, `FORGEJO_CLIENT_SECRET` | Optional, for signing in with Forgejo (step 4). |

Then restart with `docker compose up -d`. Archived repositories, mirrors and empty repositories are skipped. Every ten minutes Sandchest reads the covered repositories again: new ones are recorded and get their threat model, and removed ones are disabled, as on GitHub. A repository that sends a webhook first is recorded right away. Take an owner off `FORGEJO_OWNERS` and Sandchest forgets it, as if the App had been uninstalled.

### 3. Webhooks

With `FORGEJO_WEBHOOKS=auto`, Sandchest adds one webhook to each covered organisation, or to each repository for users and single repositories, the first time it reads them. It needs the bot to own the organisation, or administer the repository. If it may not, the log says so, and you add the webhook by hand:

- **Target URL:** `<SANDCHEST_APP_URL>/api/forgejo/webhooks`
- **Type:** Forgejo or Gitea
- **Content type:** `application/json`
- **Secret:** the value of `FORGEJO_WEBHOOK_SECRET`
- **Events:** "Custom events", with Push, Pull request (all of its events), Issue comment and Repository.

Forgejo signs every delivery with the secret (`X-Forgejo-Signature`, or `X-Gitea-Signature` on Gitea), and Sandchest refuses a delivery whose signature doesn't match.

Forgejo blocks webhooks to private addresses by default. If Sandchest runs on your network, allow its host in Forgejo's `app.ini`: `[webhook] ALLOWED_HOST_LIST = sandchest.example.com`.

### 4. Signing in with Forgejo

1. **Create an OAuth2 application** on the instance: in Settings, Applications, OAuth2 applications (your own, an organisation's, or the site administration's). Set the redirect URI to `<SANDCHEST_APP_URL>/api/auth/callback/forgejo`, and keep it a confidential client.
2. **Put its client ID and secret** in `FORGEJO_CLIENT_ID` and `FORGEJO_CLIENT_SECRET`, and restart.

The sign-in page then shows "Continue with Forgejo", beside "Continue with GitHub" when the App is configured too. People see findings for the covered repositories they can push to, and change an owner's settings if they own or administer its organisation, or if it is their own account. Sandchest asks for the `read:user`, `read:repository` and `read:organization` scopes. Forgejo honours them only when the instance allows OAuth2 scopes (`[oauth2] ENABLE_ADDITIONAL_GRANT_SCOPES = true`); otherwise the token may do anything the person may, and Sandchest only reads with it.

### What pull requests get

The same as on GitHub, with Forgejo's own tools:

- **A commit status named "Sandchest"** stands in for the Check: pending while the review runs, then success or failure, with a link to the scan. A failure means findings at or above the account's threshold, as on GitHub. When a review isn't run or can't finish, the status is a success, so it never blocks a merge.
- **A summary comment** when the status isn't a plain success. A commit status holds one line, so the comment carries what a Check's summary would.
- **One review with inline comments** on private repositories. Public repositories only get counts and a link, as on GitHub, because everything on the pull request is public.
- **The same rules**: drafts (a `WIP:` title) wait, pull requests from forks of public repositories wait for a maintainer's `/sandchest review`, and on private repositories a fork's author needs write access. Pushes to the default branch build the threat model and re-check open findings.

Sandchest creates no issues and no security advisories, on GitHub or on Forgejo. Findings stay in the dashboard, where only people with push access see them. Forgejo has no security advisories, so if that ever changes, a Forgejo equivalent would need a private repository or a confidential issue.

## Optional settings

| Setting | Effect |
|---|---|
| `SMTP_URL`, `EMAIL_FROM` | Email about critical findings and finished deep scans, for example `smtps://user:password@smtp.example.com:465`. |
| `SENTRY_DSN` | Error reports go to your own Sentry project. |
| `SANDCHEST_ADMIN_TOKEN` | Enables `POST /api/scans` with `Authorization: Bearer <token>` and `{"repo": "owner/name"}`, which starts a deep scan. People can also start one with the Deep scan button in the dashboard. 24 or more characters: `openssl rand -hex 24`. |
| `LLM_PRICE_INPUT`, `LLM_PRICE_CACHED_INPUT`, `LLM_PRICE_OUTPUT` | The model's prices in USD per million tokens, so each scan records what it cost. |
| `SANDCHEST_SETUP_TOKEN` | Your own setup token (24 or more characters), instead of the one derived from `BETTER_AUTH_SECRET`. |
| `SANDCHEST_IMAGE` | Run a prebuilt image instead of building from this checkout. |

## How it runs

- The `web` image holds the Next.js server, its workflows and the `sandchest-index` indexer for its architecture (amd64 or arm64). It runs as a non-root user, with no Linux capabilities, a read-only root file system and a limit on processes. It writes only scan workspaces and Next's cache.
- The server checks its settings when it starts. If one is wrong, it exits and prints which, and Compose restarts it until you fix it. The health check (`/api/health`) also fails while the database is unreachable.
- Scans run as durable workflows stored in Postgres, inside the `web` container. A scan survives one restart: it runs again from the start when the server comes back, and fails if it is interrupted a second time. Every ten minutes the server also finishes or fails scans that got stuck.
- Each scan clones its repository with a short-lived, read-only token into a temporary directory, which is deleted when the scan ends.
- The workflow engine's internal route (`/.well-known/workflow/…`) has no authentication of its own. The server only answers it on loopback inside the container; from outside it is a 404, however the path is written.
- Postgres is not published on any port. The app connects as a role that owns its database but is not a superuser.
- The base images are pinned by digest, so rebuilding the same commit uses the same images. The two Alpine packages the image adds are not pinned: Alpine keeps only the latest build of each package, so a pinned version would stop installing at its next security fix.
- Sandchest sends nothing to us. Next.js telemetry is off, and billing stays off because no billing key is set. Your code goes only to GitHub and to your model endpoint.

## Upgrading

```sh
cd Sandchest
git pull
cd docker
docker compose up -d --build
```

The server migrates the database before it starts, so there is nothing else to run. Back up first.

## Backups

Everything Sandchest keeps is in the database: findings, threat models, scan history and the dashboard's sessions. Code is never stored. Keep `docker/.env` safe too, since it holds the App's private key.

```sh
# Back up
docker compose exec -T postgres pg_dump -U postgres -Fc sandchest > sandchest.dump

# Restore into a fresh install, before connecting the App to it
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U postgres -d sandchest --clean --if-exists --no-owner --role=sandchest < sandchest.dump
docker compose up -d
```

## Troubleshooting

**Forgejo pull requests get no status.** In the webhook's settings on Forgejo, Recent deliveries shows each delivery and its response. A 401 means `FORGEJO_WEBHOOK_SECRET` does not match the webhook's secret. A 404 means `FORGEJO_URL` is not set. "Repo not enabled" means the repository isn't in `FORGEJO_OWNERS`, or the bot can't read it. If no delivery is listed, check Forgejo's `[webhook] ALLOWED_HOST_LIST`.

**Compose says a required variable is missing.** Fill it in `docker/.env`; the message names the setting.

**The `web` container keeps restarting.** A setting is invalid, for example a `SANDCHEST_ADMIN_TOKEN` under 24 characters. `docker compose logs web` names it after "Sandchest cannot start".

**There's no setup link in the log.** The log says what is missing instead: `SANDCHEST_APP_URL`, or `BETTER_AUTH_SECRET` (32 or more characters). After a restart, run `docker compose logs web | grep setup` again. If the App is already configured, there is no setup link.

**The setup page says "Wrong address."** Open setup on `SANDCHEST_APP_URL` or on `localhost`. GitHub sends you back to the address you started from, and the setup cookie has to come back with you.

**GitHub sent me back to "Start again."** The link was opened in another browser, or more than an hour passed. GitHub has already created the App: delete it (GitHub, Settings, Developer settings, GitHub Apps), then run setup again.

**I lost the keys.** Open the App's settings on GitHub. Generate a new private key and client secret, set a new webhook secret, and put all three in `.env`.

**Pull requests get no check.** In the App's settings on GitHub, open Advanced to see recent deliveries and their responses. Deliveries must reach `SANDCHEST_APP_URL` over HTTPS. If the address changed (quick tunnels change on every start), update the App as described above. A 401 response means `GITHUB_WEBHOOK_SECRET` does not match the App's webhook secret.

**Sign-in fails.** The App's callback URL must be `<SANDCHEST_APP_URL>/api/auth/callback/github`, and `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` must both be set.

**Scans fail.** `docker compose logs web` says why. Check that the container can reach the model: `docker compose exec web wget -qO- "$LLM_BASE_URL/models"` (with the URL written out), and that the model supports tool calls and strict JSON-schema output.

**The database password was changed after the first start.** The database still uses the old one. Put the old value back, or change it in Postgres: `docker compose exec postgres psql -U postgres -c "alter role sandchest password '<new>'"`.

**Something else.** `docker compose ps` shows each container's health, and `docker compose logs -f web` follows the server.

## Testing the stack

`docker/test/e2e.sh` touches nothing outside its own Compose project and a temporary directory, and removes both when it ends. It starts the stack from an empty volume with GitHub and the model faked, then:

- runs setup through the manifest flow;
- restarts with the keys;
- sends a signed install webhook;
- runs recon and a deep scan as workflows, through to a stored finding, restarting the server mid-scan;
- opens a pull request and checks for the in-progress Check, the inline review and the failing Check;
- checks that a bad setting stops the server with a clear message;
- checks that the workflow route is closed from outside.

```sh
docker build -f docker/Dockerfile -t sandchest:local .
docker/test/e2e.sh
```

`docker/test/e2e-forgejo.sh` does the same for Forgejo, with Forgejo and the model faked and no GitHub App at all. It runs the sync, which records the bot's repositories, adds the webhook and builds the threat model. Then it sends a signed pull request webhook and checks the pending and failing statuses, the inline review and the summary comment. Last, it signs in with Forgejo through OAuth2 and checks that the dashboard lists the repository.

## Creating the App for a hosted service

The same setup page creates an App that other accounts can install. Run Sandchest on your own machine, with `SANDCHEST_APP_URL` set to the service's public address and no `GITHUB_APP_ID`. Open setup on `http://localhost:<port>`, so GitHub returns the keys to your machine. Choose "Any account" under "Who can install it". Then put the keys in the service's environment.
