import { notFound, redirect } from "next/navigation";
import { getInvoiceForOrg, lineItems } from "@/lib/invoices";
import { currentSession } from "@/lib/session";

function formatMoney(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function renderNotes(notes: string): string {
  return notes
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br/>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`)
    .join("");
}

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const invoice = await getInvoiceForOrg(id, session.orgId);
  if (!invoice) notFound();
  const items = await lineItems(invoice.id);

  return (
    <article>
      <h1>Invoice {invoice.number}</h1>
      <p>
        {invoice.customer_name} · {invoice.customer_email} · {invoice.status}
      </p>
      <table>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.description}</td>
              <td>{item.quantity}</td>
              <td>{formatMoney(item.unit_cents, invoice.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Total: {formatMoney(invoice.total_cents, invoice.currency)}</p>
      {invoice.notes && <section className="notes" dangerouslySetInnerHTML={{ __html: renderNotes(invoice.notes) }} />}
      <a href={`/api/invoices/${invoice.id}/pdf`}>Download PDF</a>
    </article>
  );
}
