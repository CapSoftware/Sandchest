/**
 * Fills a local database with a fictional org, repos, scans and findings,
 * plus a signed-in user, so the dashboard can be worked on without GitHub.
 * Prints a session cookie to paste into the browser.
 *
 *   DATABASE_URL=postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest \
 *   BETTER_AUTH_SECRET=<32+ chars> bun scripts/seed-dev.ts
 *
 * Refuses to run against anything but localhost. Every name here is made up.
 */
import { createHmac, randomBytes } from "node:crypto";
import { createDb, schema, upsertFindings, upsertInstallation, upsertRepos, type FindingInput } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";

const url = process.env.DATABASE_URL ?? "";
const secret = process.env.BETTER_AUTH_SECRET ?? "";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("seed-dev only runs against a local DATABASE_URL");
if (secret.length < 32) throw new Error("Set BETTER_AUTH_SECRET (32+ characters), the same one the dev server uses");

const db = createDb(url, { max: 2 });
await migrate(db);

const { org, repos } = await upsertInstallation(db, 900_001, { githubAccountId: 900_001, githubLogin: "acme", type: "Organization" }, [
  { githubRepoId: 900_101, fullName: "acme/billing-api", private: true, defaultBranch: "main" },
  { githubRepoId: 900_102, fullName: "acme/web", private: true, defaultBranch: "main" },
  { githubRepoId: 900_103, fullName: "acme/docs", private: false, defaultBranch: "main" },
]);
const [api, web, docs] = repos as [(typeof repos)[number], (typeof repos)[number], (typeof repos)[number]];
const sql = db.$client;
await sql`update repos set loc = 48200 where id = ${api.id}`;
await sql`update repos set loc = 131000, last_deep_scan_at = now() - interval '5 hours' where id = ${web.id}`;

const minutes = (n: number) => new Date(Date.now() - n * 60_000);

async function scan(repoId: string, kind: "recon" | "pr_review" | "deep" | "fix_check", status: string, ago: number, extra: Partial<typeof schema.scans.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.scans)
    .values({ repoId, orgId: org.id, kind, status: status as never, trigger: "webhook", headSha: randomBytes(20).toString("hex"), createdAt: minutes(ago), startedAt: minutes(ago), finishedAt: status === "running" ? null : minutes(ago - 3), ...extra })
    .returning();
  return row!;
}

function finding(input: Partial<FindingInput> & Pick<FindingInput, "fingerprint" | "title" | "severity">): FindingInput {
  return {
    confidence: "high",
    category: "broken_access_control",
    cwe: "CWE-639",
    impact: "Any signed-in user can read every other customer's invoices, including billing emails and line items.",
    entryPoint: { file: "src/routes/invoices.ts", line: 12, description: "GET /api/invoices/:id, the id path parameter" },
    attackPath: [
      { file: "src/routes/invoices.ts", line: 13, note: "The invoice id comes straight from the URL.", excerpt: "12| router.get(\"/api/invoices/:id\", requireSession, async (req, res) => {\n13|   const invoice = await getInvoice(req.params.id);\n14|   res.json(invoice);" },
      { file: "src/billing/invoices.ts", line: 31, note: "getInvoice looks the invoice up by id alone. Nothing checks who is asking.", excerpt: "30| export async function getInvoice(id: string) {\n31|   return db.select().from(invoices).where(eq(invoices.id, id));\n32| }" },
    ],
    attacker: "any_user",
    preconditions: "Any signed-in user. Invoice ids are sequential, so they are easy to guess.",
    proofOfConcept: "curl -H 'cookie: session=<any account>' https://app.example.com/api/invoices/1042",
    fixGuidance: "Scope the lookup to the caller's organisation: use getInvoiceForOrg(id, session.orgId) and return 404 when it finds nothing.",
    guarantees: ["An invoice is only returned to members of the organisation that owns it.", "Everyone else gets a 404, not a 403, so ids can't be probed."],
    mustNotBreak: ["Invoice downloads for the owning organisation.", "The admin billing export."],
    regressionTest: "Sign in as a member of another organisation, request an invoice it doesn't own and expect a 404.",
    fixPrompt: "",
    ...input,
  };
}

const deep = await scan(api.id, "deep", "completed", 60 * 26, { credits: 15, trigger: "manual" });
await sql`update repos set last_deep_scan_at = ${minutes(60 * 26).toISOString()}::timestamptz where id = ${api.id}`;
const { ids } = await upsertFindings(db, api.id, deep, [
  finding({ fingerprint: "dev-1", title: "Any user can read other customers' invoices", severity: "high" }),
  finding({
    fingerprint: "dev-2",
    title: "SQL injection in invoice search via the q parameter",
    severity: "critical",
    category: "sql_injection",
    cwe: "CWE-89",
    attacker: "unauthenticated",
    preconditions: "None. The search endpoint is public.",
    impact: "Anyone on the internet can read or change every row in the billing database.",
    entryPoint: { file: "src/routes/search.ts", line: 8, description: "GET /api/search?q=" },
    attackPath: [
      { file: "src/routes/search.ts", line: 9, note: "q is read from the query string without validation.", excerpt: " 8| router.get(\"/api/search\", async (req, res) => {\n 9|   const q = String(req.query.q ?? \"\");\n10|   res.json(await searchInvoices(q));" },
      { file: "src/billing/search.ts", line: 17, note: "q is concatenated into raw SQL.", excerpt: "16| export function searchInvoices(q: string) {\n17|   return db.execute(`select * from invoices where memo like '%${q}%'`);\n18| }" },
    ],
    proofOfConcept: "curl 'https://app.example.com/api/search?q=%27%20union%20select%20email,password_hash,null%20from%20users--'",
    fixGuidance: "Pass q as a bound parameter: db.execute(sql`select * from invoices where memo like ${'%' + q + '%'}`).",
    guarantees: ["User input never becomes part of the SQL text."],
    mustNotBreak: ["Partial matches on invoice memos."],
    regressionTest: "Search for a quote followed by a UNION payload and expect an empty result, not other tables' rows.",
  }),
  finding({ fingerprint: "dev-3", title: "Coupon codes can be redeemed more than once in parallel", severity: "medium", category: "race_condition", cwe: "CWE-362", confidence: "medium", impact: "A customer can stack the same single-use coupon by sending the redeem request many times at once." }),
  finding({ fingerprint: "dev-4", title: "Password reset tokens never expire", severity: "low", category: "broken_authentication", cwe: "CWE-640", confidence: "low", impact: "A leaked reset link works forever." }),
]);
await sql`update scans set stats = ${JSON.stringify({ findingIds: ids, loc: 48_200 })}::jsonb where id = ${deep.id}`;
await db.insert(schema.scanMetrics).values({ scanId: deep.id, inputTokens: 1, cachedTokens: 1, outputTokens: 1, requests: 1, durationMs: 151_000, candidates: 6, survivors: 4 }).onConflictDoNothing();
await db.insert(schema.scanEvents).values(
  [
    ["stage", "Indexing the code…"],
    ["stage", "Sweeping for secrets, vulnerable dependencies and dangerous sinks…"],
    ["progress", "2 vulnerable dependencies, 41 sinks, 0 secrets."],
    ["stage", "Hunting across 8 areas: billing, auth, search, coupons, webhooks, admin, abuse, leads."],
    ["finding", "Found: SQL injection in invoice search via the q parameter"],
    ["finding", "Found: Any user can read other customers' invoices"],
    ["warning", "One hunter ran out of turns in src/admin."],
    ["stage", "Hunting done; 6 candidates. Finishing verification…"],
    ["stage", "Found 4: 1 critical, 1 high, 1 medium, 1 low."],
  ].map(([type, message], i) => ({ scanId: deep.id, seq: i + 1, type: type!, message: message!, createdAt: new Date(minutes(60 * 26).getTime() + i * 17_000) })),
).onConflictDoNothing();

await scan(web.id, "pr_review", "completed", 40, { prNumber: 212, credits: 2 });
const live = await scan(web.id, "deep", "running", 1, { trigger: "manual" });
await db.insert(schema.scanEvents).values([
  { scanId: live.id, seq: 1, type: "stage", message: "Indexing the code…" },
  { scanId: live.id, seq: 2, type: "stage", message: "Sweeping for secrets, vulnerable dependencies and dangerous sinks…" },
]).onConflictDoNothing();
await scan(docs.id, "recon", "completed", 60 * 24 * 3);

// A month of everyday activity across a few dozen more repos, so the overview,
// the scan history and a long repo list have something to show. Seeded, so
// every run draws the same month.
let state = 7;
const rand = () => ((state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
const NAMES = ["auth-service", "mobile", "admin", "infra", "payments", "search", "notifications", "analytics", "cli", "sdk-js", "sdk-python", "marketing-site", "design-system", "data-pipeline", "webhooks", "gateway", "scheduler", "importer", "exporter", "reports", "onboarding", "support-bot", "feature-flags", "media", "edge-cache"];
const extra = await upsertRepos(
  db,
  org.id,
  NAMES.map((name, i) => ({ githubRepoId: 900_200 + i, fullName: `acme/${name}`, private: i % 6 !== 5, defaultBranch: "main" })),
);
const TITLES: Array<[string, "critical" | "high" | "medium" | "low", string]> = [
  ["Webhook signatures are compared with a non-constant-time check", "medium", "broken_authentication"],
  ["Admin export reachable by any signed-in user", "high", "broken_access_control"],
  ["Server fetches any URL passed as the avatar link", "high", "ssrf"],
  ["Uploaded SVGs are served inline and run scripts", "medium", "xss"],
  ["API keys are logged on failed requests", "low", "sensitive_data_exposure"],
  ["Refunds can exceed the original charge", "critical", "business_logic"],
  ["Invite links never expire and can be reused", "medium", "broken_authentication"],
  ["Team members can change another team's billing email", "high", "broken_access_control"],
  ["Open redirect after sign-in via the next parameter", "low", "open_redirect"],
  ["Rate limit keyed on a header the client controls", "medium", "rate_limiting"],
];
let fingerprint = 100;
for (const [i, repo] of extra.entries()) {
  await sql`update repos set loc = ${Math.round(4_000 + rand() * 260_000)} where id = ${repo.id}`;
  await scan(repo.id, "recon", "completed", 60 * 24 * 62);
  // Busy repos get a pull request most days; quiet ones a few a month.
  const busy = i % 4 === 0 ? 0.9 : i % 3 === 0 ? 0.45 : 0.15;
  let pr = 40 + i * 7;
  for (let day = 59; day >= 0; day--) {
    if (rand() > busy) continue;
    const ago = day * 24 * 60 + Math.round(rand() * 600);
    const failed = rand() < 0.04;
    const review = await scan(repo.id, "pr_review", failed ? "failed" : "completed", ago, {
      prNumber: pr++,
      credits: failed ? 0 : pick([1, 1, 1, 2, 3]),
      billing: failed ? "released" : "charged",
      error: failed ? "The model endpoint timed out three times." : null,
    });
    await db.insert(schema.scanMetrics).values({ scanId: review.id, inputTokens: 1, cachedTokens: 1, outputTokens: 1, requests: 1, durationMs: Math.round(25_000 + rand() * 90_000), candidates: 1, survivors: 0 }).onConflictDoNothing();
    if (failed || rand() > 0.22) {
      await sql`update scans set stats = ${JSON.stringify({ findingIds: [] })}::jsonb where id = ${review.id}`;
      continue;
    }
    const [title, severity, category] = pick(TITLES);
    const { ids } = await upsertFindings(db, repo.id, review, [finding({ fingerprint: `dev-${fingerprint++}`, title, severity, category, confidence: pick(["high", "high", "medium"]) })]);
    await sql`update scans set stats = ${JSON.stringify({ findingIds: ids })}::jsonb where id = ${review.id}`;
    await sql`update findings set first_seen_at = ${minutes(ago).toISOString()}::timestamptz, last_seen_at = ${minutes(ago).toISOString()}::timestamptz where id = any(${ids})`;
    // About half get fixed a few days later.
    if (rand() < 0.5 && day > 2) await sql`update findings set status = 'fixed', fixed_at = ${minutes(ago - 60 * 24 * 2).toISOString()}::timestamptz where id = any(${ids})`;
  }
  if (i % 5 === 1) {
    const ago = 60 * 24 * Math.round(2 + rand() * 20);
    const dug = await scan(repo.id, "deep", "completed", ago, { credits: pick([5, 10]), billing: "charged", trigger: "manual" });
    await db.insert(schema.scanMetrics).values({ scanId: dug.id, inputTokens: 1, cachedTokens: 1, outputTokens: 1, requests: 1, durationMs: Math.round(90_000 + rand() * 240_000), candidates: 5, survivors: 2 }).onConflictDoNothing();
    const list = [pick(TITLES), pick(TITLES)].map(([title, severity, category]) => finding({ fingerprint: `dev-${fingerprint++}`, title, severity, category }));
    const { ids } = await upsertFindings(db, repo.id, dug, list);
    await sql`update scans set stats = ${JSON.stringify({ findingIds: ids, loc: 60_000 })}::jsonb where id = ${dug.id}`;
    await sql`update repos set last_deep_scan_at = ${minutes(ago).toISOString()}::timestamptz where id = ${repo.id}`;
  }
}
const allRepos = [...repos, ...extra];

// A plan with credits, stored as fresh so the dashboard never asks the billing service about this made-up org.
await sql`update orgs set free_dig_scan_id = ${deep.id} where id = ${org.id}`;
await db
  .insert(schema.orgBilling)
  .values({ orgId: org.id, planId: "standard", credits: 42, checkedAt: new Date(Date.now() + 365 * 86_400_000) })
  .onConflictDoUpdate({ target: schema.orgBilling.orgId, set: { planId: "standard", credits: 42, checkedAt: new Date(Date.now() + 365 * 86_400_000) } });

// The person.
const [user] = await db
  .insert(schema.users)
  .values({ name: "Dev User", email: "dev@example.com", emailVerified: true, login: "dev-user", githubUserId: 900_900, accessCheckedAt: new Date(Date.now() + 365 * 86_400_000) })
  .onConflictDoUpdate({ target: schema.users.email, set: { accessCheckedAt: new Date(Date.now() + 365 * 86_400_000) } })
  .returning();
await db.insert(schema.accounts).values({ userId: user!.id, providerId: "github", accountId: "900900" }).onConflictDoNothing();
for (const repo of allRepos) await db.insert(schema.permissionCache).values({ userId: user!.id, repoId: repo.id, permission: "admin" }).onConflictDoNothing();
await db.insert(schema.orgAdmins).values({ userId: user!.id, orgId: org.id }).onConflictDoNothing();

const token = randomBytes(24).toString("base64url");
await db.insert(schema.sessions).values({ userId: user!.id, token, expiresAt: new Date(Date.now() + 7 * 86_400_000) });
const signature = createHmac("sha256", secret).update(token).digest("base64");
console.log(`better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`);
await db.$client.end();
