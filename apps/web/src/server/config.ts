/**
 * Server configuration, validated once. A misconfigured deployment fails on
 * its first request with every problem listed, not halfway through a scan.
 */
import { z } from "zod";

const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  /** Public URL of this app, for links in Checks and comments. */
  SANDCHEST_APP_URL: z.url(),
  /** Bearer token for operator-only routes (manual scans, any scan's live feed). */
  SANDCHEST_ADMIN_TOKEN: z.string().min(24).optional(),
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
  /** Where scans run: a Vercel Sandbox per scan, or a temporary directory on this host. */
  SANDCHEST_WORKSPACE: z.enum(["sandbox", "local"]).optional(),
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
});

export type Config = z.infer<typeof Schema> & { workspace: "sandbox" | "local" };

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
  if (workspace === "sandbox" && !parsed.data.SANDCHEST_INDEXER_LINUX_BIN && !(parsed.data.SANDCHEST_INDEXER_LINUX_URL && parsed.data.SANDCHEST_INDEXER_LINUX_SHA256)) {
    throw new Error("Sandbox scans need SANDCHEST_INDEXER_LINUX_BIN, or SANDCHEST_INDEXER_LINUX_URL with SANDCHEST_INDEXER_LINUX_SHA256.");
  }
  const result = { ...parsed.data, workspace };
  if (env === process.env) cached = result;
  return result;
}
