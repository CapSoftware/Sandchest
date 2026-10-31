import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { record } from "@/lib/audit";
import { handle, HttpError, requireOrgRole, requireSession } from "@/lib/auth";
import { getInvoice, lineItems, updateInvoiceNotes, updateInvoiceStatus } from "@/lib/invoices";
import { dispatch } from "@/lib/webhooks";

type Params = { params: Promise<{ id: string }> };

export const GET = handle(async (request: NextRequest, { params }: Params) => {
  requireSession(request);
  const { id } = await params;
  const invoice = await getInvoice(id);
  if (!invoice) throw new HttpError(404, "Invoice not found");
  return NextResponse.json({ invoice, items: await lineItems(invoice.id) });
});

const Patch = z.object({
  status: z.enum(["draft", "sent", "paid", "void"]).optional(),
  notes: z.string().max(5_000).optional(),
});

export const PATCH = handle(async (request: NextRequest, { params }: Params) => {
  const session = requireSession(request);
  requireOrgRole(session, ["owner", "admin", "member"]);
  const { id } = await params;
  const parsed = Patch.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  let invoice = null;
  if (parsed.data.notes !== undefined) invoice = await updateInvoiceNotes(id, session.orgId, parsed.data.notes);
  if (parsed.data.status) invoice = await updateInvoiceStatus(id, session.orgId, parsed.data.status);
  if (!invoice) throw new HttpError(404, "Invoice not found");

  await record(session.orgId, session.userId, "invoice.update", id, parsed.data);
  if (parsed.data.status === "paid") await dispatch(session.orgId, "invoice.paid", { id });
  return NextResponse.json({ invoice });
});
