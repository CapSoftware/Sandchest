import { NextResponse, type NextRequest } from "next/server";
import { record } from "@/lib/audit";
import { handle, HttpError, loadUser, requireSession } from "@/lib/auth";
import { updateProfile } from "@/lib/users";

export const GET = handle(async (request: NextRequest) => {
  const user = await loadUser(requireSession(request));
  return NextResponse.json({ user });
});

export const PATCH = handle(async (request: NextRequest) => {
  const session = requireSession(request);
  const body = (await request.json()) as Record<string, unknown>;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Expected an object");
  if ("email" in body && typeof body.email !== "string") throw new HttpError(400, "Invalid email");

  const user = await updateProfile(session.userId, body);
  await record(session.orgId, session.userId, "user.update", session.userId, { fields: Object.keys(body) });
  return NextResponse.json({ user });
});
