/**
 * Creates a GitHub App of your own for local development and writes
 * `.env.development.local`, which `next dev` reads ahead of `.env.local`:
 * the App's keys, the local database, and billing and email switched off,
 * so nothing a local server does reaches production.
 *
 *   docker compose -f docker/compose.dev.yml up -d
 *   bun scripts/dev-app.ts                 # owned by your account
 *   bun scripts/dev-app.ts --org acme      # owned by an organisation you administer
 *   bun scripts/dev-app.ts --webhooks https://smee.io/abc123
 *
 * The App is private and points at http://localhost:3000. GitHub can't reach
 * localhost, so webhooks stay off unless you pass a public URL that forwards
 * to /api/github/webhooks (a smee.io channel, say). Without them, sign-in,
 * installs and the dashboard work; pull request reviews don't start on their own.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, convertManifest, envBlock, manifestFormAction, type AppOwner } from "@sandchest/github/manifest";

const APP_URL = "http://localhost:3000";
const LOCAL_DB = "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const ENV_FILE = join(import.meta.dir, "..", ".env.development.local");

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const org = flag("--org");
const webhooks = flag("--webhooks");
if (webhooks && !/^https:\/\//.test(webhooks)) throw new Error("--webhooks takes a public https:// URL");
if (existsSync(ENV_FILE) && /^GITHUB_APP_ID=./m.test(readFileSync(ENV_FILE, "utf8")) && !args.includes("--force")) {
  throw new Error(".env.development.local already has a GitHub App. Pass --force to replace it.");
}

const owner: AppOwner = org ? { kind: "org", org } : { kind: "user" };
const state = randomBytes(16).toString("hex");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return html(form());
    if (url.pathname !== "/done") return new Response("Not found", { status: 404 });
    if (url.searchParams.get("state") !== state) return html("<p>That link isn’t from this run. Start the script again.</p>", 400);
    try {
      const app = await convertManifest(url.searchParams.get("code") ?? "");
      writeFileSync(ENV_FILE, envFile(envBlock(app)), { mode: 0o600 });
      chmodSync(ENV_FILE, 0o600); // `mode` only applies to a new file; this one may have been there already.
      console.log(`\nCreated ${app.name} (${app.htmlUrl}) and wrote .env.development.local.`);
      console.log(`Install it on a repository: https://github.com/apps/${app.slug}/installations/new`);
      console.log("Then restart `next dev` and sign in at http://localhost:3000.");
      setTimeout(() => process.exit(0), 250);
      return html(`<p>Done: <b>${escape(app.name)}</b> is set up. Back in the terminal for the next steps.</p>`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Couldn’t convert the code");
      setTimeout(() => process.exit(1), 250);
      return html("<p>GitHub didn’t hand over the App’s keys. The terminal has the reason.</p>", 502);
    }
  },
});

function form(): string {
  const base = buildManifest({
    appUrl: APP_URL,
    redirectUrl: `http://127.0.0.1:${server.port}/done`,
    name: `Sandchest Dev ${randomBytes(2).toString("hex")}`,
    public: false,
  });
  const manifest = { ...base, hook_attributes: webhooks ? { url: webhooks, active: true } : { url: "https://example.com/", active: false } };
  return `<form method="post" action="${escape(manifestFormAction(owner, state))}">
<input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
<p>Sending you to GitHub to create a private dev App…</p><button>Continue</button></form>
<script>document.forms[0].submit()</script>`;
}

function envFile(app: string): string {
  return `# Local development, written by scripts/dev-app.ts. Read by \`next dev\` ahead of .env.local,
# so a local server never uses the production database, GitHub App, billing or email.
SANDCHEST_APP_URL=${APP_URL}
DATABASE_URL=${LOCAL_DB}
DATABASE_POOLER_URL=
DATABASE_REPLICA_URL=
DATABASE_MIGRATION_URL=
BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}
${app}
STRIPE_SECRET_KEY=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
AUTUMN_SECRET_KEY=
AUTUMN_SANDBOX_SECRET_KEY=
AUTUMN_WEBHOOK_SECRET=
RESEND_API_KEY=
SMTP_URL=
`;
}

function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Sandchest dev App</title><body style="font:16px system-ui;margin:3rem">${body}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const start = `http://127.0.0.1:${server.port}/`;
console.log(`Open ${start} to create the App on GitHub.`);
try {
  Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", start], { stdout: "ignore", stderr: "ignore" });
} catch {
  // No opener on this machine: the link above does the same.
}
