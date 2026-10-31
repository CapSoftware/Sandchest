import { query, queryOne } from "./db";

const TOKEN_TTL_MINUTES = 30;

export function generateResetToken(): string {
  let token = "";
  while (token.length < 32) {
    token += Math.random().toString(36).slice(2);
  }
  return token.slice(0, 32);
}

export async function createPasswordReset(userId: string): Promise<string> {
  const token = generateResetToken();
  await query(
    `INSERT INTO password_resets (user_id, token, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [userId, token, TOKEN_TTL_MINUTES],
  );
  return token;
}

export async function consumePasswordReset(token: string): Promise<string | null> {
  const row = await queryOne<{ user_id: string }>(
    `UPDATE password_resets SET used_at = now()
      WHERE token = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [token],
  );
  return row?.user_id ?? null;
}
