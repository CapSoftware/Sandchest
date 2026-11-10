/**
 * A pull request review started from the dashboard: the same review a push
 * or `/sandchest review` starts, priced from the PR's changed files and held
 * before it runs, so a refusal is said at once and leaves nothing behind.
 */
import { randomUUID } from "node:crypto";
import { prReviewCredits } from "@sandchest/billing";
import { createScan, deleteUnstartedScan, prReviewStates, type Org, type Repo } from "@sandchest/db";
import { changedLines, relevantChanges } from "@sandchest/engine/scan";
import { parsePatch, type PullFile } from "@sandchest/github";
import { autumn, billingEnabled, heldCredits, reserveScan } from "./billing";
import { scanPricing } from "./config";
import { describeError } from "./log";
import { db, githubApp } from "./services";
import { startScan } from "./start";

export type PrReviewResult =
  | { ok: true; scanId: string; credits: number }
  | { ok: false; reason: "not_installed" | "reviews_off" | "not_open" | "reviewed" | "no_plan" | "out_of_credits"; scanId?: string; credits?: number };

type InstalledRepo = Repo & { org: Org };

/** What reviewing the PR's head would cost, or why it can't be reviewed. */
export async function quotePrReview(repo: InstalledRepo, prNumber: number): Promise<PrReviewResult> {
  const checked = await reviewable(repo, prNumber);
  if (!checked.ok) return checked;
  return { ok: true, scanId: "", credits: checked.credits };
}

/** Starts a review of the PR's head. `credits` is the price the person confirmed: a higher one now is asked again. */
export async function startPrReview(repo: InstalledRepo, prNumber: number, confirmed: number): Promise<PrReviewResult | { ok: false; reason: "price_changed"; credits: number }> {
  const checked = await reviewable(repo, prNumber);
  if (!checked.ok) return checked;
  // With billing off nothing is priced, so there is nothing to confirm.
  if (billingEnabled() && checked.credits > confirmed) return { ok: false, reason: "price_changed", credits: checked.credits };

  const { pull, credits, pricing } = checked;
  const { scan, created } = await createScan(db(), {
    id: randomUUID(),
    repoId: repo.id,
    orgId: repo.orgId,
    kind: "pr_review",
    trigger: "manual",
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    prNumber,
  });
  // Someone pushed or pressed Review a moment earlier: that review covers this head.
  if (!created) return { ok: false, reason: "reviewed", scanId: scan.id };
  let gate: Awaited<ReturnType<typeof reserveScan>>;
  try {
    gate = await reserveScan(scan.id, { id: repo.org.id, githubLogin: repo.org.githubLogin }, credits, true, { pricing });
  } catch (error) {
    await autumn()?.finalize({ customerId: repo.org.id, lockId: scan.id, action: "release" }).catch(() => {});
    await deleteUnstartedScan(db(), scan.id);
    throw error;
  }
  if (!gate.ok) {
    await deleteUnstartedScan(db(), scan.id);
    return { ok: false, reason: gate.reason, credits };
  }
  // If this start fails, the sweep starts it within minutes: the credits stay held for it.
  await startScan(scan.id).catch((error: unknown) => console.error(`Starting PR review ${scan.id} failed: ${describeError(error)}`));
  return { ok: true, scanId: scan.id, credits };
}

async function reviewable(repo: InstalledRepo, prNumber: number) {
  if (!repo.enabled || !repo.org.installationId) return { ok: false as const, reason: "not_installed" as const };
  if (repo.prReviews === "off") return { ok: false as const, reason: "reviews_off" as const };
  const installation = githubApp().installation(repo.org.installationId);
  const pull = await installation.pull(repo.fullName, prNumber);
  if (pull.state !== "open") return { ok: false as const, reason: "not_open" as const };
  const latest = (await prReviewStates(db(), repo.id, [prNumber])).get(prNumber);
  if (latest && latest.headSha === pull.head.sha && ["queued", "running", "publishing", "completed"].includes(latest.status)) {
    return { ok: false as const, reason: "reviewed" as const, scanId: latest.scanId };
  }
  const files = await installation.pullFiles(repo.fullName, prNumber);
  // What is quoted is what is held: a review billed from its usage holds enough for its ceiling.
  const pricing = scanPricing({ kind: "pr_review", fast: false }, repo.org.githubLogin);
  return { ok: true as const, pull, credits: heldCredits(pricing, reviewCredits(files)), pricing };
}

/** What a review of these files costs: the engine's own measure of the change (SPEC §12). */
function reviewCredits(files: PullFile[]): number {
  const relevant = relevantChanges(
    files.map((file) => ({
      path: file.filename,
      status: file.status === "changed" || file.status === "unchanged" ? "modified" : file.status,
      additions: file.additions,
      deletions: file.deletions,
      hunks: parsePatch(file.filename, file.patch).hunks,
      patch: file.patch,
    })),
  );
  return relevant.length ? prReviewCredits(changedLines(relevant)) : 0;
}
