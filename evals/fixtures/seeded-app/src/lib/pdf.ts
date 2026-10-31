import { exec, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Invoice, LineItem } from "./types";

const run = promisify(exec);
const runFile = promisify(execFile);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function invoiceHtml(invoice: Invoice, items: LineItem[]): string {
  const rows = items
    .map((item) => `<tr><td>${escapeHtml(item.description)}</td><td>${item.quantity}</td><td>${money(item.unit_cents, invoice.currency)}</td></tr>`)
    .join("");
  return `<!doctype html><html><body>
    <h1>Invoice ${escapeHtml(invoice.number)}</h1>
    <p>Bill to: ${escapeHtml(invoice.customer_name)} &lt;${escapeHtml(invoice.customer_email)}&gt;</p>
    <table>${rows}</table>
    <p>Total: ${money(invoice.total_cents, invoice.currency)}</p>
  </body></html>`;
}

export async function renderPdf(invoice: Invoice, items: LineItem[], fileName: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "invoice-"));
  try {
    const source = join(dir, "invoice.html");
    await writeFile(source, invoiceHtml(invoice, items));
    const output = join(dir, `${fileName}.pdf`);
    await run(`wkhtmltopdf --quiet --page-size A4 "${source}" "${output}"`, { timeout: 30_000 });
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function pageCount(pdfPath: string): Promise<number> {
  const { stdout } = await runFile("pdfinfo", [pdfPath], { timeout: 10_000 });
  const match = /^Pages:\s+(\d+)/m.exec(stdout);
  return match ? Number(match[1]) : 0;
}
