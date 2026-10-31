import { query, queryOne } from "./db";
import type { Role, User } from "./types";

export const EDITABLE_PROFILE_FIELDS = ["name", "email", "avatar_url", "timezone"] as const;

export async function findByEmail(email: string): Promise<(User & { password_hash: string }) | null> {
  return queryOne<User & { password_hash: string }>("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
}

export async function updateProfile(userId: string, changes: Record<string, unknown>): Promise<User | null> {
  const columns = Object.keys(changes);
  if (columns.length === 0) return queryOne<User>("SELECT * FROM users WHERE id = $1", [userId]);
  const assignments = columns.map((column, i) => `"${column.replace(/"/g, "")}" = $${i + 2}`);
  return queryOne<User>(
    `UPDATE users SET ${assignments.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
    [userId, ...columns.map((column) => changes[column])],
  );
}

export async function membersOf(orgId: string): Promise<User[]> {
  return query<User>("SELECT id, email, name, role, org_id, is_staff, created_at FROM users WHERE org_id = $1 ORDER BY name", [orgId]);
}

export async function addMember(orgId: string, email: string, role: Role): Promise<User> {
  const existing = await findByEmail(email);
  if (existing) {
    const updated = await queryOne<User>("UPDATE users SET org_id = $2, role = $3 WHERE id = $1 RETURNING *", [existing.id, orgId, role]);
    return updated!;
  }
  const created = await queryOne<User>(
    "INSERT INTO users (email, name, role, org_id, password_hash) VALUES ($1, '', $2, $3, '') RETURNING *",
    [email, role, orgId],
  );
  return created!;
}
