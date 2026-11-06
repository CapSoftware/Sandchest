/**
 * The demo account's live feed, made up as it plays: pull request reviews
 * and deep scans running through their stages with lines of what the hacker
 * is looking at, the odd finding, fixes landing and new CVEs in the
 * dependencies. Everything invented; it runs for as long as the page is
 * open, holding nothing but the scans in flight.
 */
import type { FeedSource } from "@/components/hacker/account-live";
import { ACTIVE, jobOf, lineItem, scanItem, type FeedItem, type FeedJob } from "./account-feed";
import { DEMO_LOGIN, DEMO_ORG_ID } from "./demo";
import type { LiveScan } from "@sandchest/db";

const REPOS = ["api", "web", "billing", "worker", "mobile"].map((name, i) => ({ id: `00000000-0000-4000-8000-d${String(100 + i).padStart(11, "0")}`, name: `${DEMO_LOGIN}/${name}` }));

const STAGES: Record<"pr_review" | "deep", Array<[string, string]>> = {
  pr_review: [
    ["stage:setup", "Checking out the change…"],
    ["stage:index", "Indexing the files it touches and what calls them…"],
    ["stage:sweep", "Sweeping the diff for secrets and dangerous sinks…"],
    ["stage:hunt", "Hunting through the change with the threat model…"],
    ["stage:verify", "Proving the code path of what turned up…"],
    ["stage:done", "Writing the review…"],
  ],
  deep: [
    ["stage:setup", "Cloning at the default branch…"],
    ["stage:index", "Indexing the code…"],
    ["stage:sweep", "Sweeping for secrets, vulnerable dependencies and dangerous sinks…"],
    ["stage:recon", "Mapping the attack surface…"],
    ["stage:hunt", "Hunting across 6 areas…"],
    ["stage:verify", "Proving the code path of what we found…"],
    ["stage:done", "Writing the report…"],
  ],
};

const LOOKS = [
  "auth: following the session cookie through middleware.",
  "invoices: who can reach GET /api/invoices/:id?",
  "webhooks: is the signature checked before the body is parsed?",
  "admin: export checks for an admin, but not of which organisation.",
  "users: PATCH /api/users/me spreads the body into the update.",
  "uploads: the file name reaches a shell command.",
  "search: q goes into a raw query; is it parameterised?",
  "billing: refunds check the amount against the original charge.",
  "sessions: tokens rotate on sign-in and expire after 30 days.",
  "api: rate limits keyed on the account, not a header.",
  "mobile: the deep link handler trusts the host it's given.",
  "worker: jobs deserialize payloads from the queue as is.",
  "Skeptic: the raw SQL is parameterised; dropped.",
  "Indexed 412 files, 48k lines.",
  "3 leads: 1 reachable dependency advisory, 2 raw SQL sinks.",
];

const FINDINGS = [
  { title: "Any signed-in user can read another account’s invoices", severity: "high" },
  { title: "Admin export accepts any organisation id", severity: "high" },
  { title: "Shell command built from an uploaded file name", severity: "critical" },
  { title: "Webhook signature is checked after the payload is parsed", severity: "medium" },
  { title: "Open redirect after sign-in via the next parameter", severity: "low" },
];

const CVES = [
  { vuln: "CVE-2025-29927", name: "next", version: "14.2.3", summary: "Authorization bypass through the middleware subrequest header", severity: "critical" },
  { vuln: "CVE-2024-45296", name: "path-to-regexp", version: "0.1.7", summary: "Backtracking regular expressions cause a denial of service", severity: "high" },
  { vuln: "CVE-2024-21538", name: "cross-spawn", version: "7.0.3", summary: "Regular expression denial of service", severity: "high" },
  { vuln: "CVE-2025-27152", name: "axios", version: "1.7.9", summary: "Absolute URLs override baseURL, leaking credentials", severity: "medium" },
];

const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]!;
const between = (a: number, b: number) => a + Math.random() * (b - a);

/** The demo's feed: a few scans at a time, forever, at a pace worth watching. */
export function demoFeed(): FeedSource {
  return {
    open(_after, on) {
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const later = (ms: number, run: () => void) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          run();
        }, ms);
        timers.add(timer);
      };
      let n = 0;
      let line = 0;
      const running = new Map<string, { scan: LiveScan; types: string[]; last: string | null; found: number }>();

      const job = (scan: LiveScan) => {
        const r = running.get(scan.id);
        if (r) on.job(jobOf(scan, r.types, r.last, r.found));
      };
      const say = (item: FeedItem | null) => item && on.item(item);
      const run = (kind: "pr_review" | "deep") => {
        const repo = pick(REPOS);
        const now = new Date().toISOString();
        const scan: LiveScan = { id: `demo-${++n}`, orgId: DEMO_ORG_ID, repoId: repo.id, repo: repo.name, kind, status: "queued", prNumber: kind === "pr_review" ? 400 + Math.floor(Math.random() * 300) : null, createdAt: now, startedAt: null, finishedAt: null, found: null };
        running.set(scan.id, { scan, types: [], last: null, found: 0 });
        say(scanItem(scan, null));
        job(scan);
        const stages = STAGES[kind];
        let at = between(1500, 4000);
        later(at, () => {
          const was = scan.status;
          scan.status = "running";
          scan.startedAt = new Date().toISOString();
          say(scanItem(scan, was));
          job(scan);
        });
        for (const [type, text] of stages) {
          at += between(1200, 3000);
          const stageAt = at;
          later(stageAt, () => emitLine(scan, type, text));
          const looks = kind === "deep" ? 2 + Math.floor(Math.random() * 3) : Math.floor(Math.random() * 3);
          for (let i = 0; i < looks; i++) {
            at += between(1800, 4500);
            later(at, () => emitLine(scan, "progress", pick(LOOKS)));
          }
          if (type === "stage:verify" && Math.random() < (kind === "deep" ? 0.8 : 0.3)) {
            at += between(1500, 3000);
            later(at, () => emitLine(scan, "finding", pick(FINDINGS).title));
          }
        }
        at += between(1500, 3000);
        later(at, () => {
          const r = running.get(scan.id);
          const was = scan.status;
          scan.status = "completed";
          scan.finishedAt = new Date().toISOString();
          scan.found = r?.found ?? 0;
          say(scanItem(scan, was));
          running.delete(scan.id);
          on.job({ id: scan.id, gone: true });
        });
        return at;
      };
      const emitLine = (scan: LiveScan, type: string, message: string) => {
        if (!ACTIVE.has(scan.status)) return;
        const item = lineItem({ id: ++line, scanId: scan.id, type, message, at: new Date().toISOString() }, scan);
        on.item({ ...item, id: `demo:${line}`, href: undefined });
        const r = running.get(scan.id);
        if (!r) return;
        r.types.push(type);
        if (type === "finding") r.found++;
        if (!type.startsWith("stage:")) r.last = message;
        job(scan);
      };

      // Reviews come along every so often, a deep scan now and then, fixes and CVEs in between.
      const reviews = () => later(between(4000, 14000) + run("pr_review") * 0.3, reviews);
      const deeps = () => later(run("deep") + between(8000, 20000), deeps);
      const fixes = () =>
        later(between(20000, 50000), () => {
          const f = pick(FINDINGS);
          const repo = pick(REPOS);
          on.item({ id: `demo-fix:${++n}`, at: Date.now(), kind: "fixed", repoId: repo.id, repo: repo.name, text: f.title, severity: f.severity });
          fixes();
        });
      const cves = () =>
        later(between(30000, 70000), () => {
          const c = pick(CVES);
          const repo = pick(REPOS);
          on.item({ id: `demo-cve:${++n}`, at: Date.now(), kind: "cve", repoId: repo.id, repo: repo.name, text: `${c.vuln} in ${c.name} ${c.version}: ${c.summary}`, severity: c.severity });
          cves();
        });
      on.state("live");
      on.opening({ items: [], jobs: [] });
      reviews();
      later(2500, deeps);
      fixes();
      cves();
      return () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        running.clear();
      };
    },
  };
}

/** What the demo's feed shows the moment it opens: a short history, so it's never empty. */
export function demoOpening(): { items: FeedItem[]; jobs: FeedJob[] } {
  const now = Date.now();
  const items: FeedItem[] = [
    { id: "demo-h1", at: now - 4 * 60_000, kind: "done", repoId: REPOS[1]!.id, repo: REPOS[1]!.name, text: "Done: nothing exploitable", scan: { id: "demo-h1", kind: "pr_review", pr: 512 } },
    { id: "demo-h2", at: now - 11 * 60_000, kind: "finding", repoId: REPOS[0]!.id, repo: REPOS[0]!.name, text: "Any signed-in user can read another account’s invoices", severity: "high" },
    { id: "demo-h3", at: now - 26 * 60_000, kind: "cve", repoId: REPOS[0]!.id, repo: REPOS[0]!.name, text: "CVE-2024-45296 in path-to-regexp 0.1.7: Backtracking regular expressions cause a denial of service", severity: "high" },
    { id: "demo-h4", at: now - 48 * 60_000, kind: "fixed", repoId: REPOS[2]!.id, repo: REPOS[2]!.name, text: "Webhook signature is checked after the payload is parsed", severity: "medium" },
  ];
  return { items, jobs: [] };
}
