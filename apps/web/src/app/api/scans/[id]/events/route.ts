/** The live feed as server-sent events, for people who can see the scan's repository (or operators). */
import { canSeeScan, feedSince, scanById } from "@sandchest/db";
import { isUuid } from "@/lib/uuid";
import { currentUser, ensureAccess } from "@/server/access";
import { isOperator } from "@/server/auth";
import { db } from "@/server/db";
import { feedResponse } from "@/server/scan-feed";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "not found" }, { status: 404 });
  let viewer: string | null = null;
  if (!isOperator(request)) {
    const user = await currentUser();
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
    await ensureAccess(user.id, { checkedAt: user.accessCheckedAt });
    if (!(await canSeeScan(db(), user.id, id))) return Response.json({ error: "not found" }, { status: 404 });
    viewer = user.id;
  } else if (!(await scanById(db(), id))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return feedResponse(request, (after) => feedSince(db(), id, after), viewer);
}
