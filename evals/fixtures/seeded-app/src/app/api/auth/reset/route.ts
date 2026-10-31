import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { query } from "@/lib/db";
import { hashPassword } from "@/lib/passwords";
import { consumePasswordReset, createPasswordReset } from "@/lib/reset-tokens";
import { findByEmail } from "@/lib/users";

const RequestReset = z.object({ email: z.string().email() });
const CompleteReset = z.object({ token: z.string().length(32), password: z.string().min(12).max(200) });

export async function POST(request: NextRequest) {
  const parsed = RequestReset.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid email" }, { status: 400 });

  const user = await findByEmail(parsed.data.email);
  if (user) {
    const token = await createPasswordReset(user.id);
    await sendResetEmail(user.email, token);
  }
  return NextResponse.json({ ok: true });
}

export async function PUT(request: NextRequest) {
  const parsed = CompleteReset.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const userId = await consumePasswordReset(parsed.data.token);
  if (!userId) return NextResponse.json({ error: "Reset link expired" }, { status: 400 });
  await query("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, await hashPassword(parsed.data.password)]);
  return NextResponse.json({ ok: true });
}

async function sendResetEmail(to: string, token: string): Promise<void> {
  const link = `${process.env.APP_URL}/reset?token=${token}`;
  await fetch(`${process.env.MAILER_URL}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, template: "password-reset", data: { link } }),
  });
}
