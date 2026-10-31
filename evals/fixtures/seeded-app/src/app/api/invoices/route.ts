import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { record } from "@/lib/audit";
import { handle, requireOrgRole, requireSession } from "@/lib/auth";
import { createInvoice, listInvoices, searchInvoices } from "@/lib/invoices";
import { dispatch } from "@/lib/webhooks";

export const GET = handle(async (request: NextRequest) => {
  const session = requireSession(request);
  const params = request.nextUrl.searchParams;
  const term = params.get("q");
  if (term) {
    return NextResponse.json({ invoices: await searchInvoices(session.orgId, term) });
  }
  const invoices = await listInvoices(session.orgId, {
    status: params.get("status") ?? undefined,
    sort: params.get("sort") ?? undefined,
    direction: params.get("direction") ?? undefined,
    limit: Number(params.get("limit") ?? 50),
    offset: Number(params.get("offset") ?? 0),
  });
  return NextResponse.json({ invoices });
});

const NewInvoice = z.object({
  customerName: z.string().min(1).max(200),
  customerEmail: z.string().email(),
  currency: z.enum(["USD", "EUR", "GBP"]),
  dueAt: z.string().datetime().nullable(),
  notes: z.string().max(5_000).nullable(),
  items: z
    .array(z.object({ description: z.string().min(1).max(500), quantity: z.number().int().positive(), unitCents: z.number().int().nonnegative() }))
    .min(1)
    .max(100),
});

export const POST = handle(async (request: NextRequest) => {
  const session = requireSession(request);
  requireOrgRole(session, ["owner", "admin", "member"]);
  const parsed = NewInvoice.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const invoice = await createInvoice(session.orgId, parsed.data, randomBytes(24).toString("base64url"));
  await record(session.orgId, session.userId, "invoice.create", invoice.id);
  await dispatch(session.orgId, "invoice.created", { id: invoice.id, number: invoice.number });
  return NextResponse.json({ invoice }, { status: 201 });
});
