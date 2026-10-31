import { NextResponse, type NextRequest } from "next/server";
import { getInvoiceByShareToken, lineItems } from "@/lib/invoices";

type Params = { params: Promise<{ token: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { token } = await params;
  const invoice = await getInvoiceByShareToken(token);
  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id, number, customer_name, currency, total_cents, status, due_at } = invoice;
  return NextResponse.json({ invoice: { id, number, customer_name, currency, total_cents, status, due_at }, items: await lineItems(id) });
}
