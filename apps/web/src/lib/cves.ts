/**
 * Words and links for the CVE directory, shared by its pages, their loading
 * states, the demo and the agent API.
 */
import type { AdvisorySeverity, CveListItem, CveMatch, CveState } from "@sandchest/db";
import { inCode } from "@sandchest/db";
import { fixedVersion, type AffectedPackage } from "@sandchest/engine/advisories";
import { githubLine } from "./format";

export const CVE_STATES: Array<{ id: CveState; label: string }> = [
  { id: "in_code", label: "In your code" },
  { id: "installed", label: "Installed" },
  { id: "resolved", label: "Resolved" },
];

export const CVE_SEVERITIES: AdvisorySeverity[] = ["critical", "high", "medium", "low", "unknown"];

export const CVE_SEVERITY_LABEL: Record<AdvisorySeverity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", unknown: "Unrated" };

/** How close an installed version is to shipped code, in a few words. */
export function evidence(match: Pick<CveMatch, "usage" | "dev" | "direct" | "approximate" | "ecosystem" | "resolvedAt">): string {
  if (match.resolvedAt) return "No longer installed";
  if (match.approximate) return "Allowed by a package.json range; no lockfile was read";
  if (match.dev) return match.usage === "product" ? "A dev dependency, though shipped code imports it" : "A dev dependency";
  switch (match.usage) {
    case "product":
      return "Imported by shipped code";
    case "tooling":
      return "Imported only by tests, config or tooling";
    case "none":
      return match.direct ? "Declared, but no code imports it" : "Installed by another package";
    default:
      return `Installed; ${match.ecosystem} imports aren't traced yet`;
  }
}

/** The line a list row shows under the summary: where the vulnerability is, most exposed match first. */
export function whereLine(item: CveListItem): { repo: string; text: string; site?: string; more: number } {
  const open = item.matches.filter((m) => m.resolvedAt === null);
  const shown = open.find(inCode) ?? open[0] ?? item.matches[0]!;
  const repos = new Set((open.length ? open : item.matches).map((m) => m.repoId));
  const site = inCode(shown) ? shown.importedAt[0] : undefined;
  return { repo: shown.repoFullName, text: `${shown.name}@${shown.version}`, site, more: repos.size - 1 };
}

/** A link to an import site, at the commit the inventory was read from (the default branch when unknown). */
export function siteLink(repoFullName: string, ref: string, site: string): { href: string; file: string; line: number } {
  const at = site.lastIndexOf(":");
  const file = at > 0 ? site.slice(0, at) : site;
  const line = at > 0 ? Number(site.slice(at + 1)) || 1 : 1;
  return { href: githubLine(repoFullName, ref, file, line), file, line };
}

/** The version that fixes an installed one, from the advisory's ranges. */
export function fixFor(affected: AffectedPackage[], match: Pick<CveMatch, "ecosystem" | "name" | "version">): string | undefined {
  return fixedVersion({ affected }, match.ecosystem, match.name, match.version);
}

/**
 * A prompt for a coding agent to upgrade every affected version in one
 * repository, and prove the old one is gone.
 */
export function upgradePrompt(input: { key: string; summary: string; repoFullName: string; matches: Array<CveMatch & { fixed?: string }> }): string {
  const lines = [
    `Upgrade the dependencies in ${input.repoFullName} that are affected by ${input.key}: ${input.summary}`,
    "",
    "Affected versions installed:",
    ...input.matches.map((m) => {
      const where = m.importedAt.length ? ` Imported at ${m.importedAt.slice(0, 5).join(", ")}.` : "";
      const fix = m.fixed ? `upgrade to ${m.fixed} or later` : "no fixed version is published yet: remove it or replace it";
      return `- ${m.ecosystem} ${m.name}@${m.version}, from ${m.manifest ?? "the lockfile"}: ${fix}.${where}`;
    }),
    "",
    "Steps:",
    "1. Upgrade each package with the project's own package manager, so the lockfile changes with it. If another package pins the affected version, upgrade that package, or add an override or resolution.",
    "2. Confirm the lockfile no longer resolves any affected version (for example `npm ls <name>`, `pnpm why <name>`, `bun pm ls`, `pip show`, `go list -m all`).",
    "3. Read the package's changelog between the two versions for breaking changes, and adapt the code that imports it.",
    "4. Run the build and the tests.",
  ];
  return lines.join("\n");
}

export type DetailBlock = { kind: "heading" | "paragraph" | "code"; text: string };

/**
 * Advisory text (GitHub-flavoured Markdown written by whoever filed it) as
 * headings, paragraphs and code blocks. Rendered as text, never as HTML.
 */
export function detailBlocks(markdown: string): DetailBlock[] {
  const blocks: DetailBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", text: heading[1]!.trim() });
      continue;
    }
    if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

/** OSV's page for an advisory. */
export function osvUrl(id: string): string {
  return `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
}

/** A reference's kind, in words. */
export const REFERENCE_LABEL: Record<string, string> = {
  ADVISORY: "Advisory",
  ARTICLE: "Article",
  DETECTION: "Detection",
  DISCUSSION: "Discussion",
  REPORT: "Report",
  FIX: "Fix",
  INTRODUCED: "Introduced",
  PACKAGE: "Package",
  EVIDENCE: "Evidence",
  WEB: "Link",
};
