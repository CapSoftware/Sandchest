/** Manual deep scans ("Dig"). Operator-only until dashboard sign-in exists. */
import { DEEP_SCAN_COOLDOWN_HOURS } from "@sandchest/billing";
import { activeDeepScan, createScan, lastDeepScanAt, repoByFullName } from "@sandchest/db";
import { z } from "zod";
import { isOperator } from "@/server/auth";
import { db, githubApp } from "@/server/services";
import { startScan } from "@/server/start";

export const dynamic = "force-dynamic";

const Body = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/) });

export async function POST(request: Request): Promise<Response> {
  if (!isOperator(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "expected { repo: 'owner/name' }" }, { status: 400 });

  const repo = await repoByFullName(db(), parsed.data.repo);
  if (!repo?.enabled || !repo.org.installationId) return Response.json({ error: "repository not installed" }, { status: 404 });

  const active = await activeDeepScan(db(), repo.id);
  if (active) return Response.json({ error: "a deep scan is already running", scanId: active.id }, { status: 409 });
  const last = await lastDeepScanAt(db(), repo.id);
  const nextAllowed = last ? new Date(last.getTime() + DEEP_SCAN_COOLDOWN_HOURS * 3_600_000) : undefined;
  if (nextAllowed && nextAllowed > new Date()) {
    return Response.json({ error: "cooling down", retryAt: nextAllowed.toISOString() }, { status: 429, headers: { "retry-after": String(Math.ceil((nextAllowed.getTime() - Date.now()) / 1000)) } });
  }

  const headSha = await githubApp().installation(repo.org.installationId).branchSha(repo.fullName, repo.defaultBranch);
  const { scan } = await createScan(db(), { repoId: repo.id, orgId: repo.orgId, kind: "deep", trigger: "manual", headSha });
  await startScan(scan.id);
  return Response.json({ scanId: scan.id }, { status: 202 });
}
