/**
 * Creating a GitHub App from a manifest (GitHub docs: "Registering a GitHub
 * App from a manifest"). The browser posts the manifest to GitHub, the
 * operator confirms there, and GitHub sends them back with a one-hour,
 * single-use code that converts into the App's id and secrets.
 *
 * Pure apart from `convertManifest`, so the setup page can build the form in
 * the browser.
 */

/** What the App may do: SPEC §3. */
export const APP_PERMISSIONS = {
  contents: "read",
  metadata: "read",
  pull_requests: "write",
  checks: "write",
  // `issue_comment` events need it: the `/sandchest review` command.
  issues: "read",
  // Who administers an org, for billing and settings.
  members: "read",
  // The sign-in email, for notifications.
  // GitHub's name for "Email addresses" (a manifest with email_addresses is rejected).
  emails: "read",
} as const;

/**
 * The events the App subscribes to. GitHub sends `installation` and
 * `installation_repositories` to every App and refuses a manifest that lists
 * them, and it adds `check_suite` for Apps with the checks permission.
 */
export const APP_EVENTS = ["pull_request", "push", "issue_comment"] as const;

export interface ManifestInput {
  /** The deployment's public URL (`SANDCHEST_APP_URL`): webhooks, sign-in and install return here. */
  appUrl: string;
  /** Where GitHub sends the operator back with the code. */
  redirectUrl: string;
  /** The App's name on GitHub. Names are unique across GitHub; the operator can change it on GitHub's page. */
  name: string;
  /** Installable by any account (the hosted App), or only by the account that owns it (self-hosting). */
  public: boolean;
}

export interface Manifest {
  name: string;
  url: string;
  description: string;
  hook_attributes: { url: string; active: true };
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  setup_on_update: boolean;
  request_oauth_on_install: boolean;
  public: boolean;
  default_permissions: typeof APP_PERMISSIONS;
  default_events: string[];
}

/** GitHub's limit on App names. */
export const APP_NAME_MAX = 34;

export function buildManifest(input: ManifestInput): Manifest {
  const base = trimSlash(input.appUrl);
  return {
    name: input.name.trim().slice(0, APP_NAME_MAX) || "Sandchest",
    url: base,
    description: "Reads your code the way an attacker would and reviews pull requests for exploitable vulnerabilities.",
    hook_attributes: { url: `${base}/api/github/webhooks`, active: true },
    redirect_url: input.redirectUrl,
    callback_urls: [`${base}/api/auth/callback/github`],
    setup_url: `${base}/dashboard`,
    // After someone changes which repositories it can see, send them back so the dashboard refreshes.
    setup_on_update: true,
    // Sign-in is its own step; installing should not also ask to authorise.
    request_oauth_on_install: false,
    public: input.public,
    default_permissions: APP_PERMISSIONS,
    default_events: [...APP_EVENTS],
  };
}

/** GitHub account and organisation logins: letters, digits and single hyphens, at most 39 characters. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export type AppOwner = { kind: "user" } | { kind: "org"; org: string };

/** Where the browser posts the manifest: the signed-in person's account, or an organisation they administer. */
export function manifestFormAction(owner: AppOwner, state: string): string {
  const query = `?state=${encodeURIComponent(state)}`;
  if (owner.kind === "user") return `https://github.com/settings/apps/new${query}`;
  if (!GITHUB_LOGIN.test(owner.org)) throw new Error("Not a GitHub organisation name");
  return `https://github.com/organizations/${owner.org}/settings/apps/new${query}`;
}

/** What the conversion returns that a deployment needs, checked so it can be written into an env file as is. */
export interface CreatedApp {
  id: number;
  slug: string;
  name: string;
  htmlUrl: string;
  owner: string;
  /** Where its keys can be regenerated. */
  settingsUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  pem: string;
}

export class ManifestError extends Error {
  override readonly name = "ManifestError";

  constructor(
    message: string,
    /** GitHub's HTTP status, or 0 when GitHub was not reached or answered with something unexpected. */
    readonly status: number,
  ) {
    super(message);
  }
}

const CODE = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9._-]{1,256}$/;
const PEM = /^-----BEGIN [A-Z ]+-----\r?\n[A-Za-z0-9+/=\r\n]+-----END [A-Z ]+-----\r?\n?$/;

/**
 * Exchanges the code GitHub sent back for the new App's credentials. Codes
 * last an hour and work once. Errors carry GitHub's status only: the body of
 * a successful answer is secret, and is never put in a message or a log.
 */
export async function convertManifest(code: string, options: { baseUrl?: string; fetch?: typeof fetch } = {}): Promise<CreatedApp> {
  if (!CODE.test(code)) throw new ManifestError("GitHub sent back a code in an unexpected format", 0);
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${trimSlash(options.baseUrl ?? "https://api.github.com")}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "sandchest" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ManifestError("Could not reach GitHub", 0);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ManifestError(`GitHub answered ${response.status}`, response.status);
  }
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  const owner = body?.owner as { login?: unknown; type?: unknown } | undefined;
  const app = {
    id: body?.id,
    slug: body?.slug,
    name: body?.name,
    htmlUrl: body?.html_url,
    owner: owner?.login,
    clientId: body?.client_id,
    clientSecret: body?.client_secret,
    webhookSecret: body?.webhook_secret,
    pem: body?.pem,
  };
  const valid =
    Number.isSafeInteger(app.id) &&
    (app.id as number) > 0 &&
    typeof app.slug === "string" &&
    /^[a-z0-9-]{1,64}$/.test(app.slug) &&
    typeof app.name === "string" &&
    typeof app.htmlUrl === "string" &&
    app.htmlUrl.startsWith("https://") &&
    typeof app.owner === "string" &&
    GITHUB_LOGIN.test(app.owner) &&
    typeof app.clientId === "string" &&
    TOKEN.test(app.clientId) &&
    typeof app.clientSecret === "string" &&
    TOKEN.test(app.clientSecret) &&
    typeof app.webhookSecret === "string" &&
    TOKEN.test(app.webhookSecret) &&
    typeof app.pem === "string" &&
    PEM.test(app.pem);
  if (!valid) throw new ManifestError("GitHub's answer was missing some of the App's credentials", 0);
  const settingsUrl =
    owner?.type === "Organization" ? `https://github.com/organizations/${app.owner as string}/settings/apps/${app.slug as string}` : `https://github.com/settings/apps/${app.slug as string}`;
  return { ...(app as Omit<CreatedApp, "settingsUrl">), settingsUrl };
}

/**
 * The lines to add to the deployment's environment. The private key goes on
 * one line with `\n` escapes, which Docker Compose env files and hosting
 * dashboards both accept.
 */
export function envBlock(app: CreatedApp): string {
  const pem = app.pem.replace(/\r/g, "").trimEnd().replace(/\n/g, "\\n");
  return [
    `GITHUB_APP_ID=${app.id}`,
    `GITHUB_APP_SLUG=${app.slug}`,
    `GITHUB_CLIENT_ID=${app.clientId}`,
    `GITHUB_CLIENT_SECRET=${app.clientSecret}`,
    `GITHUB_WEBHOOK_SECRET=${app.webhookSecret}`,
    `GITHUB_APP_PRIVATE_KEY="${pem}\\n"`,
  ].join("\n");
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
