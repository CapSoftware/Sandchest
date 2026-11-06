/** What's going on across an account, live, for its hacker's page: for people who can see its repositories. */
import { liveRepos } from "@sandchest/db";
import { isUuid } from "@/lib/uuid";
import { currentUser, ensureAccess } from "@/server/access";
import { liveResponse } from "@/server/account-live";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request, { params }: { params: Promise<{ org: string }> }): Promise<Response> {
  const { org } = await params;
  if (!isUuid(org)) return Response.json({ error: "not found" }, { status: 404 });
  const user = await currentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  await ensureAccess(user.id, { checkedAt: user.accessCheckedAt });
  const repos = await liveRepos(db(), user.id, org);
  if (repos.length === 0) return Response.json({ error: "not found" }, { status: 404 });
  // Resume after the last item the page has: the browser sends it when it reconnects, the page on its first connect.
  const raw = request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after");
  const after = raw && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
  return liveResponse(request, user.id, org, new Set(repos), after);
}
