/** better-auth's endpoints: the GitHub OAuth callback, sessions and sign-out. */
import { auth } from "@/server/auth";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return auth().handler(request);
}

export function POST(request: Request): Promise<Response> {
  return auth().handler(request);
}
