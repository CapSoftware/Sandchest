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
  smallint,
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
  /** Email people with access about critical findings and finished deep scans. Default on. */
  emailNotifications?: boolean;
  /** Buy top-ups automatically when credits run low, up to a monthly spend in USD. Unset means off. */
  autoTopUp?: { enabled: boolean; monthlyLimitUsd: number };
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
    /** Deterministic leads: redacted secrets, advisories, and marker locations. Never code. */
    leads: jsonb("leads"),
    /** Counts, timings and usage from the engine report. */
    stats: jsonb("stats"),
    error: text("error"),
    /** Set when this scan's notifications were sent, so a retried step never emails twice. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    /** Credits held for this scan before it ran. `credits` is what was finally charged. */
    creditsReserved: integer("credits_reserved"),
    /** Where the scan's credits stand. Null for free scans and when billing is off. */
    billing: text("billing", { enum: ["reserved", "charged", "released"] }),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("scans_repo_idx").on(table.repoId, table.createdAt),
    index("scans_org_status_idx").on(table.orgId, table.status),
    // A PR head is reviewed once, however many times the webhook arrives.
    uniqueIndex("scans_pr_head_unique").on(table.repoId, table.prNumber, table.headSha).where(sql`${table.kind} = 'pr_review'`),
    // One deep scan at a time per repo, however many Dig clicks race (SPEC §4).
    uniqueIndex("scans_active_deep_unique").on(table.repoId).where(sql`${table.kind} = 'deep' and ${table.status} in ('queued', 'running', 'publishing')`),
    // Few rows: scans holding credits, for the sweep that settles them.
    index("scans_billing_reserved_idx").on(table.status).where(sql`${table.billing} = 'reserved'`),
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
    /** Null for automatic events (fix checks). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
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

// ---- People ----------------------------------------------------------------
// Users sign in with GitHub. The first four tables are better-auth's; ids are
// generated by Postgres. IP addresses are not recorded.

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** GitHub's primary email, or a no-reply placeholder when it is private. */
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  githubUserId: bigint("github_user_id", { mode: "number" }).unique(),
  login: text("login"),
  /** When this user's repository access was last read from GitHub. */
  accessCheckedAt: timestamp("access_checked_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

/** The GitHub account behind a user. Tokens are encrypted by better-auth before they are stored. */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("accounts_user_idx").on(table.userId), uniqueIndex("accounts_provider_account_unique").on(table.providerId, table.accountId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

/**
 * Repositories a user may see: GitHub reports push access or higher. Replaced
 * as a whole each time access is read from GitHub (at most every 5 minutes).
 */
export const permissionCache = pgTable(
  "permission_cache",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    permission: text("permission", { enum: ["admin", "maintain", "write"] }).notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.repoId] }), index("permission_cache_repo_idx").on(table.repoId)],
);

/** Orgs whose settings a user may change: GitHub org admins, or the owner of a personal account. */
export const orgAdmins = pgTable(
  "org_admins",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.orgId] })],
);

/**
 * An org's billing as last read from Autumn, so pages never wait on it. The
 * scan gate always asks Autumn itself; this copy is for display and is
 * refreshed in the background once it is a minute old.
 */
export const orgBilling = pgTable("org_billing", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  /** Null without an active plan. */
  planId: text("plan_id"),
  pastDue: boolean("past_due").notNull().default(false),
  /** When a cancelled plan stops. */
  endsAt: timestamp("ends_at", { withTimezone: true }),
  renewsAt: timestamp("renews_at", { withTimezone: true }),
  /** A downgrade that starts when this period ends. */
  nextPlanId: text("next_plan_id"),
  credits: integer("credits").notNull().default(0),
  creditsResetAt: timestamp("credits_reset_at", { withTimezone: true }),
  /** Auto top-up as Autumn has it: threshold and quantity in credits, top-ups per month. */
  autoTopUp: jsonb("auto_top_up").$type<{ enabled: boolean; threshold: number; quantity: number; perMonth: number }>(),
  /** First time a plan was seen active: recon starts then. */
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * The credit level admins were last emailed about: 0 ok, 1 low, 2 exhausted.
   * It rises once per downward crossing (one email each) and falls when
   * credits come back, which re-arms the emails.
   */
  creditLevel: smallint("credit_level").notNull().default(0),
  /** When the level last rose. Only a balance read from Autumn after this may lower it. */
  creditLevelAt: timestamp("credit_level_at", { withTimezone: true }),
});

/**
 * Org-wide emails already sent, by a stable key (an auto top-up's invoice, a
 * day's failed top-ups), so a retried webhook or step never sends one twice.
 */
export const orgNotices = pgTable(
  "org_notices",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.key] })],
);

export const orgRelations = relations(orgs, ({ many }) => ({ repos: many(repos) }));
export const repoRelations = relations(repos, ({ one, many }) => ({ org: one(orgs, { fields: [repos.orgId], references: [orgs.id] }), scans: many(scans) }));
export const scanRelations = relations(scans, ({ one }) => ({ repo: one(repos, { fields: [scans.repoId], references: [repos.id] }) }));
