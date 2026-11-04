/** Manual deep scans for operators (`Authorization: Bearer <SANDCHEST_ADMIN_TOKEN>`). People use the dashboard's Deep scan button. */
import { FORGES, repoByFullName } from "@sandchest/db";
import { z } from "zod";
import { isOperator } from "@/server/auth";
import { requestDeepScan } from "@/server/dig";
import { db } from "@/server/services";

export const dynamic = "force-dynamic";

/** `provider` says which forge the repository is on, when a deployment uses Forgejo too. */
const Body = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), provider: z.enum(FORGES).default("github") });

export async function POST(request: Request): Promise<Response> {
  if (!isOperator(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "expected { repo: 'owner/name', provider?: 'github' | 'forgejo' }" }, { status: 400 });

  const repo = await repoByFullName(db(), parsed.data.repo, parsed.data.provider);
  if (!repo) return Response.json({ error: "repository not installed" }, { status: 404 });
  const result = await requestDeepScan(repo, "manual", { operator: true });
  if (result.ok) return Response.json({ scanId: result.scanId }, { status: 202 });
  switch (result.reason) {
    case "not_installed":
      return Response.json({ error: "repository not installed" }, { status: 404 });
    case "running":
      return Response.json({ error: "a deep scan is already running", scanId: result.scanId }, { status: 409 });
    case "too_large":
      return Response.json({ error: "repository is over 1M lines; deep scans are refused" }, { status: 422 });
    case "no_plan":
    case "out_of_credits":
      return Response.json({ error: result.reason === "no_plan" ? "this account has no plan" : "out of credits", credits: result.credits }, { status: 402 });
  }
}
