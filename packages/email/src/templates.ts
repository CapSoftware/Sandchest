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

function layout(preview: string, body: string, footer = FOOTER): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"></head>
<body style="margin:0;padding:0;background:${C.void}">
<div style="display:none;max-height:0;overflow:hidden">${e(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.void}" style="background:${C.void}"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${FONT};color:${C.sand};font-size:15px;line-height:1.6">
<tr><td style="padding-bottom:32px;color:${C.gold};font-size:18px;font-weight:700">Sandchest</td></tr>
<tr><td style="padding-bottom:32px">${body}</td></tr>
<tr><td style="padding-top:24px;border-top:1px solid ${C.seam};color:${C.dust};font-size:12px">${e(footer)}</td></tr>
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
      ? `Sandchest found a critical vulnerability in ${input.repo}. Fix it before it ships.`
      : `Sandchest found ${count} critical vulnerabilities in ${input.repo}. Fix them before they ship.`;
  const html = layout(lede, `${heading(count === 1 ? "Found 1 critical." : `Found ${count} criticals.`)}${paragraph(lede)}${findingList(input.findings)}${button(input.findings[0]!.url, "See the attack path")}`);
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

// ---- Billing and operational emails ------------------------------------------
// These go to an org's admins: the people who can change its billing.

/** One figure, large, with a quiet label under it. */
function stat(value: number, label: string): string {
  return `<p style="margin:24px 0 0;color:${C.gold};font-size:40px;font-weight:700;line-height:1">${e(value.toLocaleString("en-US"))}</p><p style="margin:6px 0 0;color:${C.dust};font-size:12px">${e(label)}</p>`;
}

const credits = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "credit" : "credits"}`;

function adminFooter(org: string, canTurnOff: boolean): string {
  return canTurnOff
    ? `You get this because you’re an admin of ${org} on Sandchest. An admin can turn these emails off in Sandchest’s settings.`
    : `You get this because you’re an admin of ${org} on Sandchest. Billing emails always go to admins: they’re how you hear before reviews stop.`;
}

function render(input: {
  subject: string;
  title: string;
  paragraphs: string[];
  stat?: { value: number; label: string };
  button: { url: string; label: string };
  footer: string;
}): RenderedEmail {
  const figure = input.stat ? stat(input.stat.value, input.stat.label) : "";
  const body = `${heading(input.title)}${input.paragraphs.map(paragraph).join("")}${figure}<div style="height:28px"></div>${button(input.button.url, input.button.label)}`;
  const text = `${input.paragraphs.join("\n\n")}\n\n${input.button.label}: ${input.button.url}\n\n${input.footer}`;
  return { subject: input.subject, html: layout(input.paragraphs[0]!, body, input.footer), text };
}

export interface CreditsInput {
  /** The GitHub account the plan belongs to. */
  org: string;
  /** The plan's name, e.g. "Lockbox". */
  plan: string;
  credits: number;
  /** When the plan's monthly credits come back, already formatted, if known. */
  resetsOn: string | null;
  billingUrl: string;
}

/** Credits fell below the plan's low line. Sent only while auto top-up is off. */
export function creditsLowEmail(input: CreditsInput): RenderedEmail {
  return render({
    subject: `${credits(input.credits)} left on ${input.org}`,
    title: "The chest is running low.",
    paragraphs: [
      `${input.org} is down to ${credits(input.credits)} on ${input.plan}. When they run out, pull requests get a neutral Check instead of a review, and deep scans won’t start.`,
      `Top up now, or turn on auto top-up so reviews never stop.${input.resetsOn ? ` The plan’s monthly credits come back on ${input.resetsOn}.` : ""}`,
    ],
    stat: { value: input.credits, label: `${input.credits === 1 ? "credit" : "credits"} left` },
    button: { url: input.billingUrl, label: "Top up" },
    footer: adminFooter(input.org, false),
  });
}

/** Nothing left: every paid scan is refused until credits come back. Sent only while auto top-up is off. */
export function creditsExhaustedEmail(input: Omit<CreditsInput, "credits">): RenderedEmail {
  return render({
    subject: `Out of credits on ${input.org}`,
    title: "The chest is empty.",
    paragraphs: [
      `${input.org} has used every credit on ${input.plan}. Until it has more, pull requests get a neutral Check instead of a review, and deep scans won’t start.`,
      `Top up to keep scanning, or turn on auto top-up${input.resetsOn ? `. The plan’s monthly credits come back on ${input.resetsOn}` : ""}.`,
    ],
    button: { url: input.billingUrl, label: "Top up" },
    footer: adminFooter(input.org, false),
  });
}

/** Auto top-up bought credits. `charged` is already formatted, e.g. "$10.00". */
export function autoTopUpSucceededEmail(input: { org: string; added: number; charged: string; credits: number; billingUrl: string }): RenderedEmail {
  return render({
    subject: `Auto top-up: ${credits(input.added)} added to ${input.org}`,
    title: "Topped up.",
    paragraphs: [
      `${input.org} ran low, so auto top-up bought ${credits(input.added)} for ${input.charged}. Reviews keep running.`,
      "Change its monthly limit or turn it off in billing.",
    ],
    stat: { value: input.credits, label: `${input.credits === 1 ? "credit" : "credits"} now` },
    button: { url: input.billingUrl, label: "Manage billing" },
    footer: adminFooter(input.org, false),
  });
}

/** Auto top-up could not buy credits: the card failed, or the monthly limit is used up. `credits` is the balance then, if known. */
export function autoTopUpFailedEmail(input: { org: string; reason: "card" | "limit"; credits: number | null; billingUrl: string }): RenderedEmail {
  const left = input.credits === null ? "low on credits" : `down to ${credits(input.credits)}`;
  const card = input.reason === "card";
  return render({
    subject: card ? `Auto top-up failed for ${input.org}` : `Auto top-up hit its monthly limit on ${input.org}`,
    title: card ? "The top-up didn’t go through." : "Auto top-up hit its limit.",
    paragraphs: card
      ? [`${input.org} is ${left}, and auto top-up couldn’t charge the card on file.`, "Update the card so reviews don’t stop when the credits run out."]
      : [`${input.org} is ${left}, and auto top-up has already bought as many top-ups this month as its limit allows.`, "Top up now or raise the limit, or pull request reviews stop when the credits run out."],
    button: { url: input.billingUrl, label: card ? "Manage billing" : "Top up" },
    footer: adminFooter(input.org, false),
  });
}

/** A scan stopped because the model provider refused for quota. Nothing was charged for it. */
export function scanPausedEmail(input: { org: string; repo: string; kind: "recon" | "pr_review" | "deep"; prNumber: number | null; scanUrl: string }): RenderedEmail {
  const what =
    input.kind === "deep"
      ? `The deep scan of ${input.repo}`
      : input.kind === "pr_review"
        ? `The review of pull request #${input.prNumber ?? "?"} in ${input.repo}`
        : `Mapping ${input.repo}`;
  const next =
    input.kind === "deep"
      ? "Scan again in a little while."
      : input.kind === "pr_review"
        ? "Its Check says the review couldn’t finish, which doesn’t block merging. Push a new commit to review it once this clears."
        : "It runs again with the repository’s next deep scan or pull request review.";
  return render({
    subject: `Scan paused: ${input.repo}`,
    title: "Scans paused.",
    paragraphs: [
      `${what} stopped: the model provider hit its usage limit. Nothing was charged for it.`,
      next,
      "If more scans on this account stop for the same reason within the hour, they won’t each get an email.",
    ],
    button: { url: input.scanUrl, label: "See the scan" },
    footer: adminFooter(input.org, true),
  });
}
