import { NextResponse, type NextRequest } from "next/server";
import { recentEntries } from "@/lib/audit";
import { handle, requireSession } from "@/lib/auth";

export const GET = handle(async (request: NextRequest) => {
  requireSession(request);
  const params = request.nextUrl.searchParams;
  const entries = await recentEntries({
    orgId: params.get("org") ?? undefined,
    action: params.get("action") ?? undefined,
    limit: Math.min(Number(params.get("limit") ?? 100), 1_000),
  });
  return NextResponse.json({ entries });
});
