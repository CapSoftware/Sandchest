/**
 * Postgres schema. Source code is never stored: findings keep only the
 * minimal excerpts that explain them, and threat models are summaries.
 */
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export interface OrgSettings {
  /** Lowest severity that fails the PR Check. */
  checkThreshold: "critical" | "high" | "medium" | "low";
}

/** One GitHub account (user or organisation) with the app installed. The billing customer. */
export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubAccountId: bigint("github_account_id", { mode: "number" }).notNull().unique(),
  githubLogin: text("github_login").notNull(),
  type: text("type", { enum: ["User", "Organization"] }).notNull(),
  /** Null once uninstalled. */
  installationId: bigint("installation_id", { mode: "number" }).unique(),
  settings: jsonb("settings").$type<OrgSettings>().notNull().default({ checkThreshold: "high" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull().unique(),
    fullName: text("full_name").notNull(),
    private: boolean("private").notNull(),
    defaultBranch: text("default_branch").notNull(),
    /** False once removed from the installation. */
    enabled: boolean("enabled").notNull().default(true),
    loc: integer("loc"),
    lastDeepScanAt: timestamp("last_deep_scan_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("repos_org_idx").on(table.orgId)],
);

/** The repo's threat model: summary text only, never source. */
export const repoMemory = pgTable("repo_memory", {
  repoId: uuid("repo_id")
    .primaryKey()
    .references(() => repos.id, { onDelete: "cascade" }),
  threatModel: jsonb("threat_model").notNull(),
  /** Commit the threat model was built from. */
  commitSha: text("commit_sha").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
});

export const scanKind = pgEnum("scan_kind", ["recon", "pr_review", "deep", "fix_check"]);
export const scanStatus = pgEnum("scan_status", ["queued", "running", "publishing", "completed", "failed", "cancelled", "refused"]);

export const scans = pgTable(
  "scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    /** Denormalised for the per-org concurrency limit. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    kind: scanKind("kind").notNull(),
    status: scanStatus("status").notNull().default("queued"),
    trigger: text("trigger", { enum: ["webhook", "manual", "schedule"] }).notNull(),
    prNumber: integer("pr_number"),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha"),
    checkRunId: bigint("check_run_id", { mode: "number" }),
    workflowRunId: text("workflow_run_id"),
    credits: integer("credits").notNull().default(0),
    /** Deterministic leads (redacted secrets, advisories, markers): never code. */
    leads: jsonb("leads"),
    /** Counts, timings and usage from the engine report. */
    stats: jsonb("stats"),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("scans_repo_idx").on(table.repoId, table.createdAt),
    index("scans_org_status_idx").on(table.orgId, table.status),
    // A PR head is reviewed once, however many times the webhook arrives.
    uniqueIndex("scans_pr_head_unique").on(table.repoId, table.prNumber, table.headSha).where(sql`${table.kind} = 'pr_review'`),
  ],
);

/** The live feed: calm progress messages, never code. */
export const scanEvents = pgTable(
  "scan_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    message: text("message").notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("scan_events_seq_unique").on(table.scanId, table.seq)],
);

export const scanMetrics = pgTable("scan_metrics", {
  scanId: uuid("scan_id")
    .primaryKey()
    .references(() => scans.id, { onDelete: "cascade" }),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
  cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull(),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
  requests: integer("requests").notNull(),
  modelCostUsd: numeric("model_cost_usd", { precision: 12, scale: 6 }),
  computeCostUsd: numeric("compute_cost_usd", { precision: 12, scale: 6 }),
  durationMs: integer("duration_ms").notNull(),
  candidates: integer("candidates").notNull(),
  survivors: integer("survivors").notNull(),
});

export const findingStatus = pgEnum("finding_status", ["open", "fixed", "dismissed", "verified"]);
export const dismissReason = pgEnum("dismiss_reason", ["false_positive", "accepted_risk", "wont_fix"]);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    status: findingStatus("status").notNull().default("open"),
    dismissReason: dismissReason("dismiss_reason"),
    severity: text("severity", { enum: ["critical", "high", "medium", "low"] }).notNull(),
    confidence: text("confidence", { enum: ["high", "medium", "low"] }).notNull(),
    category: text("category").notNull(),
    cwe: text("cwe"),
    title: text("title").notNull(),
    impact: text("impact").notNull(),
    entryPoint: jsonb("entry_point").notNull(),
    /** Steps with file, line, note and a minimal excerpt. Excerpts are deleted on resolution. */
    attackPath: jsonb("attack_path").notNull(),
    attacker: text("attacker").notNull(),
    preconditions: text("preconditions").notNull(),
    proofOfConcept: text("proof_of_concept").notNull(),
    fixGuidance: text("fix_guidance").notNull(),
    guarantees: jsonb("guarantees").$type<string[]>().notNull(),
    mustNotBreak: jsonb("must_not_break").$type<string[]>().notNull(),
    regressionTest: text("regression_test").notNull(),
    fixPrompt: text("fix_prompt").notNull(),
    sourceScanId: uuid("source_scan_id").references(() => scans.id, { onDelete: "set null" }),
    sourceKind: scanKind("source_kind").notNull(),
    prNumber: integer("pr_number"),
    /** Set when a fix check could no longer locate the cited code. */
    staleAt: timestamp("stale_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    fixedAt: timestamp("fixed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("findings_repo_fingerprint_unique").on(table.repoId, table.fingerprint), index("findings_repo_status_idx").on(table.repoId, table.status)],
);

export const findingEvents = pgTable(
  "finding_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    /** Null for automatic events (fix checks). Users arrive in M3. */
    userId: uuid("user_id"),
    type: text("type", { enum: ["dismissed", "reopened", "fixed", "prompt_copied", "stale", "seen"] }).notNull(),
    scanId: uuid("scan_id").references(() => scans.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [index("finding_events_finding_idx").on(table.findingId)],
);

/** GitHub retries webhooks; each delivery is handled once. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").notNull(),
    event: text("event").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const orgRelations = relations(orgs, ({ many }) => ({ repos: many(repos) }));
export const repoRelations = relations(repos, ({ one, many }) => ({ org: one(orgs, { fields: [repos.orgId], references: [orgs.id] }), scans: many(scans) }));
export const scanRelations = relations(scans, ({ one }) => ({ repo: one(repos, { fields: [scans.repoId], references: [repos.id] }) }));
