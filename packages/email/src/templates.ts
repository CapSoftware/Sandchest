/**
 * Email templates as escaped HTML strings. Inline styles and tables only:
 * that is what email clients render reliably. Colours match the dashboard:
 * gold on near-black.
 */

const C = { void: "#0d0a07", seam: "#2c2219", sand: "#f3e5c8", bright: "#fff3dc", dust: "#a69479", gold: "#fec242", critical: "#ff5a36", high: "#d76839", medium: "#fea121" };
const FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

type Severity = "critical" | "high" | "medium" | "low";
const SEVERITY_COLOR: Record<Severity, string> = { critical: C.critical, high: C.high, medium: C.medium, low: C.dust };
const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export interface FindingSummary {
  title: string;
  severity: Severity;
  url: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Escapes text for HTML content and attribute values. */
function e(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(preview: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"></head>
<body style="margin:0;padding:0;background:${C.void}">
<div style="display:none;max-height:0;overflow:hidden">${e(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.void}" style="background:${C.void}"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${FONT};color:${C.sand};font-size:15px;line-height:1.6">
<tr><td style="padding-bottom:32px;color:${C.gold};font-size:18px;font-weight:700">Sandchest</td></tr>
<tr><td>${body}</td></tr>
<tr><td style="padding-top:24px;border-top:1px solid ${C.seam};color:${C.dust};font-size:12px">${e(FOOTER)}</td></tr>
</table></td></tr></table></body></html>`;
}

function heading(text: string): string {
  return `<p style="margin:0;color:${C.bright};font-size:22px;font-weight:700;line-height:1.3">${e(text)}</p>`;
}

function paragraph(text: string): string {
  return `<p style="margin:12px 0 0">${e(text)}</p>`;
}

function button(href: string, label: string): string {
  return `<a href="${e(href)}" style="display:inline-block;background:${C.gold};color:${C.void};padding:12px 20px;font-weight:600;text-decoration:none">${e(label)}</a>`;
}

function findingList(findings: FindingSummary[]): string {
  const rows = findings
    .map(
      (f) =>
        `<tr><td style="padding:14px 0;border-bottom:1px solid ${C.seam}"><span style="color:${SEVERITY_COLOR[f.severity]};font-weight:700">${SEVERITY_LABEL[f.severity]}</span>&nbsp;&nbsp;<a href="${e(f.url)}" style="color:${C.bright};text-decoration:none">${e(f.title)}</a></td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;border-top:1px solid ${C.seam}">${rows}</table>`;
}

function textList(findings: FindingSummary[]): string {
  return findings.map((f) => `${SEVERITY_LABEL[f.severity]}: ${f.title}\n${f.url}`).join("\n\n");
}

const FOOTER = "You get this because you can push to this repository. An admin can turn these emails off in Sandchest’s settings.";

/** New critical findings, from any scan. */
export function criticalFindingEmail(input: { repo: string; findings: FindingSummary[] }): RenderedEmail {
  const count = input.findings.length;
  const subject = count === 1 ? `Critical: ${input.findings[0]!.title}` : `${count} critical findings in ${input.repo}`;
  const lede =
    count === 1
      ? `Sandchest dug up a critical vulnerability in ${input.repo}. Fix it before it ships.`
      : `Sandchest dug up ${count} critical vulnerabilities in ${input.repo}. Fix them before they ship.`;
  const html = layout(lede, `${heading(count === 1 ? "Dug up 1 critical." : `Dug up ${count} criticals.`)}${paragraph(lede)}${findingList(input.findings)}${button(input.findings[0]!.url, "See the attack path")}`);
  return { subject, html, text: `${lede}\n\n${textList(input.findings)}\n\n${FOOTER}` };
}

/** A finished deep scan, with what it found. */
export function deepScanEmail(input: { repo: string; scanUrl: string; findings: FindingSummary[] }): RenderedEmail {
  const count = input.findings.length;
  const subject = count === 0 ? `Nothing buried in ${input.repo}` : `Deep scan of ${input.repo}: ${count} ${count === 1 ? "finding" : "findings"}`;
  const lede = count === 0 ? `The deep scan of ${input.repo} finished and found nothing exploitable. For now.` : `The deep scan of ${input.repo} finished. It found ${count === 1 ? "one way in" : `${count} ways in`}.`;
  const title = count === 0 ? "Nothing buried here." : `We found ${count} ${count === 1 ? "way" : "ways"} in.`;
  const list = count > 0 ? findingList(input.findings) : `<div style="height:24px"></div>`;
  const html = layout(lede, `${heading(title)}${paragraph(lede)}${list}${button(input.scanUrl, "Open the scan")}`);
  const text = `${lede}\n\n${count ? `${textList(input.findings)}\n\n` : ""}${input.scanUrl}\n\n${FOOTER}`;
  return { subject, html, text };
}
