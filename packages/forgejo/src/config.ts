/**
 * A Forgejo or Gitea instance, reached as a bot account. Forgejo has no
 * Apps: the bot's access token does everything an installation token does on
 * GitHub, and the operator chooses which owners it covers.
 */

export interface ForgejoConfig {
  /** The instance's web address, without a trailing slash, e.g. https://git.example.com. */
  url: string;
  /** The REST API: `<url>/api/v1` unless FORGEJO_API_URL says otherwise. */
  apiUrl: string;
  /** Where repositories are cloned from: `<url>` unless FORGEJO_GIT_URL says otherwise. */
  gitUrl: string;
  /** The bot's access token. */
  token: string;
  webhookSecret: string;
  /** What the bot covers: whole owners (users or organisations), or single repositories. */
  owners: Array<{ owner: string; repo?: string }>;
  /** Whether Sandchest creates its webhooks itself, or the operator adds them by hand. */
  manageWebhooks: boolean;
}

/** A Forgejo user, org or repository name; never "." or "..", which would change the API path. */
const OWNER = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

/**
 * Reads `FORGEJO_URL`, `FORGEJO_TOKEN`, `FORGEJO_WEBHOOK_SECRET` and
 * `FORGEJO_OWNERS` (comma-separated `owner` or `owner/repo`), plus the
 * optional `FORGEJO_API_URL`, `FORGEJO_GIT_URL` and `FORGEJO_WEBHOOKS`
 * (`auto`, the default, or `manual`). Undefined when FORGEJO_URL is unset:
 * the deployment does not use Forgejo. Throws when it is set but incomplete.
 */
export function loadForgejoConfig(env: Record<string, string | undefined> = process.env): ForgejoConfig | undefined {
  const value = (name: string) => env[name]?.trim() || undefined;
  const url = value("FORGEJO_URL");
  if (!url) return undefined;
  const missing = ["FORGEJO_TOKEN", "FORGEJO_WEBHOOK_SECRET", "FORGEJO_OWNERS"].filter((name) => !value(name));
  if (missing.length > 0) throw new Error(`Missing Forgejo configuration: ${missing.join(", ")}`);
  const owners = value("FORGEJO_OWNERS")!
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [owner, repo, extra] = entry.split("/");
      if (!owner || !OWNER.test(owner) || (repo !== undefined && !OWNER.test(repo)) || extra !== undefined) throw new Error(`FORGEJO_OWNERS: "${entry}" is not an owner or owner/repo`);
      return repo ? { owner, repo } : { owner };
    });
  const webhooks = value("FORGEJO_WEBHOOKS") ?? "auto";
  if (webhooks !== "auto" && webhooks !== "manual") throw new Error('FORGEJO_WEBHOOKS must be "auto" or "manual"');
  const base = trim(url);
  return {
    url: base,
    apiUrl: trim(value("FORGEJO_API_URL") ?? `${base}/api/v1`),
    gitUrl: trim(value("FORGEJO_GIT_URL") ?? base),
    token: value("FORGEJO_TOKEN")!,
    webhookSecret: value("FORGEJO_WEBHOOK_SECRET")!,
    owners,
    manageWebhooks: webhooks === "auto",
  };
}

function trim(url: string): string {
  return url.replace(/\/+$/, "");
}
