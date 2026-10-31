import { NextResponse, type NextRequest } from "next/server";
import { queryOne } from "./db";
import { sessionFromRequest } from "./session";
import type { Session, User } from "./types";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireSession(request: NextRequest): Session {
  const session = sessionFromRequest(request);
  if (!session) throw new HttpError(401, "Sign in required");
  return session;
}

export function requireAdmin(request: NextRequest): Session {
  const session = requireSession(request);
  if (!session.staff) throw new HttpError(403, "Staff only");
  return session;
}

export function requireOrgRole(session: Session, roles: Session["role"][]): void {
  if (!roles.includes(session.role)) throw new HttpError(403, "Insufficient role");
}

export async function loadUser(session: Session): Promise<User> {
  const user = await queryOne<User>("SELECT * FROM users WHERE id = $1", [session.userId]);
  if (!user) throw new HttpError(401, "Unknown user");
  return user;
}

export function handle<Args extends unknown[]>(handler: (request: NextRequest, ...args: Args) => Promise<Response>) {
  return async (request: NextRequest, ...args: Args): Promise<Response> => {
    try {
      return await handler(request, ...args);
    } catch (error) {
      if (error instanceof HttpError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error("Unhandled error", { path: request.nextUrl.pathname });
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  };
}
