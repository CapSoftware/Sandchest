import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { record } from "@/lib/audit";
import { verifyPassword } from "@/lib/passwords";
import { sessionCookie } from "@/lib/session";
import { findByEmail } from "@/lib/users";

const LoginForm = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const parsed = LoginForm.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 400 });
  }

  const user = await findByEmail(parsed.data.email);
  if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  await record(user.org_id, user.id, "user.login", user.id, {}, request.headers.get("x-forwarded-for"));
  const next = request.nextUrl.searchParams.get("next") ?? "/invoices";
  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(sessionCookie({ userId: user.id, orgId: user.org_id, role: user.role, staff: user.is_staff, issuedAt: Date.now() }));
  return response;
}
