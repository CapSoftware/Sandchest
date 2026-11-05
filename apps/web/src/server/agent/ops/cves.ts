/** The CVE directory: known vulnerabilities in what the person's repositories install, and exactly where. */
import { ADVISORY_SEVERITIES, cveCoverage, cveForUser, dashboardCves, inCode, type CveListItem, type CveMatch } from "@sandchest/db";
import { z } from "zod";
import { evidence, fixFor, osvUrl, siteLink, upgradePrompt } from "@/lib/cves";
import { db } from "../../db";
import { ApiError } from "../errors";
import { int, operation, RepoRef } from "../operation";
import { resolveRepo } from "../resolve";
import { iso } from "../views";

const STATE = z.enum(["in_code", "installed", "resolved"]);
const SEVERITY = z.enum(ADVISORY_SEVERITIES);

function matchView(match: CveMatch, fixed: string | undefined) {
  const ref = match.commitSha ?? "HEAD";
  return {
    repo: match.repoFullName,
    package: { ecosystem: match.ecosystem, name: match.name, version: match.version, manifest: match.manifest },
    in_code: inCode(match),
    usage: match.usage,
    dev: match.dev,
    direct: match.direct,
    version_from_range: match.approximate,
    evidence: evidence(match),
    imported_at: match.importedAt.map((site) => ({ site, url: siteLink(match.repoFullName, ref, site).href })),
    fixed_in: fixed ?? null,
    first_seen_at: iso(match.firstSeenAt),
    resolved_at: iso(match.resolvedAt),
  };
}

function listView(item: CveListItem, appUrl: string) {
  return {
    id: item.key,
    advisory_ids: item.ids,
    aliases: item.primary.aliases,
    summary: item.primary.summary,
    severity: item.severity,
    cvss: item.primary.score,
    malicious: item.primary.malicious,
    state: item.state,
    new: item.fresh,
    published_at: iso(item.primary.publishedAt),
    first_seen_at: iso(item.firstSeenAt),
    matches: item.matches.map((match) => ({
      repo: match.repoFullName,
      package: `${match.name}@${match.version}`,
      ecosystem: match.ecosystem,
      in_code: inCode(match),
      evidence: evidence(match),
      imported_at: match.importedAt.slice(0, 3),
      resolved_at: iso(match.resolvedAt),
    })),
    url: `${appUrl}/dashboard/cves/${encodeURIComponent(item.key)}`,
  };
}

export const cveOps = [
  operation({
    name: "list_cves",
    title: "List CVEs in your code",
    description:
      'Known vulnerabilities (OSV advisories, so CVEs, GHSAs, PYSECs, Go and RustSec ids, and malicious packages) affecting a version your repositories install, one entry per vulnerability however many advisories describe it. State "in_code" (default): shipped code imports the affected version; "installed": installed but only a dev dependency, pulled in by another package, or imported only by tests and tooling; "resolved": the version is gone. Each match names the repository, package@version, lockfile and import sites. Pass `query` to ask whether a given CVE affects you: an empty answer means none of your repositories installs an affected version. Call get_cve for the advisory text, fixed versions and an upgrade prompt.',
    method: "GET",
    path: "/cves",
    input: z.object({
      state: STATE.optional().describe("Default in_code."),
      severity: z.union([SEVERITY, z.array(SEVERITY)]).optional(),
      repo: RepoRef.optional(),
      query: z.string().max(200).optional().describe("A CVE or advisory id, or part of a package name or summary."),
      limit: int(1, 500).optional().describe("At most this many (default 100)."),
    }),
    readOnly: true,
    async run(context, input) {
      const repo = input.repo ? (await resolveRepo(context, input.repo)).repo : undefined;
      const severities = input.severity === undefined ? undefined : Array.isArray(input.severity) ? input.severity : [input.severity];
      const [{ list, counts }, coverage] = await Promise.all([
        dashboardCves(db(), context.principal.userId, { state: input.state ?? "in_code", severities, repoId: repo?.id, query: input.query }),
        cveCoverage(db(), context.principal.userId),
      ]);
      return {
        cves: list.slice(0, input.limit ?? 100).map((item) => listView(item, context.appUrl)),
        counts,
        coverage: { repos: coverage.repos, repos_read: coverage.inventoried, last_full_check_at: iso(coverage.checkedAt) },
      };
    },
  }),

  operation({
    name: "get_cve",
    title: "Get a CVE",
    description:
      "One vulnerability by CVE id, advisory id or alias: the advisory (summary, details, severity, CVSS, references), and every place it is in your repositories: package@version, the lockfile it comes from, the files that import it with GitHub links, the version that fixes it, and `upgrade_prompts`, a ready-to-run prompt per repository for a coding agent. 404 when it affects nothing your repositories install.",
    method: "GET",
    path: "/cves/{id}",
    input: z.object({ id: z.string().min(3).max(80).regex(/^[A-Za-z][A-Za-z0-9._-]+$/).describe("A CVE id (CVE-2025-29927), an advisory id (GHSA-…, PYSEC-…, GO-…, MAL-…) or an alias.") }),
    readOnly: true,
    async run(context, input) {
      const row = await cveForUser(db(), context.principal.userId, input.id);
      if (!row) throw new ApiError(404, "not_found", `${input.id} doesn't affect a version any repository you can see installs.`);
      const { item, advisory, records } = row;
      const withFix = item.matches.map((match) => ({ ...match, fixed: fixFor(advisory.affected, match) }));
      const repos = [...new Set(withFix.filter((m) => m.resolvedAt === null).map((m) => m.repoFullName))];
      return {
        ...listView(item, context.appUrl),
        details: advisory.details,
        cvss_vector: advisory.vector,
        aliases: [...new Set(records.flatMap((r) => [r.id, ...r.aliases]))].filter((id) => id !== item.key),
        references: advisory.references,
        osv_url: osvUrl(advisory.id),
        matches: withFix.map((match) => matchView(match, match.fixed)),
        upgrade_prompts: repos.map((repo) => ({
          repo,
          prompt: upgradePrompt({ key: item.key, summary: advisory.summary, repoFullName: repo, matches: withFix.filter((m) => m.repoFullName === repo && m.resolvedAt === null) }),
        })),
      };
    },
  }),
];
