import { NextResponse } from "next/server";

export function proxy(req: Request) {
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*"] };
