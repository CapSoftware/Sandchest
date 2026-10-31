import { query } from "./db";

export interface AuditEntry {
  id: string;
  org_id: string;
  actor_id: string;
  action: string;
  target: string;
  metadata: Record<string, unknown>;
  ip: string | null;
  created_at: string;
}

export async function record(orgId: string, actorId: string, action: string, target: string, metadata: Record<string, unknown> = {}, ip: string | null = null) {
  await query(
    "INSERT INTO audit_log (org_id, actor_id, action, target, metadata, ip) VALUES ($1, $2, $3, $4, $5, $6)",
    [orgId, actorId, action, target, metadata, ip],
  );
}

export async function recentEntries(filter: { orgId?: string; action?: string; limit: number }): Promise<AuditEntry[]> {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filter.orgId) {
    params.push(filter.orgId);
    conditions.push(`org_id = $${params.length}`);
  }
  if (filter.action) {
    params.push(filter.action);
    conditions.push(`action = $${params.length}`);
  }
  params.push(filter.limit);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return query<AuditEntry>(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
}
