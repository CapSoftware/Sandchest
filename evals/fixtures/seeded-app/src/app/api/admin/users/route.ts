import { NextResponse, type NextRequest } from "next/server";
import { handle, requireAdmin } from "@/lib/auth";
import { query } from "@/lib/db";
import type { User } from "@/lib/types";

export const GET = handle(async (request: NextRequest) => {
  requireAdmin(request);
  const search = request.nextUrl.searchParams.get("email");
  const users = search
    ? await query<User>("SELECT id, email, name, role, org_id, is_staff, created_at FROM users WHERE email ILIKE $1 LIMIT 100", [`%${search}%`])
    : await query<User>("SELECT id, email, name, role, org_id, is_staff, created_at FROM users ORDER BY created_at DESC LIMIT 100");
  return NextResponse.json({ users });
});
