import type { DashboardRepo, FindingListItem, findingForUser, OrgBillingRow, OrgTeam, Overview, scanForUser, ScanListItem, SettingsOrg } from "@sandchest/db";
import type { Severity } from "./format";
import type { PullRow } from "@/server/pulls";

/**
 * Made-up data for loading states. Each `loading.tsx` renders its page's own
 * view of these, and the skeleton is measured from that, so it has the
 * page's exact layout. Shaped like a typical account: a few repositories, a
 * screenful of findings and scans, ordinary lengths of text. Functions, not
 * constants, so every time is relative to now.
 */

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const ahead = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const none = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0 });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const SAMPLE_ORG_ID = id(1);

const REPOS: Array<[name: string, open: Partial<Record<Severity, number>>, reviews: number, privateRepo: boolean]> = [
  ["api", { critical: 1, high: 2, medium: 1 }, 24, true],
  ["web", { high: 1, medium: 3 }, 18, true],
  ["billing", { medium: 2, low: 1 }, 9, true],
  ["worker", { low: 1 }, 6, true],
  ["docs", {}, 3, false],
  ["mobile", {}, 11, true],
];

export function sampleRepos(): DashboardRepo[] {
  return REPOS.map(([name, open, reviews, privateRepo], i) => ({
    id: id(100 + i),
    fullName: `acme/${name}`,
    private: privateRepo,
    orgId: SAMPLE_ORG_ID,
    orgLogin: "acme",
    orgAdmin: true,
    billing: { planId: "standard", credits: 120, checkedAt: ago(5) },
    loc: 48_000 + i * 9_000,
    lastDeepScanAt: ago(60 * 24 * (i + 2)),
    open: { ...none(), ...open },
    lastScan: { id: id(300 + i), kind: "pr_review", status: "completed", at: ago(90 + i * 140) },
    reviews30d: reviews,
    activeDeepScanId: null,
    activeDeepScanWaitsForRecon: false,
    freeDig: false,
    defaultBranch: "main",
    prReviews: "auto",
    deepScanSchedule: i === 0 ? "weekly" : "off",
    nextDeepScanAt: i === 0 ? ahead(60 * 24 * 3) : null,
  }));
}

const FINDINGS: Array<[title: string, severity: Severity, repo: string, file: string]> = [
  ["Any signed-in user can read another account’s invoices", "critical", "api", "src/routes/invoices.ts:42"],
  ["Webhook signature is checked after the payload is parsed", "high", "api", "src/webhooks/handler.ts:118"],
  ["Password reset tokens never expire", "high", "web", "app/reset/actions.ts:31"],
  ["Admin export accepts any organisation id", "high", "api", "src/admin/export.ts:77"],
  ["Redirect target is taken from the query string", "medium", "web", "app/sign-in/page.tsx:27"],
  ["Uploaded file names reach the shell unescaped", "medium", "billing", "src/pdf/render.ts:64"],
  ["Session cookie is readable from scripts", "medium", "web", "lib/session.ts:19"],
  ["Rate limit keys on a header the client controls", "low", "worker", "src/limits.ts:12"],
];

export function sampleFindings(count = FINDINGS.length): FindingListItem[] {
  return FINDINGS.slice(0, count).map(([title, severity, repo, at], i) => {
    const [file, line] = at.split(":");
    return {
      id: id(200 + i),
      title,
      severity,
      confidence: "high",
      status: "open",
      category: "broken_access_control",
      repoId: id(100),
      repoFullName: `acme/${repo}`,
      sink: { file: file!, line: Number(line) },
      sourceKind: "deep",
      prNumber: null,
      lastSeenAt: ago(120 + i * 600),
      stale: false,
    };
  });
}

const SCANS: Array<[kind: string, pr: number | null, repo: string, found: Partial<Record<Severity, number>>, credits: number]> = [
  ["pr_review", 212, "web", {}, 1],
  ["deep", null, "api", { critical: 1, high: 2 }, 10],
  ["pr_review", 211, "api", { medium: 1 }, 1],
  ["pr_review", 87, "billing", {}, 1],
  ["fix_check", null, "api", {}, 0],
  ["pr_review", 210, "web", {}, 1],
  ["recon", null, "mobile", {}, 0],
  ["pr_review", 209, "worker", {}, 1],
  ["pr_review", 88, "billing", { high: 1 }, 1],
  ["pr_review", 208, "web", {}, 1],
];

export function sampleScans(count = SCANS.length): ScanListItem[] {
  return SCANS.slice(0, count).map(([kind, prNumber, repo, found, credits], i) => ({
    id: id(300 + i),
    kind,
    status: "completed",
    prNumber,
    repoId: id(100),
    repoFullName: `acme/${repo}`,
    createdAt: ago(45 + i * 170),
    finishedAt: ago(40 + i * 170),
    durationMs: kind === "deep" ? 1_260_000 : 95_000,
    credits,
    found: { ...none(), ...found },
  }));
}

/** Thirty days of an account in steady use. */
export function sampleOverview(days = 30): Overview {
  const today = Date.now();
  return {
    now: { pullRequests: 64, reviews: 71, deepScans: 3, found: 12, fixed: 7, credits: 96 },
    before: { pullRequests: 52, reviews: 58, deepScans: 2, found: 9, fixed: 5, credits: 80 },
    open: { critical: 1, high: 3, medium: 6, low: 2 },
    days: Array.from({ length: days }, (_, i) => ({
      day: new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
      reviews: (i * 7) % 5,
      deep: i % 11 === 3 ? 1 : 0,
      found: i % 4 === 1 ? 1 : 0,
      fixed: i % 6 === 2 ? 1 : 0,
    })),
  };
}

/** One finding, open, as its page reads it: a three-step path with excerpts, the kind of length a real one has. */
export function sampleFinding(): NonNullable<Awaited<ReturnType<typeof findingForUser>>> {
  return {
    finding: {
      id: id(200),
      repoId: id(100),
      fingerprint: "sample",
      status: "open",
      dismissReason: null,
      severity: "critical",
      confidence: "high",
      category: "broken_access_control",
      cwe: "CWE-639",
      title: "Any signed-in user can read another account’s invoices",
      impact: "An invoice id from any account returns that account’s invoice, with its line items and billing address, to whoever asks.",
      mitigations: "",
      entryPoint: { file: "src/routes/invoices.ts", line: 41, description: "GET /api/invoices/:id, the id path parameter" },
      attackPath: [
        { file: "src/routes/invoices.ts", line: 42, note: "The id from the URL is passed on without checking who owns it.", excerpt: "41| router.get(\"/api/invoices/:id\", requireSession, async (req, res) => {\n42|   const invoice = await getInvoice(req.params.id);\n43|   res.json(invoice);" },
        { file: "src/services/billing.ts", line: 88, note: "getInvoice looks the invoice up by id alone.", excerpt: "87| export async function getInvoice(id: string) {\n88|   return invoices.findById(id);\n89| }" },
        { file: "src/db/invoices.ts", line: 17, note: "The query returns the row whoever owns it.", excerpt: "16| findById(id: string) {\n17|   return db.select().from(invoices).where(eq(invoices.id, id));\n18| }" },
      ],
      attacker: "any_user",
      preconditions: "A signed-in account. Invoice ids are sequential, so they are easy to guess.",
      proofOfConcept: "curl -H 'cookie: session=<any account>' https://app.example.com/api/invoices/1042",
      fixGuidance: "Scope the lookup to the caller’s organisation: look the invoice up by id and organisation together, and return 404 when nothing matches.",
      guarantees: ["An invoice is only returned to members of the organisation that owns it.", "Everyone else gets a 404, not a 403, so ids can’t be probed."],
      mustNotBreak: ["Invoice downloads for the owning organisation.", "The admin billing export."],
      regressionTest: "Sign in as a member of another organisation, request an invoice it doesn’t own and expect a 404.",
      fixPrompt: "",
      trust: "confirmed",
      sources: [],
      validation: null,
      sourceScanId: id(301),
      sourceKind: "deep",
      prNumber: null,
      staleAt: null,
      firstSeenAt: ago(60 * 24 * 3),
      lastSeenAt: ago(120),
      fixedAt: null,
    },
    repo: { id: id(100), fullName: "acme/api", private: true, defaultBranch: "main" },
    history: [{ type: "seen", at: ago(60 * 24 * 3), login: null, scanId: id(301) }],
  };
}

const FEED = [
  "Cloning the repository",
  "Reading the recon map: 14 entry points, 6 sinks",
  "Following request handlers into the data layer",
  "Checking who can reach /api/invoices/:id",
  "Lead: invoice lookup takes the id from the URL",
  "Tracing getInvoice through the billing service",
  "Checking the session middleware on every route",
  "Webhook handler parses the body before the signature check",
  "Lead: redirect target comes from the query string",
  "Following file uploads into the PDF renderer",
  "Checking each path against its guards",
  "Skeptic: re-reading the invoice path from the entry point",
  "Skeptic: the webhook lead holds",
  "Skeptic: dropped one lead, the redirect is allow-listed",
  "Writing proofs of concept",
  "Writing fix guidance",
  "Finding: Any signed-in user can read another account’s invoices",
  "Finding: Webhook signature is checked after the payload is parsed",
  "Finding: Uploaded file names reach the shell unescaped",
  "Done: 3 findings",
];

/** A finished deep scan, as its page reads it: three findings and a full feed. */
export function sampleScan(): NonNullable<Awaited<ReturnType<typeof scanForUser>>> {
  const started = ago(60);
  return {
    scan: {
      id: id(301),
      repoId: id(100),
      orgId: SAMPLE_ORG_ID,
      kind: "deep",
      status: "completed",
      trigger: "manual",
      prNumber: null,
      headSha: "HEAD",
      baseSha: null,
      checkRunId: null,
      workflowRunId: null,
      credits: 10,
      leads: null,
      stats: { loc: 48_200 },
      error: null,
      notifiedAt: null,
      creditsReserved: 0,
      billing: "charged",
      createdAt: started,
      startedAt: started,
      finishedAt: ago(39),
    },
    repo: { id: id(100), fullName: "acme/api", private: true },
    org: { login: "acme", hacker: null },
    metrics: null,
    findings: sampleFindings(8)
      .filter((_, i) => i === 0 || i === 1 || i === 5)
      .map(({ id, title, severity, confidence, status, sink }) => ({ id, title, severity, confidence, status: status as "open", sink })),
    events: FEED.map((message, i) => ({ seq: i + 1, type: message.startsWith("Finding") ? "finding" : "step", message, createdAt: new Date(started.getTime() + i * 63_000) })),
  };
}

/** One account on the plan, with its repositories and team, as Settings reads it. */
export function sampleSettings(): { orgs: SettingsOrg[]; billing: OrgBillingRow; team: OrgTeam } {
  const billing: OrgBillingRow = {
    orgId: SAMPLE_ORG_ID,
    planId: "standard",
    pastDue: false,
    endsAt: null,
    renewsAt: ago(-60 * 24 * 20),
    nextPlanId: null,
    credits: 120,
    creditsResetAt: ago(-60 * 24 * 20),
    autoTopUp: null,
    activatedAt: ago(60 * 24 * 40),
    checkedAt: ago(5),
    creditLevel: 0,
    creditLevelAt: null,
    creditLevelRev: 0,
  };
  const org: SettingsOrg = {
    id: SAMPLE_ORG_ID,
    login: "acme",
    type: "Organization",
    installationId: 1,
    settings: { checkThreshold: "high", emailNotifications: true },
    admin: true,
    billing,
    repos: sampleRepos().map((repo) => ({ id: repo.id, fullName: repo.fullName, private: repo.private })),
  };
  const person = (n: number, login: string, kind: "github_admin" | "github" | "admin" | "member") => ({
    userId: `00000000-0000-4000-8000-00000000010${n}`,
    name: login[0]!.toUpperCase() + login.slice(1),
    login,
    image: null,
    admin: kind === "github_admin" || kind === "admin",
    githubAdmin: kind === "github_admin",
    member: kind === "admin" || kind === "member",
    role: kind === "admin" || kind === "member" ? kind : null,
    github: kind.startsWith("github"),
    joinedAt: kind === "admin" || kind === "member" ? ago(60 * 24 * 3) : null,
  });
  const team: OrgTeam = {
    people: [person(1, "you", "github_admin"), person(2, "rae", "admin"), person(3, "maya", "github"), person(4, "sam", "member")],
    invites: [{ id: "00000000-0000-4000-8000-000000000201", email: "jo@example.com", githubLogin: null, role: "member", invitedBy: "you", createdAt: ago(60 * 5), expiresAt: ago(-60 * 24 * 6) }],
  };
  return { orgs: [org], billing, team };
}

const PULLS: Array<[title: string, author: string, review: "completed" | "running" | "none" | "older", findings: number]> = [
  ["Let team admins export member lists", "maya", "completed", 1],
  ["Move session refresh to the edge", "sam", "running", 0],
  ["Bump the PDF renderer", "dependabot", "none", 0],
  ["Rate limit password resets", "jo", "older", 0],
  ["Add audit log retention setting", "maya", "completed", 0],
];

/** Open pull requests on a sample repo, each in a different review state. */
export function samplePulls(count = PULLS.length): PullRow[] {
  return PULLS.slice(0, count).map(([title, author, review, findings], i) => ({
    number: 212 - i * 3,
    title,
    author,
    url: "https://github.com/acme/api/pulls",
    draft: false,
    updatedAt: ago(30 + i * 95),
    headSha: `head${i}`,
    fork: false,
    review:
      review === "none"
        ? null
        : {
            scanId: id(400 + i),
            status: review === "older" ? "completed" : review,
            headSha: review === "older" ? `old${i}` : `head${i}`,
            credits: 1,
            trigger: "webhook",
            findings,
            at: ago(30 + i * 95),
            current: review !== "older",
          },
  }));
}

/** The sample repositories' ids by short name, for the CVE directory's samples. */
export function sampleRepoId(name: string): string {
  return id(100 + REPOS.findIndex(([repo]) => repo === name));
}
