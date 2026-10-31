import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import type { Role, Session } from "./types";

export const SESSION_COOKIE = "inv_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14;
const SIGNING_SECRET = process.env.SESSION_SECRET ?? "dev-signing-secret-change-me";

interface Payload {
  v: number;
  uid: string;
  org: string;
  role: Role;
  staff?: boolean;
  iat: number;
}

function sign(data: string): string {
  return createHmac("sha256", SIGNING_SECRET).update(data).digest("base64url");
}

export function encodeSession(session: Session): string {
  const payload: Payload = {
    v: 2,
    uid: session.userId,
    org: session.orgId,
    role: session.role,
    staff: session.staff,
    iat: Math.floor(session.issuedAt / 1000),
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(data)}`;
}

export function decodeSession(token: string | undefined): Session | null {
  if (!token) return null;
  const [data, signature] = token.split(".");
  if (!data) return null;

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as Payload;
  } catch {
    return null;
  }

  if (payload.v >= 2) {
    if (!signature) return null;
    const expected = Buffer.from(sign(data));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  }

  if (Date.now() / 1000 - payload.iat > MAX_AGE_SECONDS) return null;
  return { userId: payload.uid, orgId: payload.org, role: payload.role, staff: Boolean(payload.staff), issuedAt: payload.iat * 1000 };
}

export function sessionFromRequest(request: NextRequest): Session | null {
  return decodeSession(request.cookies.get(SESSION_COOKIE)?.value);
}

export async function currentSession(): Promise<Session | null> {
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}

export function sessionCookie(session: Session) {
  return {
    name: SESSION_COOKIE,
    value: encodeSession(session),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  };
}
