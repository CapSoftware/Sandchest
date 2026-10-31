import { NextResponse, type NextRequest } from "next/server";
import { handle, HttpError, requireSession } from "@/lib/auth";
import { getInvoiceForOrg, lineItems } from "@/lib/invoices";
import { renderPdf } from "@/lib/pdf";

type Params = { params: Promise<{ id: string }> };

export const GET = handle(async (request: NextRequest, { params }: Params) => {
  const session = requireSession(request);
  const { id } = await params;
  const invoice = await getInvoiceForOrg(id, session.orgId);
  if (!invoice) throw new HttpError(404, "Invoice not found");

  const fileName = request.nextUrl.searchParams.get("filename") ?? invoice.number;
  const pdf = await renderPdf(invoice, await lineItems(invoice.id), fileName);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${encodeURIComponent(fileName)}.pdf"`,
    },
  });
});
