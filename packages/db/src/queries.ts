/**
 * Every write the GitHub App and the scan workflows make. Each is idempotent
 * or guarded, because webhooks and workflow steps are retried.
 */
import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "./client";
import { findingEvents, findings, orgs, repoMemory, repos, scanEvents, scanMetrics, scans, webhookDeliveries } from "./schema";

export type Org = typeof orgs.$inferSelect;
export type Repo = typeof repos.$inferSelect;
export type Scan = typeof scans.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;
export type ScanKind = Scan["kind"];
export type ScanStatus = Scan["status"];

// ---- Webhooks --------------------------------------------------------------

/** Records a delivery. False if it was already handled (GitHub redelivered it). */
export async function claimDelivery(database: Db, id: string, event: string): Promise<boolean> {
  const rows = await database.insert(webhookDeliveries).values({ id, event }).onConflictDoNothing().returning({ id: webhookDeliveries.id });
  return rows.length === 1;
}

// ---- Installations ---------------------------------------------------------

export interface AccountInput {
  githubAccountId: number;
  githubLogin: string;
  type: "User" | "Organization";
}

export interface RepoInput {
  githubRepoId: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

/** Creates or refreshes the org for an installation and enables the given repos. */
export async function upsertInstallation(database: Db, installationId: number, account: AccountInput, repoList: RepoInput[]): Promise<{ org: Org; repos: Repo[] }> {
  return database.transaction(async (tx) => {
    const [org] = await tx
      .insert(orgs)
      .values({ ...account, installationId })
      .onConflictDoUpdate({ target: orgs.githubAccountId, set: { githubLogin: account.githubLogin, type: account.type, installationId } })
      .returning();
    const saved = await upsertRepos(tx as unknown as Db, org!.id, repoList);
    return { org: org!, repos: saved };
  });
}

export async function upsertRepos(database: Db, orgId: string, repoList: RepoInput[]): Promise<Repo[]> {
  if (repoList.length === 0) return [];
  return database
    .insert(repos)
    .values(repoList.map((repo) => ({ ...repo, orgId, enabled: true })))
    .onConflictDoUpdate({
      target: repos.githubRepoId,
      set: {
        orgId,
        fullName: sql`excluded.full_name`,
        private: sql`excluded.private`,
        defaultBranch: sql`excluded.default_branch`,
        enabled: true,
      },
    })
    .returning();
}

/**
 * Deletes the code a repo's findings quote (attack-path excerpts and the fix
 * prompt built from them) once Sandchest may no longer read that repo
 * (SPEC §6, §16). The findings themselves stay, so history and counts
 * survive; a later scan after reinstalling brings excerpts back.
 */
const forgetCode = {
  attackPath: sql`(select coalesce(jsonb_agg(step - 'excerpt'), '[]'::jsonb) from jsonb_array_elements(${findings.attackPath}) step)`,
  fixPrompt: "",
};

/** A repo removed from the installation: stop scanning it and delete the code its findings quote. */
export async function disableRepos(database: Db, githubRepoIds: number[]): Promise<void> {
  if (githubRepoIds.length === 0) return;
  await database.transaction(async (tx) => {
    const disabled = await tx.update(repos).set({ enabled: false }).where(inArray(repos.githubRepoId, githubRepoIds)).returning({ id: repos.id });
    if (disabled.length > 0) await tx.update(findings).set(forgetCode).where(inArray(findings.repoId, disabled.map((r) => r.id)));
  });
}

/**
 * Uninstall (or suspension): forget the installation, disable its repos and
 * delete the code their findings quote. Findings stay until data deletion.
 */
export async function removeInstallation(database: Db, installationId: number): Promise<void> {
  await database.transaction(async (tx) => {
    const [org] = await tx.update(orgs).set({ installationId: null }).where(eq(orgs.installationId, installationId)).returning({ id: orgs.id });
    if (!org) return;
    await tx.update(repos).set({ enabled: false }).where(eq(repos.orgId, org.id));
    await tx.update(findings).set(forgetCode).where(sql`${findings.repoId} in (select id from ${repos} where org_id = ${org.id})`);
  });
}

export async function orgByInstallation(database: Db, installationId: number): Promise<Org | undefined> {
  return database.query.orgs.findFirst({ where: eq(orgs.installationId, installationId) });
}

export async function repoByGithubId(database: Db, githubRepoId: number): Promise<(Repo & { org: Org }) | undefined> {
  return database.query.repos.findFirst({ where: eq(repos.githubRepoId, githubRepoId), with: { org: true } });
}

export async function repoByFullName(database: Db, fullName: string): Promise<(Repo & { org: Org }) | undefined> {
  return database.query.repos.findFirst({ where: eq(repos.fullName, fullName), with: { org: true } });
}

// ---- Threat models ---------------------------------------------------------

export async function threatModel(database: Db, repoId: string): Promise<{ threatModel: unknown; commitSha: string } | undefined> {
  return database.query.repoMemory.findFirst({ where: eq(repoMemory.repoId, repoId), columns: { threatModel: true, commitSha: true } });
}

export async function saveThreatModel(database: Db, repoId: string, model: unknown, commitSha: string): Promise<void> {
  await database
    .insert(repoMemory)
    .values({ repoId, threatModel: model, commitSha })
    .onConflictDoUpdate({ target: repoMemory.repoId, set: { threatModel: model, commitSha, version: sql`${repoMemory.version} + 1` } });
}

// ---- Scans -----------------------------------------------------------------

export interface NewScan {
  /** Set when credits were reserved under this id before the scan was created. */
  id?: string;
  billing?: "reserved";
  creditsReserved?: number;
  repoId: string;
  orgId: string;
  kind: ScanKind;
  trigger: Scan["trigger"];
  headSha: string;
  baseSha?: string;
  prNumber?: number;
}

/**
 * Creates a scan. A PR head already under review, or a repo with a deep scan
 * already active, returns the existing scan with `created: false`, so a
 * redelivered webhook or a second Dig click never starts a second one.
 */
export async function createScan(database: Db, input: NewScan): Promise<{ scan: Scan; created: boolean }> {
  const [created] = await database.insert(scans).values(input).onConflictDoNothing().returning();
  if (created) return { scan: created, created: true };
  // A deep scan conflicts with the repo's active one; a PR review with the review of the same head.
  const existing =
    input.kind === "deep"
      ? await activeDeepScan(database, input.repoId)
      : await database.query.scans.findFirst({
          where: and(eq(scans.repoId, input.repoId), eq(scans.kind, input.kind), eq(scans.headSha, input.headSha), input.prNumber === undefined ? undefined : eq(scans.prNumber, input.prNumber)),
        });
  if (!existing) throw new Error("Scan insert conflicted but no existing scan was found");
  return { scan: existing, created: false };
}

/** Removes a scan that never started (a Dig whose credits were refused), freeing its slot. */
export async function deleteUnstartedScan(database: Db, scanId: string): Promise<void> {
  await database.delete(scans).where(and(eq(scans.id, scanId), eq(scans.status, "queued"), isNull(scans.workflowRunId)));
}

export async function scanById(database: Db, id: string): Promise<(Scan & { repo: Repo & { org: Org } }) | undefined> {
  return database.query.scans.findFirst({ where: eq(scans.id, id), with: { repo: { with: { org: true } } } });
}

/**
 * Moves a queued scan to running if its org has a free slot in the scan's
 * lane. Recon, which runs by itself for every repository when a plan starts,
 * has a lane of its own, so a Dig, a PR review or a fix check never waits
 * behind it. Serialised per org with an advisory lock, so two scans cannot
 * both take the last slot. Returns true if the scan is running (now, or already).
 */
export async function claimScanSlot(database: Db, scanId: string, orgId: string, limit: number): Promise<boolean> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orgId}, 0))`);
    const [scan] = await tx.select({ status: scans.status, kind: scans.kind }).from(scans).where(eq(scans.id, scanId));
    if (!scan) throw new Error(`Scan ${scanId} not found`);
    if (scan.status !== "queued") return scan.status === "running";
    const lane = scan.kind === "recon" ? eq(scans.kind, "recon") : ne(scans.kind, "recon");
    const [{ running }] = (await tx
      .select({ running: sql<number>`count(*)::int` })
      .from(scans)
      .where(and(eq(scans.orgId, orgId), eq(scans.status, "running"), lane))) as [{ running: number }];
    if (running >= limit) return false;
    await tx.update(scans).set({ status: "running", startedAt: new Date() }).where(eq(scans.id, scanId));
    return true;
  });
}

/**
 * Adds one line to a scan's feed, unless it would repeat the line before it:
 * a waiting scan says why once, not on every poll. For lines written outside
 * a running scan (its EventWriter takes over from there).
 */
export async function noteScanEvent(database: Db, scanId: string, type: string, message: string): Promise<void> {
  await database.execute(sql`
    insert into ${scanEvents} (scan_id, seq, type, message)
    select ${scanId}, coalesce(max(seq), 0) + 1, ${type}, ${message} from ${scanEvents} where scan_id = ${scanId}
    having not exists (
      select 1 from ${scanEvents} last where last.scan_id = ${scanId} and last.type = ${type} and last.message = ${message}
        and last.seq = (select max(seq) from ${scanEvents} where scan_id = ${scanId})
    )
    on conflict do nothing
  `);
}

export async function updateScan(database: Db, scanId: string, values: Partial<Pick<Scan, "status" | "checkRunId" | "workflowRunId" | "credits" | "leads" | "stats" | "error" | "finishedAt" | "baseSha">>): Promise<void> {
  await database.update(scans).set(values).where(eq(scans.id, scanId));
}

/**
 * Reserves the right to start a scan's workflow. Exactly one caller gets
 * true, however many deliveries race for the same scan.
 */
export async function claimWorkflowStart(database: Db, scanId: string, claim: string): Promise<boolean> {
  const rows = await database
    .update(scans)
    .set({ workflowRunId: claim })
    .where(and(eq(scans.id, scanId), isNull(scans.workflowRunId)))
    .returning({ id: scans.id });
  return rows.length === 1;
}

/** Gives the reservation back after a failed start, so a redelivery can try again. */
export async function releaseWorkflowStart(database: Db, scanId: string, claim: string): Promise<void> {
  await database.update(scans).set({ workflowRunId: null }).where(and(eq(scans.id, scanId), eq(scans.workflowRunId, claim)));
}

/** Scans that never got a workflow (a lost start) or have been running far past any budget. */
export async function strandedScans(database: Db, now = new Date()): Promise<{ unstarted: Scan[]; stuck: Scan[] }> {
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60_000);
  const halfHourAgo = new Date(now.getTime() - 30 * 60_000);
  const [unstarted, stuck] = await Promise.all([
    database.query.scans.findMany({
      where: and(eq(scans.status, "queued"), isNull(scans.workflowRunId), lt(scans.createdAt, fiveMinutesAgo)),
      limit: 50,
    }),
    database.query.scans.findMany({
      where: and(inArray(scans.status, ["running", "publishing"]), lt(scans.startedAt, halfHourAgo)),
      limit: 50,
    }),
  ]);
  return { unstarted, stuck };
}

/** When the repo last had a completed deep scan, for the 24-hour cooldown. */
export async function lastDeepScanAt(database: Db, repoId: string): Promise<Date | undefined> {
  const repo = await database.query.repos.findFirst({ where: eq(repos.id, repoId), columns: { lastDeepScanAt: true } });
  return repo?.lastDeepScanAt ?? undefined;
}

/** Whether a deep scan for the repo is queued or running right now. */
export async function activeDeepScan(database: Db, repoId: string): Promise<Scan | undefined> {
  return database.query.scans.findFirst({ where: and(eq(scans.repoId, repoId), eq(scans.kind, "deep"), inArray(scans.status, ["queued", "running", "publishing"])) });
}

export async function markDeepScanned(database: Db, repoId: string, at: Date, loc: number): Promise<void> {
  await database.update(repos).set({ lastDeepScanAt: at, loc }).where(eq(repos.id, repoId));
}

/** Repository size from a recon, so the Dig button can show its cost before the first deep scan. */
export async function setRepoLoc(database: Db, repoId: string, loc: number): Promise<void> {
  await database.update(repos).set({ loc }).where(eq(repos.id, repoId));
}

export interface MetricsInput {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  requests: number;
  modelCostUsd?: number;
  durationMs: number;
  candidates: number;
  survivors: number;
}

export async function recordMetrics(database: Db, scanId: string, metrics: MetricsInput): Promise<void> {
  const values = { ...metrics, modelCostUsd: metrics.modelCostUsd?.toFixed(6) };
  await database.insert(scanMetrics).values({ scanId, ...values }).onConflictDoUpdate({ target: scanMetrics.scanId, set: values });
}

// ---- Live feed -------------------------------------------------------------

/**
 * Appends a scan's events in order with few round trips: events queue in
 * memory and flush in batches. Sequence numbers continue from what is
 * already stored, so a retried step appends rather than overwriting.
 */
export class EventWriter {
  private queue: Array<{ type: string; message: string; createdAt: Date }> = [];
  private flushing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq: number | undefined;

  constructor(
    private readonly database: Db,
    private readonly scanId: string,
    private readonly delayMs = 150,
  ) {}

  /** Each event keeps the time it happened, not the time its batch was written. */
  write(type: string, message: string): void {
    this.queue.push({ type, message, createdAt: new Date() });
    this.timer ??= setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Writes everything queued so far. Errors are thrown here, not lost. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return this.flushing;
    this.flushing = this.flushing.then(async () => {
      if (this.seq === undefined) {
        const [row] = (await this.database
          .select({ max: sql<number>`coalesce(max(${scanEvents.seq}), 0)::int` })
          .from(scanEvents)
          .where(eq(scanEvents.scanId, this.scanId))) as [{ max: number }];
        this.seq = row.max;
      }
      const rows = batch.map((event) => ({ scanId: this.scanId, seq: ++this.seq!, ...event }));
      await this.database.insert(scanEvents).values(rows).onConflictDoNothing();
    });
    return this.flushing;
  }
}

export async function eventsSince(database: Db, scanId: string, afterSeq: number, limit = 200) {
  return database
    .select({ seq: scanEvents.seq, type: scanEvents.type, message: scanEvents.message, createdAt: scanEvents.createdAt })
    .from(scanEvents)
    .where(and(eq(scanEvents.scanId, scanId), sql`${scanEvents.seq} > ${afterSeq}`))
    .orderBy(scanEvents.seq)
    .limit(limit);
}

// ---- Findings --------------------------------------------------------------

export type FindingInput = Omit<typeof findings.$inferInsert, "id" | "repoId" | "status" | "firstSeenAt" | "lastSeenAt" | "fixedAt" | "staleAt" | "dismissReason" | "sourceScanId" | "sourceKind" | "prNumber">;

/**
 * Inserts new findings and refreshes ones seen before (matched by
 * fingerprint). A fixed finding that reappears is reopened; a dismissed one
 * stays dismissed. Returns the ids of findings that were new.
 */
export async function upsertFindings(database: Db, repoId: string, scan: Pick<Scan, "id" | "kind" | "prNumber">, list: FindingInput[]): Promise<{ newIds: string[]; ids: string[] }> {
  if (list.length === 0) return { newIds: [], ids: [] };
  return database.transaction(async (tx) => {
    // A scan can finish after its repo was removed or the app uninstalled. Hold
    // the org and repo rows (in the order removeInstallation locks them) so the
    // two serialise, and store no code Sandchest may no longer read.
    const [org] = await tx.execute<{ installed: boolean }>(sql`select installation_id is not null as installed from ${orgs} where id = (select org_id from ${repos} where id = ${repoId}) for share`);
    const [repo] = await tx.execute<{ enabled: boolean }>(sql`select enabled from ${repos} where id = ${repoId} for share`);
    const readable = org?.installed === true && repo?.enabled === true;
    const stored = readable ? list : list.map((finding) => ({ ...finding, attackPath: withoutExcerpts(finding.attackPath), fixPrompt: "" }));
    const rows = await tx
      .insert(findings)
      .values(stored.map((finding) => ({ ...finding, repoId, sourceScanId: scan.id, sourceKind: scan.kind, prNumber: scan.prNumber })))
      .onConflictDoUpdate({
        target: [findings.repoId, findings.fingerprint],
        set: {
          lastSeenAt: sql`now()`,
          staleAt: null,
          status: sql`case when ${findings.status} = 'fixed' then 'open'::finding_status else ${findings.status} end`,
          fixedAt: sql`case when ${findings.status} = 'fixed' then null else ${findings.fixedAt} end`,
          severity: sql`excluded.severity`,
          confidence: sql`excluded.confidence`,
          title: sql`excluded.title`,
          impact: sql`excluded.impact`,
          // A dismissed finding stays resolved, so it never gets its code back (SPEC §6).
          attackPath: sql`case when ${findings.status} = 'dismissed' then (select coalesce(jsonb_agg(step - 'excerpt'), '[]'::jsonb) from jsonb_array_elements(excluded.attack_path) step) else excluded.attack_path end`,
          entryPoint: sql`excluded.entry_point`,
          proofOfConcept: sql`excluded.proof_of_concept`,
          fixGuidance: sql`excluded.fix_guidance`,
          fixPrompt: sql`case when ${findings.status} = 'dismissed' then '' else excluded.fix_prompt end`,
          // The latest scan's evidence: trust and validation can rise as proof improves.
          mitigations: sql`excluded.mitigations`,
          trust: sql`excluded.trust`,
          validation: sql`excluded.validation`,
          // Every signal that has ever raised this finding, so outcomes credit all of them.
          sources: sql`array(select distinct unnest(${findings.sources} || excluded.sources) order by 1)`,
        },
      })
      // xmax = 0 only for freshly inserted rows.
      .returning({ id: findings.id, inserted: sql<boolean>`(xmax = 0)` });
    await tx.insert(findingEvents).values(rows.map((row) => ({ findingId: row.id, type: "seen" as const, scanId: scan.id })));
    return { newIds: rows.filter((r) => r.inserted).map((r) => r.id), ids: rows.map((r) => r.id) };
  });
}

function withoutExcerpts(path: unknown): unknown {
  return Array.isArray(path) ? path.map((step) => (step && typeof step === "object" ? Object.fromEntries(Object.entries(step).filter(([key]) => key !== "excerpt")) : step)) : path;
}

/** A finding the team has resolved, with their verdict. No code, no user: what scans learn from. */
export interface ResolvedFinding {
  title: string;
  category: string;
  /** `file:line` where it landed. */
  at: string;
  outcome: "fixed" | "false_positive" | "accepted_risk" | "wont_fix";
}

/**
 * The team's verdicts on a repository's findings — fixed, or dismissed with a reason — most
 * recent first. Scans of the same repository learn from them: real issues seed variant hunting,
 * false-positive verdicts ground the skeptic. Capped so prompts stay small.
 */
export async function repoHistory(database: Db, repoId: string, limit = 60): Promise<ResolvedFinding[]> {
  const rows = await database
    .select({ title: findings.title, category: findings.category, attackPath: findings.attackPath, status: findings.status, dismissReason: findings.dismissReason })
    .from(findings)
    .where(and(eq(findings.repoId, repoId), inArray(findings.status, ["fixed", "dismissed"])))
    .orderBy(desc(findings.lastSeenAt))
    .limit(limit);
  return rows.flatMap((row) => {
    const outcome = row.status === "fixed" ? "fixed" : row.dismissReason;
    if (!outcome) return [];
    const last = (row.attackPath as Array<{ file: string; line: number }>).at(-1);
    return [{ title: row.title, category: row.category, at: last ? `${last.file}:${last.line}` : "", outcome }];
  });
}

export async function openFindings(database: Db, repoId: string): Promise<FindingRow[]> {
  return database.select().from(findings).where(and(eq(findings.repoId, repoId), eq(findings.status, "open"))).orderBy(desc(findings.lastSeenAt));
}

/** Marks findings fixed by a fix check and drops their code excerpts. */
export async function markFixed(database: Db, ids: string[], scanId: string): Promise<void> {
  if (ids.length === 0) return;
  await database.transaction(async (tx) => {
    await tx
      .update(findings)
      .set({
        status: "fixed",
        fixedAt: new Date(),
        attackPath: sql`(select coalesce(jsonb_agg(step - 'excerpt'), '[]'::jsonb) from jsonb_array_elements(${findings.attackPath}) step)`,
        // The prompt quotes the same code.
        fixPrompt: "",
      })
      .where(and(inArray(findings.id, ids), eq(findings.status, "open")));
    await tx.insert(findingEvents).values(ids.map((findingId) => ({ findingId, type: "fixed" as const, scanId })));
  });
}

export async function markStale(database: Db, ids: string[], scanId: string): Promise<void> {
  if (ids.length === 0) return;
  await database.transaction(async (tx) => {
    await tx.update(findings).set({ staleAt: new Date() }).where(inArray(findings.id, ids));
    await tx.insert(findingEvents).values(ids.map((findingId) => ({ findingId, type: "stale" as const, scanId })));
  });
}
