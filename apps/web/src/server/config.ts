/**
 * Server configuration, validated once. A misconfigured deployment fails on
 * its first request with every problem listed, not halfway through a scan.
 */
import { parseMultiplier, usdToMicroUsd } from "@sandchest/billing/usage";
import type { ScanPricing } from "@sandchest/db";
import { z } from "zod";

/** A positive amount in USD, at most six digits each side of the point. */
function usd() {
  return z
    .string()
    .regex(/^\d{1,6}(\.\d{1,6})?$/, "a positive decimal amount in USD")
    .refine((value) => Number(value) > 0, "a positive decimal amount in USD");
}

const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  /**
   * A connection pooler in front of the same database (PgBouncer, transaction
   * mode). When set, the app's queries go through it, so the database's
   * connection count is fixed by the pooler whatever the traffic. Migrations
   * (DATABASE_MIGRATION_URL) and the self-hosted workflow World need a direct
   * connection and never use it. Default DATABASE_URL.
   */
  DATABASE_POOLER_URL: z.string().min(1).optional(),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  /** Public URL of this app, for links in Checks and comments. */
  SANDCHEST_APP_URL: z.url(),
  /** Bearer token for operator-only routes (manual scans, any scan's live feed). */
  SANDCHEST_ADMIN_TOKEN: z.string().min(24).optional(),
  /**
   * Error reporting to Sentry. Unset means nothing loads and nothing is sent.
   * SENTRY_DSN covers the server; NEXT_PUBLIC_SENTRY_DSN (read at build time)
   * adds a small reporter to every page. Either may be set alone.
   */
  SENTRY_DSN: z.url().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.url().optional(),
  /** Tags events with an environment, e.g. "production". Default: VERCEL_ENV or NODE_ENV. */
  SENTRY_ENVIRONMENT: z.string().max(64).optional(),
  /** Signs sessions and encrypts stored GitHub tokens. */
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  /** The GitHub App's OAuth client, used for sign-in. */
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  /** The App's URL name, for install links (github.com/apps/<slug>). */
  GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]+$/).optional(),
  /** Email: Resend in the cloud, SMTP when self-hosted. Neither set means no email. */
  RESEND_API_KEY: z.string().min(1).optional(),
  SMTP_URL: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(3).optional(),
  /** Billing (Autumn). Unset means billing is off and nothing is limited, as when self-hosting. */
  AUTUMN_SECRET_KEY: z.string().min(1).optional(),
  AUTUMN_BASE_URL: z.url().optional(),
  /** Signing secret (`whsec_…`) of the Autumn webhook endpoint. Unset means the endpoint answers 404. */
  AUTUMN_WEBHOOK_SECRET: z.string().min(1).optional(),
  /**
   * The Stripe account Autumn bills through. With both set, cards are taken on
   * the page (Stripe's Payment Element) instead of on Stripe Checkout.
   */
  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_/, "a Stripe secret or restricted key (sk_… or rk_…)").optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().regex(/^pk_/, "a Stripe publishable key (pk_…)").optional(),
  /**
   * Codes that give free credits (FREE_CREDITS) when typed into the code box
   * at checkout, comma-separated, any case. Entries that aren't 4–64 letters,
   * digits, dashes or underscores are ignored, never an error. Unset means
   * no codes; the /claim page works either way.
   */
  SANDCHEST_FREE_CREDIT_CODES: z.string().max(2_000).optional(),
  /** Where scans run: a Vercel Sandbox per scan, a Boat sandbox per scan, or a temporary directory on this host. */
  SANDCHEST_WORKSPACE: z.enum(["sandbox", "local", "boat"]).optional(),
  /** Boat (boat.dev) API key. Required, and only read, when SANDCHEST_WORKSPACE=boat. */
  SANDCHEST_BOAT_API_KEY: z.string().min(1).optional(),
  /** Boat machine size. Default "default" (4 vCPU, 8 GB). */
  SANDCHEST_BOAT_TYPE: z.enum(["small", "default", "large", "xlarge"]).optional(),
  /** Seconds before a Boat sandbox stops itself if a scan never deletes it. Default: the scan's own budget. */
  SANDCHEST_BOAT_TTL_SECONDS: z.coerce.number().int().min(60).max(2_592_000).optional(),
  /**
   * Signs the tokens a scan's sandbox uses to reach a model through /api/gateway. Unset means the
   * gateway answers 404 and no scan can use it. Where it forwards to is LLM_AGENT_* (see the gateway).
   */
  SANDCHEST_GATEWAY_SECRET: z.string().min(32).optional(),
  /** GitHub's REST API. Default https://api.github.com; tests point it at a fake. */
  GITHUB_API_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Where repositories are cloned from. Default https://github.com. */
  SANDCHEST_GIT_HOST: z.url().optional(),
  /** Indexer for local workspaces (this host's platform). */
  SANDCHEST_INDEXER_BIN: z.string().optional(),
  /** Indexer for sandboxes (static x86_64 Linux build), as a local file. */
  SANDCHEST_INDEXER_LINUX_BIN: z.string().optional(),
  /** ...or as a release download, verified by checksum inside the sandbox. */
  SANDCHEST_INDEXER_LINUX_URL: z.url().optional(),
  SANDCHEST_INDEXER_LINUX_SHA256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /**
   * The indexer build the slice engine uses, as a release download with its checksum. Both or neither.
   * Unset means the same build as every other scan (SANDCHEST_INDEXER_LINUX_*), so a newer indexer can be
   * tried on the slice engine without changing what classic scans run.
   */
  SANDCHEST_SLICE_INDEXER_LINUX_URL: z.url().optional(),
  SANDCHEST_SLICE_INDEXER_LINUX_SHA256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Which engine runs deep scans and PR reviews. Default `classic`. `slice` needs a Boat API key, the Linux indexer, the gateway and its ceilings. */
  SANDCHEST_ENGINE: z.enum(["classic", "slice"]).optional(),
  /** GitHub account logins, comma-separated, any case. When set, only these accounts' deep scans and PR reviews use the slice engine. */
  SANDCHEST_ENGINE_ORGS: z.string().max(2_000).optional(),
  /** The most one slice deep scan may cost in model and sandbox spend, in USD. Required for the slice engine. */
  SANDCHEST_SLICE_CEILING_USD: usd().optional(),
  /** The same for one slice pull request review. Required for the slice engine. */
  SANDCHEST_SLICE_CEILING_PR_USD: usd().optional(),
  /** A JSON object of fields set on every model request of the slice engine's own calls (endpoint options). */
  LLM_SLICE_BODY: z.string().optional(),
  /** Fast deep scans (see `fastModeAvailable`): the most one may cost, in USD. */
  SANDCHEST_SLICE_CEILING_FAST_USD: usd().optional(),
  /** LLM_SLICE_BODY for fast runs. Never falls back to it: the body is what picks the serving. */
  LLM_SLICE_FAST_BODY: z.string().optional(),
  /** The gateway reads these itself (see `loadFastGatewayUpstream`); here they only tell whether fast mode is available. */
  LLM_AGENT_FAST_MODEL: z.string().optional(),
  LLM_AGENT_FAST_BODY: z.string().optional(),
  /** Usage billing for slice scans: `off` (default), `shadow` (a usage bill beside the tiered charge, never charged) or `on`. */
  SANDCHEST_USAGE_BILLING: z.enum(["off", "shadow", "on"]).optional(),
  /** The multiplier on cost for usage bills: a decimal from 1 to 100, up to three places. Read with `usageMultiplierThousandths`; never logged. */
  SANDCHEST_USAGE_MULTIPLIER: z.string().optional(),
  /** What one credit is worth: `dollar` (default) or `cent`. */
  NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: z.enum(["dollar", "cent"]).optional(),
});

export type Config = z.infer<typeof Schema> & { workspace: "sandbox" | "local" | "boat" };

let cached: Config | undefined;

/** For tests that change the environment between files. */
export function resetConfig(): void {
  cached = undefined;
}

export function config(env: Record<string, string | undefined> = process.env): Config {
  if (cached && env === process.env) return cached;
  // An empty value means unset: env files and Docker Compose pass blanks for settings left empty.
  const parsed = Schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== "")));
  if (!parsed.success) {
    throw new Error(`Invalid server configuration:\n  ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
  }
  // On Vercel scans get a sandbox; self-hosted installs scan on the host.
  const workspace = parsed.data.SANDCHEST_WORKSPACE ?? (env.VERCEL ? "sandbox" : "local");
  if (workspace !== "local" && !parsed.data.SANDCHEST_INDEXER_LINUX_BIN && !(parsed.data.SANDCHEST_INDEXER_LINUX_URL && parsed.data.SANDCHEST_INDEXER_LINUX_SHA256)) {
    throw new Error("Sandbox scans need SANDCHEST_INDEXER_LINUX_BIN, or SANDCHEST_INDEXER_LINUX_URL with SANDCHEST_INDEXER_LINUX_SHA256.");
  }
  if (workspace === "boat" && !parsed.data.SANDCHEST_BOAT_API_KEY) throw new Error("Boat scans need SANDCHEST_BOAT_API_KEY.");
  const problems: string[] = [];
  if (parsed.data.SANDCHEST_ENGINE === "slice") {
    if ((parsed.data.SANDCHEST_SLICE_INDEXER_LINUX_URL === undefined) !== (parsed.data.SANDCHEST_SLICE_INDEXER_LINUX_SHA256 === undefined)) {
      problems.push("SANDCHEST_SLICE_INDEXER_LINUX_URL and SANDCHEST_SLICE_INDEXER_LINUX_SHA256: set both or neither");
    }
    // The slice engine opens its own Boat sandboxes whatever SANDCHEST_WORKSPACE says, so classic scans stay where they run today.
    if (!parsed.data.SANDCHEST_BOAT_API_KEY) problems.push("SANDCHEST_BOAT_API_KEY: is required by the slice engine");
    if (!parsed.data.SANDCHEST_INDEXER_LINUX_BIN && !(parsed.data.SANDCHEST_INDEXER_LINUX_URL && parsed.data.SANDCHEST_INDEXER_LINUX_SHA256)) {
      problems.push("SANDCHEST_INDEXER_LINUX_BIN, or SANDCHEST_INDEXER_LINUX_URL with SANDCHEST_INDEXER_LINUX_SHA256: is required by the slice engine");
    }
    if (!parsed.data.SANDCHEST_GATEWAY_SECRET) problems.push("SANDCHEST_GATEWAY_SECRET: is required by the slice engine");
    if (!parsed.data.SANDCHEST_SLICE_CEILING_USD) problems.push("SANDCHEST_SLICE_CEILING_USD: is required by the slice engine");
    if (!parsed.data.SANDCHEST_SLICE_CEILING_PR_USD) problems.push("SANDCHEST_SLICE_CEILING_PR_USD: is required by the slice engine");
    const body = sliceBody(parsed.data.LLM_SLICE_BODY);
    if ("problem" in body) problems.push(`LLM_SLICE_BODY: ${body.problem}`);
    for (const name of ["LLM_SLICE_FAST_BODY", "LLM_AGENT_FAST_BODY"] as const) {
      const fast = sliceBody(parsed.data[name]);
      if ("problem" in fast) problems.push(`${name}: ${fast.problem}`);
    }
  }
  problems.push(...usageBillingProblems(parsed.data));
  if (problems.length > 0) throw new Error(`Invalid server configuration:\n  ${problems.join("\n  ")}`);
  const result = { ...parsed.data, workspace };
  if (env === process.env) cached = result;
  return result;
}

/**
 * Which engine runs a scan. The slice engine runs deep scans and PR reviews only, when SANDCHEST_ENGINE
 * is `slice` and, if SANDCHEST_ENGINE_ORGS is set, only for the accounts it names. Everything else is classic.
 */
export function scanEngine(kind: string, githubLogin: string, settings: Config = config()): "classic" | "slice" {
  if ((kind !== "deep" && kind !== "pr_review") || !onSliceEngine(githubLogin, settings)) return "classic";
  return "slice";
}

/** Whether the slice engine is on for an account: SANDCHEST_ENGINE is `slice` and, if SANDCHEST_ENGINE_ORGS is set, it names the account. */
function onSliceEngine(githubLogin: string, settings: Config): boolean {
  if (settings.SANDCHEST_ENGINE !== "slice") return false;
  if (settings.SANDCHEST_ENGINE_ORGS === undefined) return true;
  return settings.SANDCHEST_ENGINE_ORGS.split(",").map((login) => login.trim().toLowerCase()).includes(githubLogin.toLowerCase());
}

/**
 * Where an account's classic work runs (recon, fix checks, CVE reads, and scans the slice engine does not
 * take): Boat for an account the slice engine is on, so everything of that account is on one sandbox host;
 * the configured workspace for every other account.
 */
export function scanWorkspace(githubLogin: string, settings: Config = config()): Config["workspace"] {
  return onSliceEngine(githubLogin, settings) ? "boat" : settings.workspace;
}

/**
 * Whether a deep scan may be started fast: the slice engine runs, SANDCHEST_SLICE_CEILING_FAST_USD is set, and
 * both the agent's calls (LLM_AGENT_FAST_MODEL or LLM_AGENT_FAST_BODY) and the engine's own calls
 * (LLM_AGENT_FAST_MODEL or LLM_SLICE_FAST_BODY) really differ from standard ones.
 */
export function fastModeAvailable(settings: Config = config()): boolean {
  if (settings.SANDCHEST_ENGINE !== "slice" || !settings.SANDCHEST_SLICE_CEILING_FAST_USD) return false;
  const model = settings.LLM_AGENT_FAST_MODEL !== undefined;
  return (model || settings.LLM_AGENT_FAST_BODY !== undefined) && (model || settings.LLM_SLICE_FAST_BODY !== undefined);
}

/**
 * Whether a scan flagged fast may run fast now: a deep scan, on the slice engine for its account, with fast
 * mode available. Anything else runs standard.
 */
export function fastRunAllowed(scan: { fast: boolean; kind: string }, githubLogin: string, settings: Config = config()): boolean {
  return scan.fast && scan.kind === "deep" && scanEngine(scan.kind, githubLogin, settings) === "slice" && fastModeAvailable(settings);
}

/**
 * Whether a person may choose a fast deep scan for an account: fast mode is available, the account's deep scans
 * run on the slice engine, and they are billed from their usage (a fast scan costs more, so only a scan charged
 * what it uses is offered one). Never decided by the browser.
 */
export function fastOffered(githubLogin: string, settings: Config = config()): boolean {
  const engine = scanEngine("deep", githubLogin, settings);
  return fastModeAvailable(settings) && engine === "slice" && scanPricingMode(engine, settings) === "usage";
}

/**
 * What is wrong with the usage billing settings. A multiplier that is set must be valid even with usage billing
 * off, so a typo is caught before the day it matters. `shadow` and `on` need the slice engine and a multiplier;
 * `on` also needs credits worth a cent. Problems never repeat the multiplier's value.
 */
function usageBillingProblems(settings: z.infer<typeof Schema>): string[] {
  const problems: string[] = [];
  const multiplier = settings.SANDCHEST_USAGE_MULTIPLIER;
  if (multiplier !== undefined && parseMultiplier(multiplier) === undefined) {
    problems.push("SANDCHEST_USAGE_MULTIPLIER: must be a decimal from 1 to 100 with at most three decimal places");
  }
  const billing = settings.SANDCHEST_USAGE_BILLING ?? "off";
  if (billing === "off") return problems;
  if (multiplier === undefined) problems.push("SANDCHEST_USAGE_MULTIPLIER: is required by usage billing");
  if (settings.SANDCHEST_ENGINE !== "slice") problems.push("SANDCHEST_ENGINE: must be slice for usage billing");
  if (billing === "on" && settings.NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT !== "cent") problems.push("NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: must be cent when usage billing is on");
  return problems;
}

/** The usage multiplier in thousandths (1,000 = cost price), or undefined when it is not set. */
export function usageMultiplierThousandths(settings: Config = config()): number | undefined {
  const text = settings.SANDCHEST_USAGE_MULTIPLIER;
  return text === undefined ? undefined : parseMultiplier(text);
}

/** What one credit is worth. Default `dollar`. */
export function creditUnit(settings: Config = config()): "dollar" | "cent" {
  return settings.NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT ?? "dollar";
}

/** One credit in micro-dollars. */
export function creditMicroUsd(unit: "dollar" | "cent"): number {
  return unit === "cent" ? 10_000 : 1_000_000;
}

/** A slice scan's ceiling in micro-dollars, as the settings give it: a fast run's, a pull request's or a deep scan's. Undefined when unset. */
export function sliceCeilingMicroUsd(kind: string, fast: boolean, settings: Config = config()): number | undefined {
  const ceiling = fast ? settings.SANDCHEST_SLICE_CEILING_FAST_USD : kind === "pr_review" ? settings.SANDCHEST_SLICE_CEILING_PR_USD : settings.SANDCHEST_SLICE_CEILING_USD;
  return ceiling ? usdToMicroUsd(ceiling) : undefined;
}

/**
 * How a scan is priced if its credits are reserved now: its engine, its pricing mode and the credit's size; for
 * `usage` and `shadow`, also the multiplier, whether it may run fast, and the most it may spend (a pull request's
 * ceiling, a deep scan's, or for a scan that may run fast the larger of the fast and deep ones, since a fast scan
 * can fall back to standard).
 */
export function scanPricing(scan: { kind: string; fast: boolean }, githubLogin: string, settings: Config = config()): ScanPricing {
  const engine = scanEngine(scan.kind, githubLogin, settings);
  const mode = scanPricingMode(engine, settings);
  const unit = creditUnit(settings);
  if (mode === "tiered") return { engine, mode, unit };
  const fast = fastRunAllowed(scan, githubLogin, settings);
  const standard = sliceCeilingMicroUsd(scan.kind, false, settings);
  const ceilingMicroUsd = fast ? Math.max(sliceCeilingMicroUsd(scan.kind, true, settings) ?? 0, standard ?? 0) : standard;
  const multiplierThousandths = usageMultiplierThousandths(settings);
  if (!ceilingMicroUsd || multiplierThousandths === undefined) throw new Error("Usage billing needs the scan's ceiling and the multiplier");
  return { engine, mode, unit, multiplierThousandths, ceilingMicroUsd, fast };
}

/**
 * How a scan on an engine is priced: `tiered` (credits by size) for classic scans always, and for slice scans
 * while usage billing is off; `shadow` or `usage` for slice scans otherwise.
 */
export function scanPricingMode(engine: "classic" | "slice", settings: Config = config()): "tiered" | "shadow" | "usage" {
  if (engine !== "slice") return "tiered";
  const billing = settings.SANDCHEST_USAGE_BILLING ?? "off";
  if (billing === "on") return "usage";
  if (billing === "shadow") return "shadow";
  return "tiered";
}

/** LLM_SLICE_BODY as an object (empty when unset), or what is wrong with it. */
export function sliceBody(text: string | undefined): { body: Record<string, unknown> } | { problem: string } {
  if (text === undefined || text.trim() === "") return { body: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return { body: value as Record<string, unknown> };
  } catch {
    // Reported below.
  }
  return { problem: "must be a JSON object" };
}
