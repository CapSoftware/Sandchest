/** Words and numbers the dashboard shows. Server-side only: no locale or clock differences reach the browser. */
import { CREDIT_PACK } from "@sandchest/billing/plans";

export type Severity = "critical" | "high" | "medium" | "low";
export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export const SCAN_KIND_LABEL: Record<string, string> = {
  recon: "Recon",
  pr_review: "PR review",
  deep: "Deep scan",
  fix_check: "Fix check",
};

export const SCAN_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Scanning",
  publishing: "Publishing",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  refused: "Refused",
};

export const ATTACKER_LABEL: Record<string, string> = {
  unauthenticated: "Anyone on the internet",
  any_user: "Any signed-in user",
  insider: "An insider",
  admin: "An admin",
};

export const DISMISS_REASON_LABEL: Record<string, string> = {
  false_positive: "False positive",
  accepted_risk: "Accepted risk",
  wont_fix: "Won’t fix",
};

const CATEGORY_LABEL: Record<string, string> = {
  sql_injection: "SQL injection",
  nosql_injection: "NoSQL injection",
  ssrf: "Server-side request forgery",
  xss: "Cross-site scripting",
  xxe: "XML external entities",
  csrf: "Cross-site request forgery",
  open_redirect: "Open redirect",
};

export function categoryLabel(category: string): string {
  if (CATEGORY_LABEL[category]) return CATEGORY_LABEL[category];
  const words = category.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });

/** "3 hr. ago", "yesterday", "just now". */
export function timeAgo(date: Date, now = Date.now()): string {
  const diff = date.getTime() - now;
  if (Math.abs(diff) < 60_000) return "just now";
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return relative.format(Math.round(diff / ms), unit);
  }
  return "just now";
}

/** "in 6 hr." */
export function timeUntil(date: Date, now = Date.now()): string {
  const diff = date.getTime() - now;
  if (diff < 60_000) return "in a minute";
  for (const [unit, ms] of UNITS) {
    if (diff >= ms) return relative.format(Math.ceil(diff / ms), unit);
  }
  return "in a minute";
}

const absolute = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function fullDate(date: Date): string {
  return `${absolute.format(date)} UTC`;
}

/** "2 min 14 s", "48 s". */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** A GitHub link to a line on the default branch. Lines drift as code changes; good enough to jump there. */
export function githubLine(repo: string, ref: string, file: string, line: number): string {
  return `https://github.com/${repo}/blob/${encodeURIComponent(ref)}/${file.split("/").map(encodeURIComponent).join("/")}#L${line}`;
}

const SHORT_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "1 Dec 2026". */
export function shortDate(date: Date): string {
  return SHORT_DATE.format(date);
}

/** A number of credits: grouped ("2,500") when credits are sold by the 100 and run to five figures, else as it is. */
export function creditCount(count: number): string {
  return CREDIT_PACK > 1 ? count.toLocaleString("en-US") : String(count);
}

/** "1 credit", "3 credits", "2,500 credits". */
export function creditsText(count: number): string {
  return `${creditCount(count)} ${count === 1 ? "credit" : "credits"}`;
}

/** Hundredths of a credit, as a usage bill shows them: "4.27", or "1,204.50" where credits are grouped. */
export function creditHundredths(hundredths: number): string {
  return `${creditCount(Math.floor(hundredths / 100))}.${String(hundredths % 100).padStart(2, "0")}`;
}

/** "$20" or "$12.50". */
export function usd(amount: number): string {
  return `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "5 Oct", from a UTC date ("2026-10-05"). */
export function dayMonth(day: string): string {
  return DAY_MONTH.format(new Date(`${day}T00:00:00Z`));
}

/** An address shown to whoever holds a link, not spelled out in full: "j•••@example.com". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}
