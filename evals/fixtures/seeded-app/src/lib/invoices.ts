import { query, queryOne, transaction } from "./db";
import type { Invoice, InvoiceStatus, LineItem } from "./types";

const STATUSES: InvoiceStatus[] = ["draft", "sent", "paid", "void"];

export interface ListOptions {
  status?: string;
  sort?: string;
  direction?: string;
  limit?: number;
  offset?: number;
}

export async function listInvoices(orgId: string, options: ListOptions = {}): Promise<Invoice[]> {
  const params: unknown[] = [orgId];
  let where = "org_id = $1";
  if (options.status && STATUSES.includes(options.status as InvoiceStatus)) {
    params.push(options.status);
    where += ` AND status = $${params.length}`;
  }
  const sort = options.sort ?? "created_at";
  const direction = options.direction === "asc" ? "ASC" : "DESC";
  params.push(Math.min(options.limit ?? 50, 200), options.offset ?? 0);
  return query<Invoice>(
    `SELECT * FROM invoices WHERE ${where} ORDER BY ${sort} ${direction} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
}

export async function searchInvoices(orgId: string, term: string): Promise<Invoice[]> {
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return query<Invoice>(
    `SELECT * FROM invoices
      WHERE org_id = $1 AND (customer_name ILIKE $2 OR number ILIKE $2)
      ORDER BY created_at DESC
      LIMIT 25`,
    [orgId, pattern],
  );
}

export async function getInvoice(id: string): Promise<Invoice | null> {
  return queryOne<Invoice>("SELECT * FROM invoices WHERE id = $1", [id]);
}

export async function getInvoiceForOrg(id: string, orgId: string): Promise<Invoice | null> {
  return queryOne<Invoice>("SELECT * FROM invoices WHERE id = $1 AND org_id = $2", [id, orgId]);
}

export async function getInvoiceByShareToken(token: string): Promise<Invoice | null> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  return queryOne<Invoice>("SELECT * FROM invoices WHERE share_token = $1 AND status <> 'draft'", [token]);
}

export async function lineItems(invoiceId: string): Promise<LineItem[]> {
  return query<LineItem>("SELECT * FROM line_items WHERE invoice_id = $1 ORDER BY id", [invoiceId]);
}

export interface NewInvoice {
  customerName: string;
  customerEmail: string;
  currency: string;
  dueAt: string | null;
  notes: string | null;
  items: Array<{ description: string; quantity: number; unitCents: number }>;
}

export async function createInvoice(orgId: string, input: NewInvoice, shareToken: string): Promise<Invoice> {
  return transaction(async (run) => {
    const [{ next }] = await run<{ next: number }>(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM invoices WHERE org_id = $1",
      [orgId],
    );
    const total = input.items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0);
    const [invoice] = await run<Invoice>(
      `INSERT INTO invoices (org_id, seq, number, customer_name, customer_email, currency, total_cents, notes, due_at, share_token, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')
       RETURNING *`,
      [orgId, next, `INV-${String(next).padStart(5, "0")}`, input.customerName, input.customerEmail, input.currency, total, input.notes, input.dueAt, shareToken],
    );
    for (const item of input.items) {
      await run(
        "INSERT INTO line_items (invoice_id, description, quantity, unit_cents) VALUES ($1, $2, $3, $4)",
        [invoice!.id, item.description, item.quantity, item.unitCents],
      );
    }
    return invoice!;
  });
}

export async function updateInvoiceStatus(id: string, orgId: string, status: InvoiceStatus): Promise<Invoice | null> {
  return queryOne<Invoice>(
    "UPDATE invoices SET status = $3, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *",
    [id, orgId, status],
  );
}

export async function updateInvoiceNotes(id: string, orgId: string, notes: string): Promise<Invoice | null> {
  return queryOne<Invoice>("UPDATE invoices SET notes = $3, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *", [id, orgId, notes]);
}
