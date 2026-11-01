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
  /** Bearer token for operator-only routes (manual scans) until dashboard auth exists. */
  SANDCHEST_ADMIN_TOKEN: z.string().min(24).optional(),
  /** Where scans run: a Vercel Sandbox per scan, or a temporary directory on this host. */
  SANDCHEST_WORKSPACE: z.enum(["sandbox", "local"]).optional(),
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

export function config(env: Record<string, string | undefined> = process.env): Config {
  if (cached && env === process.env) return cached;
  const parsed = Schema.safeParse(env);
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
