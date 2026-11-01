# Sandchest

Sandchest reads your code the way an attacker would. It is a GitHub App that builds a threat model of each repository, reviews every pull request for exploitable vulnerabilities, and hands you fix prompts for your coding agent.

You can use the hosted service at [sandchest.com](https://www.sandchest.com), or run it yourself with the instructions below. A self-hosted Sandchest sends nothing to us: no telemetry, no billing, no limits.

## Self-hosting

You get two containers: `web`, which serves the dashboard and webhooks and runs scans, and `postgres`. You also get a GitHub App of your own, created in one click by the server's setup page.

### What you need

- **Docker** with the Compose plugin (`docker compose version` 2.20 or newer).
- **A machine with 2 or more CPUs and 4 GB of memory.** Each scan clones one repository into a temporary directory and indexes it, so leave disk space for your largest repository.
- **A public HTTPS address** that GitHub can send webhooks to: a domain with a reverse proxy, or a tunnel for a trial (see [Giving GitHub a way in](#giving-github-a-way-in)).
- **A model endpoint** that speaks the standard chat-completions protocol (`POST /chat/completions`), with streaming, tool calls and strict JSON-schema output. Sandchest is tuned for a fast model that reasons on request and caches long prompts.
- **A GitHub account**, or owner rights on the organisation that will own the App.

### Start it

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

### Connect GitHub

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

### Giving GitHub a way in

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

To listen on every interface instead, set `SANDCHEST_BIND=0.0.0.0` in `.env`. Set `SANDCHEST_PORT` to use another port.

If the address changes later, update `SANDCHEST_APP_URL`, restart, and in the App's settings on GitHub change the homepage, webhook URL (`<address>/api/github/webhooks`), callback URL (`<address>/api/auth/callback/github`) and setup URL (`<address>/repos`).

### Optional settings

| Setting | Effect |
|---|---|
| `SMTP_URL`, `EMAIL_FROM` | Email about critical findings and finished deep scans, for example `smtps://user:password@smtp.example.com:465`. |
| `SENTRY_DSN` | Error reports go to your own Sentry project. |
| `SANDCHEST_ADMIN_TOKEN` | Enables `POST /api/scans` with `Authorization: Bearer <token>` and `{"repo": "owner/name"}`, which starts a deep scan. People can also start one with Dig in the dashboard. 24 or more characters: `openssl rand -hex 24`. |
| `LLM_PRICE_INPUT`, `LLM_PRICE_CACHED_INPUT`, `LLM_PRICE_OUTPUT` | The model's prices in USD per million tokens, so each scan records what it cost. |
| `SANDCHEST_SETUP_TOKEN` | Your own setup token (24 or more characters), instead of the one derived from `BETTER_AUTH_SECRET`. |
| `SANDCHEST_IMAGE` | Run a prebuilt image instead of building from this checkout. |

### How it runs

- The `web` image holds the Next.js server, its workflows and the `sandchest-index` indexer for its architecture (amd64 or arm64). It runs as a non-root user, with no Linux capabilities, a read-only root file system and a limit on processes. It writes only scan workspaces and Next's cache.
- The server checks its settings when it starts. If one is wrong, it exits and prints which, and Compose restarts it until you fix it. The health check (`/api/health`) also fails while the database is unreachable.
- Scans run as durable workflows stored in Postgres, inside the `web` container. A scan survives one restart: it runs again from the start when the server comes back, and fails if it is interrupted a second time. Every ten minutes the server also finishes or fails scans that got stuck.
- Each scan clones its repository with a short-lived, read-only token into a temporary directory, which is deleted when the scan ends.
- The workflow engine's internal route (`/.well-known/workflow/…`) has no authentication of its own. The server only answers it on loopback inside the container; from outside it is a 404, however the path is written.
- Postgres is not published on any port. The app connects as a role that owns its database but is not a superuser.
- The base images are pinned by digest, so rebuilding the same commit uses the same images. The two Alpine packages the image adds are not pinned: Alpine keeps only the latest build of each package, so a pinned version would stop installing at its next security fix.
- Sandchest sends nothing to us. Next.js telemetry is off, and billing stays off because no billing key is set. Your code goes only to GitHub and to your model endpoint.

### Upgrading

```sh
cd Sandchest
git pull
cd docker
docker compose up -d --build
```

The server migrates the database before it starts, so there is nothing else to run. Back up first.

### Backups

Everything Sandchest keeps is in the database: findings, threat models, scan history and the dashboard's sessions. Code is never stored. Keep `docker/.env` safe too, since it holds the App's private key.

```sh
# Back up
docker compose exec -T postgres pg_dump -U postgres -Fc sandchest > sandchest.dump

# Restore into a fresh install, before connecting the App to it
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U postgres -d sandchest --clean --if-exists --no-owner --role=sandchest < sandchest.dump
docker compose up -d
```

### Troubleshooting

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

### Testing the stack

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

### Creating the App for a hosted service

The same setup page creates an App that other accounts can install. Run Sandchest on your own machine, with `SANDCHEST_APP_URL` set to the service's public address and no `GITHUB_APP_ID`. Open setup on `http://localhost:<port>`, so GitHub returns the keys to your machine. Choose "Any account" under "Who can install it". Then put the keys in the service's environment.

## Development

This is a Bun workspace: `apps/web` (Next.js), `packages/*` and `crates/indexer` (Rust). `docker/compose.dev.yml` starts a Postgres for development.

```sh
bun install
docker compose -f docker/compose.dev.yml up -d
bun run indexer:build
bunx turbo run typecheck
bun test
```

## Licence

AGPL-3.0. The Sandchest name and logo are trademarks and are not covered by the licence; see [TRADEMARKS.md](TRADEMARKS.md).
