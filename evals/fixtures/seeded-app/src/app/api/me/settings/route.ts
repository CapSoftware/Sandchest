import { NextResponse, type NextRequest } from "next/server";
import { handle, requireSession } from "@/lib/auth";
import { loadSettings, saveSettings } from "@/lib/settings";

export const GET = handle(async (request: NextRequest) => {
  const session = requireSession(request);
  return NextResponse.json({ settings: await loadSettings(session.userId) });
});

export const PATCH = handle(async (request: NextRequest) => {
  const session = requireSession(request);
  const patch = (await request.json()) as Record<string, unknown>;
  return NextResponse.json({ settings: await saveSettings(session.userId, patch) });
});
