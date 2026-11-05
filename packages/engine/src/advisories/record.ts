/**
 * An OSV record (https://ossf.github.io/osv-schema/), reduced to what the
 * CVE directory stores and shows. Advisory text is public data, never code.
 */
import { cvss3Score, scoreSeverity } from "./cvss";

export type AdvisorySeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

export interface OsvRecord {
  id: string;
  modified: string;
  published?: string;
  withdrawn?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: Array<{ type: string; score: string }>;
  affected?: Array<{
    package?: { ecosystem?: string; name?: string };
    severity?: Array<{ type: string; score: string }>;
    ranges?: Array<{ type?: string; repo?: string; events?: OsvEvent[] }>;
    database_specific?: { severity?: string };
  }>;
  references?: Array<{ type?: string; url?: string }>;
  database_specific?: { severity?: string };
}

export interface AffectedRange {
  introduced?: string;
  fixed?: string;
  lastAffected?: string;
}

export interface AffectedPackage {
  ecosystem: string;
  name: string;
  ranges: AffectedRange[];
}

export interface AdvisoryRecord {
  id: string;
  /** Other ids for the same vulnerability, CVE ids first. */
  aliases: string[];
  summary: string;
  details: string;
  severity: AdvisorySeverity;
  /** CVSS 3 base score, when the record carries a vector. */
  score: number | null;
  vector: string | null;
  /** A malicious package (OSV `MAL-` ids): installing it at all is the compromise. */
  malicious: boolean;
  affected: AffectedPackage[];
  references: Array<{ type: string; url: string }>;
  publishedAt: string | null;
  modifiedAt: string;
  withdrawnAt: string | null;
}

const MAX_SUMMARY = 300;
const MAX_DETAILS = 20_000;
const MAX_REFERENCES = 30;
const MAX_PACKAGES = 50;
const MAX_RANGES = 20;

export function toAdvisoryRecord(osv: OsvRecord): AdvisoryRecord {
  const vector = [...(osv.severity ?? []), ...(osv.affected ?? []).flatMap((a) => a.severity ?? [])].find((s) => s.type === "CVSS_V3")?.score ?? null;
  const score = vector ? cvss3Score(vector) : null;
  const malicious = osv.id.startsWith("MAL-");
  const details = (osv.details ?? "").trim();
  const firstLine = details.split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? "";
  const summary = (osv.summary?.trim() || firstLine || (malicious ? "Malicious package" : osv.id)).slice(0, MAX_SUMMARY);
  return {
    id: osv.id,
    aliases: [...new Set(osv.aliases ?? [])].sort((a, b) => Number(!a.startsWith("CVE-")) - Number(!b.startsWith("CVE-")) || a.localeCompare(b)),
    summary,
    details: details.length > MAX_DETAILS ? `${details.slice(0, MAX_DETAILS)}…` : details,
    severity: severityOf(osv, score, malicious),
    score,
    vector,
    malicious,
    affected: (osv.affected ?? [])
      .filter((a) => a.package?.name && a.package.ecosystem)
      .slice(0, MAX_PACKAGES)
      .map((a) => ({
        ecosystem: a.package!.ecosystem!,
        name: a.package!.name!,
        ranges: (a.ranges ?? [])
          .filter((r) => r.type !== "GIT")
          .flatMap((r) => toRanges(r.events ?? []))
          .slice(0, MAX_RANGES),
      })),
    references: (osv.references ?? [])
      .filter((r): r is { type?: string; url: string } => typeof r.url === "string" && /^https?:\/\//i.test(r.url))
      .slice(0, MAX_REFERENCES)
      .map((r) => ({ type: r.type ?? "WEB", url: r.url })),
    publishedAt: osv.published ?? null,
    modifiedAt: osv.modified,
    withdrawnAt: osv.withdrawn ?? null,
  };
}

/** A range's events as `introduced → fixed` pairs. */
function toRanges(events: OsvEvent[]): AffectedRange[] {
  const ranges: AffectedRange[] = [];
  let open: AffectedRange | undefined;
  for (const event of events) {
    if (event.introduced !== undefined) {
      if (open) ranges.push(open);
      open = { introduced: event.introduced };
    } else if (event.fixed !== undefined || event.last_affected !== undefined) {
      const range = open ?? {};
      if (event.fixed !== undefined) range.fixed = event.fixed;
      if (event.last_affected !== undefined) range.lastAffected = event.last_affected;
      ranges.push(range);
      open = undefined;
    }
  }
  if (open) ranges.push(open);
  return ranges;
}

const LABELS: Record<string, AdvisorySeverity> = { CRITICAL: "critical", HIGH: "high", MODERATE: "medium", MEDIUM: "medium", LOW: "low" };

/**
 * The advisory's own rating (GitHub's label), else the one its CVSS vector
 * gives. A malicious package is critical: the install itself is the attack.
 */
function severityOf(osv: OsvRecord, score: number | null, malicious: boolean): AdvisorySeverity {
  if (malicious) return "critical";
  const label = osv.database_specific?.severity ?? osv.affected?.find((a) => a.database_specific?.severity)?.database_specific?.severity;
  const named = label ? LABELS[label.toUpperCase()] : undefined;
  if (named) return named;
  if (score === null) return "unknown";
  const rated = scoreSeverity(score);
  return rated === "none" ? "low" : rated;
}

/**
 * The fix to suggest for an installed version: the end of the range it falls
 * in (advisories list one range per release line), else the first fix listed.
 */
export function fixedVersion(advisory: Pick<AdvisoryRecord, "affected">, ecosystem: string, name: string, installed: string): string | undefined {
  const key = packageKey(ecosystem, name);
  const ranges = advisory.affected.filter((a) => a.ecosystem === ecosystem && packageKey(a.ecosystem, a.name) === key).flatMap((a) => a.ranges);
  const inRange = ranges.find((r) => r.fixed && (r.introduced === undefined || compareVersions(installed, r.introduced) >= 0) && compareVersions(installed, r.fixed) < 0);
  return inRange?.fixed ?? ranges.find((r) => r.fixed)?.fixed;
}

/** Compares dotted numeric versions, ignoring pre-release tags: enough to pick a range to display, never to decide a match. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.+-]/).map((p) => Number.parseInt(p, 10)).map((n) => (Number.isNaN(n) ? 0 : n));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * How a package name is compared across inventories and advisories: PyPI by
 * its normalised name (PEP 503), everything else case-insensitively.
 */
export function packageKey(ecosystem: string, name: string): string {
  const lower = name.trim().toLowerCase();
  if (ecosystem === "PyPI") return lower.replace(/[-_.]+/g, "-");
  if (ecosystem === "GIT") return lower.replace(/\/+$/, "").replace(/\.git$/, "");
  return lower;
}

/**
 * The names an OSV record affects in one ecosystem: its packages, or for `GIT`, the repositories its commit
 * ranges are in.
 */
export function affectedNames(osv: OsvRecord, ecosystem: string): string[] {
  return (osv.affected ?? []).flatMap((a) =>
    ecosystem === "GIT" ? (a.ranges ?? []).flatMap((r) => (r.type === "GIT" && r.repo ? [r.repo] : [])) : a.package?.ecosystem === ecosystem && a.package.name ? [a.package.name] : [],
  );
}
