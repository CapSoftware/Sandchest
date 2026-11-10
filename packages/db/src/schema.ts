/**
 * Postgres schema. Source code is never stored: findings keep only the
 * minimal excerpts that explain them, and threat models are summaries.
 */
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
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
  /** Buy `quantity` credits automatically when they run low, up to a monthly spend in USD (null: no limit). Unset means off. Older choices have no quantity. */
  autoTopUp?: { enabled: boolean; monthlyLimitUsd: number | null; quantity?: number };
  /** The org's hacker, as chosen when recruiting it. Only how the rig looks and talks; scans ignore it. */
  hacker?: HackerProfile;
  /** Who the org is, for receipts: given while recruiting, prefilled from GitHub. */
  company?: { name: string; email: string };
  /** How pull requests are reviewed on repositories added from now on. Unset means "auto". Each repo can change its own. */
  prReviewsDefault?: "auto" | "command" | "off";
}

/** The hacker an org recruits: a name, a look and a way of talking. Validated by the web app before it is stored. */
export interface HackerProfile {
  handle: string;
  hoodie: string;
  shell: string;
  phosphor: string;
  room: string;
  stickers: string[];
  voice: string;
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
  /**
   * Unused: every deep scan is paid for with credits. It held the scan that used an org's free first one.
   * Kept until no deployed code reads it, then dropped.
   */
  freeDigScanId: uuid("free_dig_scan_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const PR_REVIEW_MODES = ["auto", "command", "off"] as const;
export type PrReviewMode = (typeof PR_REVIEW_MODES)[number];
export const DEEP_SCAN_SCHEDULES = ["off", "daily", "weekly", "monthly"] as const;
export type DeepScanSchedule = (typeof DEEP_SCAN_SCHEDULES)[number];

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
    /**
     * When pull requests are reviewed: `auto` on every push to a PR, `command` only when someone with write
     * access comments `/sandchest review` or starts one from the dashboard, `off` never.
     */
    prReviews: text("pr_reviews", { enum: PR_REVIEW_MODES }).notNull().default("auto"),
    /** How often a deep scan runs on its own. Each one is paid like a manual one, and skipped when nothing changed. */
    deepScanSchedule: text("deep_scan_schedule", { enum: DEEP_SCAN_SCHEDULES }).notNull().default("off"),
    /** When the next scheduled deep scan is due. Null when the schedule is off. */
    nextDeepScanAt: timestamp("next_deep_scan_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("repos_org_idx").on(table.orgId),
    // The scheduler's one question: which repos are due. Only scheduled repos are in it.
    index("repos_next_deep_scan_idx").on(table.nextDeepScanAt).where(sql`${table.nextDeepScanAt} is not null`),
  ],
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
    /** Chosen when a deep scan is started: its model calls go to faster serving, under their own ceiling. */
    fast: boolean("fast").notNull().default(false),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("scans_repo_idx").on(table.repoId, table.createdAt),
    index("scans_org_status_idx").on(table.orgId, table.status),
    // Analysis reads scans by when they started.
    index("scans_created_idx").on(table.createdAt),
    // A PR head is reviewed once, however many times the webhook arrives. One that failed or was refused
    // (out of credits) leaves the index, so `/sandchest review` or the dashboard can try that head again.
    uniqueIndex("scans_pr_head_unique")
      .on(table.repoId, table.prNumber, table.headSha)
      .where(sql`${table.kind} = 'pr_review' and ${table.status} in ('queued', 'running', 'publishing', 'completed')`),
    // One deep scan at a time per repo, however many Dig clicks race (SPEC §4).
    uniqueIndex("scans_active_deep_unique").on(table.repoId).where(sql`${table.kind} = 'deep' and ${table.status} in ('queued', 'running', 'publishing')`),
    // Few rows: scans holding credits, for the sweep that settles them.
    index("scans_billing_reserved_idx").on(table.status).where(sql`${table.billing} = 'reserved'`),
    // The sweep's two questions (strandedScans): only the few scans in these states are in each index.
    index("scans_unstarted_idx").on(table.createdAt).where(sql`${table.status} = 'queued' and ${table.workflowRunId} is null`),
    index("scans_in_flight_idx").on(table.startedAt).where(sql`${table.status} in ('running', 'publishing')`),
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

export const USAGE_KINDS = ["model", "sandbox"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];
export const USAGE_COST_SOURCES = ["provider", "priced", "sandbox"] as const;
export type UsageCostSource = (typeof USAGE_COST_SOURCES)[number];
/**
 * How a ledger row's call ended. `started`: under way, or lost if it stays so. `ok`: finished, cost
 * known. `failed`: the endpoint refused it. `aborted`: its stream broke off before the end. `unpriced`:
 * finished, but the endpoint reported no cost.
 */
export const USAGE_STATUSES = ["started", "ok", "failed", "aborted", "unpriced"] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

/**
 * What a scan spent, one row per model call and one per sandbox: the ledger usage-based bills are
 * computed from. Counts and costs only, never prompts or output.
 */
export const scanUsage = pgTable(
  "scan_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: USAGE_KINDS }).notNull(),
    /** Short machine name of the pipeline stage: `recon`, `hunt`, `review`, `sandbox`… */
    stage: text("stage").notNull(),
    /** The model role. Null for sandbox rows. */
    role: text("role"),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    /** Machine time, for sandbox rows. */
    seconds: numeric("seconds", { precision: 12, scale: 3 }),
    costUsd: numeric("cost_usd", { precision: 18, scale: 10 }).notNull(),
    /** `provider`: the model endpoint reported it. `priced`: computed from the price settings. `sandbox`: the sandbox host's meter. */
    costSource: text("cost_source", { enum: USAGE_COST_SOURCES }).notNull(),
    /** The unit of work that can be run again: a workflow step, or one launch of an in-sandbox agent. A bill counts, per step, only the rows of its latest attempt. */
    step: text("step").notNull().default("execute"),
    /** Which run of its step wrote the row, so a step that is run again can be told from the run before it. */
    attempt: integer("attempt").notNull().default(0),
    status: text("status", { enum: USAGE_STATUSES }).notNull().default("ok"),
    /** Set by a writer that may send a row twice (a write tried again): a second row with the same key is not stored. */
    key: uuid("key"),
    createdAt: createdAt(),
  },
  (table) => [index("scan_usage_scan_idx").on(table.scanId), uniqueIndex("scan_usage_key_unique").on(table.key)],
);

export const STAGE_OUTCOMES = ["ok", "failed", "skipped"] as const;
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

/**
 * How long each stage of a scan took, one row per run of a stage. Counts and times only, never code
 * or model text. A row with no end is a stage still running, or one whose end was never seen.
 */
export const scanStages = pgTable(
  "scan_stages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    /** Short machine name: `queue`, `sandbox`, `select`, `hunt`... */
    stage: text("stage").notNull(),
    /** Which run of the stage this is. */
    attempt: integer("attempt").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    outcome: text("outcome", { enum: STAGE_OUTCOMES }),
  },
  (table) => [uniqueIndex("scan_stages_run_unique").on(table.scanId, table.stage, table.attempt), index("scan_stages_scan_idx").on(table.scanId)],
);

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
    /** Protection in the code that limits (not eliminates) the impact; context for limited-impact cases. */
    mitigations: text("mitigations").notNull().default(""),
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
    /** How much independent evidence backs the finding (the trust gate). Null on findings written before validation shipped. */
    trust: text("trust", { enum: ["confirmed", "corroborated", "unconfirmed"] }),
    /** Signals that raised the finding (lead kinds, or `hunter`), so outcomes can be attributed to them. */
    sources: text("sources").array().notNull().default(sql`'{}'::text[]`),
    /** The validation outcome, if the finding went through it: { status, method, detail }. No code or secrets. */
    validation: jsonb("validation").$type<{ status: string; method: string; detail: string }>(),
    sourceScanId: uuid("source_scan_id").references(() => scans.id, { onDelete: "set null" }),
    sourceKind: scanKind("source_kind").notNull(),
    prNumber: integer("pr_number"),
    /** Set when a fix check could no longer locate the cited code. */
    staleAt: timestamp("stale_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    fixedAt: timestamp("fixed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("findings_repo_fingerprint_unique").on(table.repoId, table.fingerprint), index("findings_repo_status_idx").on(table.repoId, table.status), index("findings_first_seen_idx").on(table.firstSeenAt),
    // Deleting a scan sets these to null: without an index, every delete reads the whole table.
    index("findings_source_scan_idx").on(table.sourceScanId)],
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
  // By type and time for analysis: "seen" rows, by far the most, are skipped.
  (table) => [
    index("finding_events_finding_idx").on(table.findingId),
    index("finding_events_type_created_idx").on(table.type, table.createdAt),
    // Deleting a scan sets scan_id to null (see findings_source_scan_idx). Most events have none.
    index("finding_events_scan_idx").on(table.scanId).where(sql`${table.scanId} is not null`),
  ],
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

/**
 * Sandchest's one summary comment on each pull request, edited in place by
 * every later review so a PR never collects a comment per push.
 */
export const prComments = pgTable(
  "pr_comments",
  {
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    commentId: bigint("comment_id", { mode: "number" }).notNull(),
    /** The review the comment last described. */
    scanId: uuid("scan_id"),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.prNumber] })],
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

// ---- Agents ----------------------------------------------------------------
// Agents act as the person who connected them: through an API key, or OAuth
// tokens an MCP client was given. Only SHA-256 hashes of secrets are stored.

/**
 * A secret an agent presents as `Authorization: Bearer …`: an API key (from
 * the device flow or Settings; no expiry), or an OAuth access or refresh
 * token. Refresh tokens rotate: every use spends one and issues the next in
 * the same family, and a spent one shown again revokes the whole family.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["key", "access", "refresh"] }).notNull(),
    /** What the person or the agent called it: shown in Settings. */
    name: text("name").notNull(),
    /** SHA-256 of the secret, hex. */
    tokenHash: text("token_hash").notNull().unique(),
    /** The secret's first characters, to tell keys apart. */
    prefix: text("prefix").notNull(),
    /** The OAuth client it was issued to; null for API keys. */
    clientId: text("client_id").references(() => oauthClients.id, { onDelete: "cascade" }),
    /** One sign-in's access and refresh tokens share it, so revoking one revokes them all. */
    family: uuid("family"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("api_tokens_user_idx").on(table.userId), index("api_tokens_family_idx").on(table.family).where(sql`${table.family} is not null`)],
);

/** An MCP client, registered by itself (RFC 7591). Public clients only: PKCE stands in for a secret. */
export const oauthClients = pgTable("oauth_clients", {
  /** `scc_…`. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  createdAt: createdAt(),
});

/** A code from the consent page, spent once at the token endpoint within minutes. */
export const oauthCodes = pgTable("oauth_codes", {
  /** SHA-256 of the code, hex. */
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  /** PKCE S256 challenge. */
  codeChallenge: text("code_challenge").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/**
 * An agent asking to connect through the device flow (RFC 8628): it shows
 * the person a short code, they approve it in the browser, and the agent's
 * next poll collects an API key, once.
 */
export const deviceGrants = pgTable("device_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** SHA-256 of the device code the agent polls with, hex. */
  deviceCodeHash: text("device_code_hash").notNull().unique(),
  /** What the person types or sees: eight letters, stored without the dash. */
  userCode: text("user_code").notNull().unique(),
  /** The agent's own name for itself. */
  clientName: text("client_name").notNull(),
  status: text("status", { enum: ["pending", "approved", "denied", "issued"] }).notNull().default("pending"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  /** When the agent last polled, to slow down one polling too fast. */
  polledAt: timestamp("polled_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/**
 * Repositories a user may see: GitHub reports push access or higher, or an
 * admin invited them to the repo's org (`via` "invite", see `orgMembers`).
 * Replaced as a whole each time access is read from GitHub (at most every 5
 * minutes); joining or leaving an org changes its rows at once.
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
    /** Where the access comes from. GitHub wins when both grant it, so removing a member never takes GitHub's away. */
    via: text("via", { enum: ["github", "invite"] }).notNull().default("github"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.repoId] }), index("permission_cache_repo_idx").on(table.repoId)],
);

/**
 * Orgs whose settings and billing a user may change: GitHub org admins, the
 * owner of a personal account, or someone an admin invited as an admin
 * (`via` "invite", see `orgMembers`). Every admin check reads this table.
 */
export const orgAdmins = pgTable(
  "org_admins",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Where the role comes from. GitHub wins when both grant it, so demoting or removing someone never takes GitHub's away. */
    via: text("via", { enum: ["github", "invite"] }).notNull().default("github"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.orgId] }), index("org_admins_org_idx").on(table.orgId)],
);

export const TEAM_ROLES = ["member", "admin"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * People an admin invited to an org. Every one sees every enabled repo of it,
 * as if GitHub reported write access, whatever GitHub says. A `member` scans,
 * reviews and resolves findings; an `admin` also changes the org's settings,
 * billing and team. Removing the row, or changing the role, changes the
 * access at once.
 */
export const orgMembers = pgTable(
  "org_members",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: TEAM_ROLES }).notNull().default("member"),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.userId] }), index("org_members_user_idx").on(table.userId), check("org_members_role", sql`${table.role} in ('member', 'admin')`)],
);

/**
 * An invitation to an org, for one person: an email address they have
 * verified on GitHub, or one GitHub account. The link carries a random
 * token; only its SHA-256 is stored. Pending until accepted, revoked or
 * expired; a resend revokes the old row and adds a new one, so each row is
 * one email sent (which is what the send limits count).
 */
export const orgInvites = pgTable(
  "org_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    /** Lowercased. Set for email invites. */
    email: text("email"),
    /** Set for invites to a GitHub account; the login is only for display. */
    githubUserId: bigint("github_user_id", { mode: "number" }),
    githubLogin: text("github_login"),
    /** The role they get on joining. */
    role: text("role", { enum: TEAM_ROLES }).notNull().default("member"),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    // One pending invite per person per org.
    uniqueIndex("org_invites_pending_email").on(table.orgId, table.email).where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null and ${table.email} is not null`),
    uniqueIndex("org_invites_pending_github").on(table.orgId, table.githubUserId).where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null and ${table.githubUserId} is not null`),
    index("org_invites_org_idx").on(table.orgId),
    // The send limits: invites an admin sent lately, and invites an address got lately.
    index("org_invites_sender_idx").on(table.invitedBy, table.createdAt),
    index("org_invites_email_idx").on(table.email, table.createdAt),
    check("org_invites_one_invitee", sql`(${table.email} is null) <> (${table.githubUserId} is null)`),
    check("org_invites_role", sql`${table.role} in ('member', 'admin')`),
  ],
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
  /** Auto top-up as Autumn has it: threshold and quantity in credits, top-ups per month (null: no limit). */
  autoTopUp: jsonb("auto_top_up").$type<{ enabled: boolean; threshold: number; quantity: number; perMonth: number | null }>(),
  /** First time a plan was seen active: recon starts then. */
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * The credit level admins were last emailed about: 0 ok, 1 low, 2 exhausted.
   * It rises once per downward crossing (one email each) and falls when
   * credits come back, which re-arms the emails.
   */
  creditLevel: smallint("credit_level").notNull().default(0),
  /** When the last balance that counted toward the level was answered. Older answers are ignored. */
  creditLevelAt: timestamp("credit_level_at", { withTimezone: true }),
  /**
   * Goes up by one with every balance that counts. A crossing's email is
   * reserved in `org_notices` under its revision, which timestamps can't give:
   * they can repeat.
   */
  creditLevelRev: bigint("credit_level_rev", { mode: "number" }).notNull().default(0),
});

/**
 * Free credits claimed from `/claim`: one claim per GitHub account (the org)
 * and one per GitHub user, ever. Keyed by GitHub's own ids rather than ours,
 * with no foreign keys, so deleting and recreating a row can't claim again.
 * `granted_at` is set once Autumn holds the credits and the free plan; until
 * then the same person can finish their own claim, and nobody else can.
 */
export const creditClaims = pgTable("credit_claims", {
  githubAccountId: bigint("github_account_id", { mode: "number" }).primaryKey(),
  githubUserId: bigint("github_user_id", { mode: "number" }).notNull().unique(),
  orgId: uuid("org_id").notNull(),
  userId: uuid("user_id").notNull(),
  credits: integer("credits").notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  grantedAt: timestamp("granted_at", { withTimezone: true }),
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

// ---- Analytics -------------------------------------------------------------

/**
 * First-party analytics: one stream of what people did, for funnels, flows
 * and conversion. State lives in its own tables (scans, findings and their
 * events, billing); this stream records intent and outcomes those tables
 * cannot tell us: page views, clicks, steps, actions that failed or were
 * refused. See ANALYTICS.md for how to query it.
 *
 * `props` hold opaque ids, counts and enums: never source code, finding
 * contents, repository or account names, emails or free text. Every action
 * event carries `outcome`: "ok", or the reason it did not go through.
 */
export const EVENT_NAMES = [
  // ---- Browser (recorded by the beacon at /api/e) ----
  /**
   * A page was shown, or its query changed (filters). props: path (ids replaced by :id), referrer (host, external
   * only, first page of a visit), utm_source/medium/campaign/term/content, q_<key> for known status and filter
   * parameters (q_error, q_plan, q_recruited, q_severity, q_next, …; see QUERY_KEYS), device, country.
   */
  "page_view",
  /** A page stopped being looked at (navigation, tab hidden or closed). props: path, visible_ms. Sum per page view; a page hidden and shown again sends more than one. */
  "page_left",
  /** A link or tracked control was clicked. props: path, target (a `data-track` id, an internal path, or an external host). */
  "clicked",
  /** A step of a multi-step flow was shown. props: path, flow ("recruit"), step. */
  "step_viewed",

  // ---- Accounts ----
  /** A new person signed up (their user row was created). */
  "signed_up",
  /** Someone signed in (a new session). Carries the anonymous id that tied their visits to them. */
  "signed_in",
  /** Someone pressed sign in. props: next (the route they were headed to). */
  "sign_in_started",
  /** Someone signed out. */
  "signed_out",
  /** Someone opened the dashboard: recorded at most once per person per UTC day. */
  "dashboard_visit",
  /** A signed-in person was seen in this browser: recorded once per browser and person. Ties browsers signed in before analytics, or on other devices, to the person. */
  "identified",

  // ---- GitHub App ----
  /** The App was installed (or unsuspended) on an account. org_id set. props: action, account_type ("User" | "Organization"), repos. */
  "app_installed",
  /** The App was uninstalled or suspended. org_id set. props: action ("deleted" | "suspend"). */
  "app_uninstalled",
  /** Repositories were added to or removed from an installation. org_id set. props: added, removed. */
  "repos_changed",
  /** Someone came back from installing the App on GitHub. org_id set once the installation is known. props: setup_action, state ("recruit" when it started from recruiting), outcome ("ok" | "unknown_installation"). */
  "app_install_returned",

  // ---- Onboarding (recruit) ----
  /** Someone opened "claim free credits" (anonymous until they sign in). */
  "claim_started",
  /** The recruit form was submitted. props: path ("claim" | "checkout" | "none"), outcome ("ok" | "not_admin" | "invalid"). */
  "recruit_submitted",
  /** Free credits were claimed while recruiting. props: outcome ("ok", or why not: "org_claimed" | "claimed_elsewhere" | "has_plan" | "exhausted" | "not_admin" | "failed" | …). */
  "free_credits_claimed",
  /** The on-page card form was asked for. props: outcome ("ok" | "has_plan" | "error"). */
  "payment_form_opened",
  /** Business details for invoices were saved. props: has_tax_id, country, outcome ("ok" | "tax_id_invalid" | "error"). */
  "invoice_details_saved",
  /** A promotion code was checked (never the code itself). props: credits, outcome ("ok" | "no_discount" | "invalid" | "error" | "free_credits" | "free_credits_closed"). */
  "discount_checked",
  /** A saved card was charged for the first plan. props: credits, auto_top_up, discount, outcome ("ok" | "card_step" | "pending" | "has_plan" | "card_not_saved" | "invalid" | "not_admin" | "failed" | "unknown"). */
  "payment_completed",

  // ---- Billing ----
  /** A plan or credits were chosen. props: kind ("plan" | "top_up"), plan, credits, auto_top_up (joining from Settings: whether it was left on), route ("confirm" | "stripe" | "charged"), outcome ("ok" | "invalid" | "not_admin" | "same_plan" | "needs_plan" | "checkout_failed" | "error"). */
  "purchase_started",
  /** A purchase was confirmed on the confirm page. props: kind, plan, credits, route ("stripe" | "charged" | "repeated": confirmed before, not charged again), outcome (as purchase_started, or "stale": a page from before purchase ids). */
  "purchase_confirmed",
  /** Stripe's billing portal was opened. props: outcome ("ok" | "error"). */
  "billing_portal_opened",
  /** Auto top-up was changed. props: enabled, quantity, monthly_limit_usd (null: no limit), outcome ("ok" | "error"). */
  "auto_top_up_saved",
  /** Someone came back from Stripe (Checkout, a card step or the portal). props: had_plan, had_paid_plan, plan_now (enum), outcome ("first_plan" | "paid" | "unchanged" | "pending"). */
  "billing_returned",
  /** Auto top-up charged a card (or failed to), from the billing webhook. props: credits_added, amount_minor, currency, outcome ("ok" | "card" | "limit"). */
  "auto_top_up_charged",

  // ---- Product ----
  /** "Deep scan" or "Scan again" was pressed. props: repo_id, scan_id, credits, scan_again, outcome ("ok" | "not_installed" | "running" | "too_large" | "no_plan" | "out_of_credits" | "error" | "no_access"). */
  "deep_scan_requested",
  /** The hacker's look was saved. props: outcome. */
  "hacker_saved",
  /** An account's settings were saved. props: check_threshold, email_notifications, or pr_reviews_default and repos_changed (the review default), outcome ("ok" | "not_admin"). */
  "org_settings_saved",
  /** A repository's review settings were saved. org_id set. props: repo_id, pr_reviews ("auto" | "command" | "off"), deep_scan_schedule ("off" | "daily" | "weekly" | "monthly"), outcome ("ok" | "no_access" | "invalid"). */
  "repo_settings_saved",
  /** "Review" was pressed on a pull request in the dashboard. org_id set. props: repo_id, credits, scan_id, step ("quote" | "start"), outcome ("ok" | "no_access" | "reviews_off" | "not_open" | "reviewed" | "no_plan" | "out_of_credits" | "error"). */
  "pr_review_requested",
  /** A scheduled deep scan came due. org_id set. props: repo_id, schedule, scan_id, outcome ("ok" | "unchanged": nothing changed since the last deep scan | "running" | "no_plan" | "out_of_credits" | "too_large" | "not_installed" | "error"). */
  "scheduled_deep_scan",
  /** The findings list was copied out or opened in a coding agent. props: format ("prompt" | "claude" | "codex" copied for an agent; "open_t3" | "open_claude" | "open_codex" | "open_cursor" opened in one; "markdown" | "json"), status, findings (how many), repos (how many; documents only), filtered (a severity or repository filter was on), low_confidence. */
  "findings_copied",

  // ---- Team ----
  /** An admin invited someone (or sent an invite again). org_id set. props: kind ("email" | "github"), role, resend, emailed, outcome ("ok" | "not_admin" | "invalid" | "no_such_user" | "already_member" | "self" | "limited" | "error"). */
  "team_invite_sent",
  /** An admin revoked a pending invite. org_id set. props: outcome ("ok" | "not_found"). */
  "team_invite_revoked",
  /** An invite was accepted (or refused). org_id set when known. props: kind, outcome ("ok" | "not_found" | "expired" | "wrong_person" | "inviter_gone" | "no_installation" | "github_error" | "signed_out" | "limited"). */
  "team_invite_accepted",
  /** An admin removed an invited member, or a member left. org_id set. props: self (left on their own), outcome ("ok" | "not_found"). */
  "team_member_removed",
  /** An admin changed an invited person's role. org_id set. props: role ("member" | "admin"), self, outcome ("ok" | "not_found"). */
  "team_role_changed",

  // ---- Agents ----
  /** An agent was connected: a device code or an MCP client's consent was approved (or denied). props: method ("device" | "oauth"), outcome ("ok" | "denied" | "expired" | "invalid"). */
  "agent_authorized",
  /** An API key was created or revoked, or an agent's tokens were revoked. props: via ("settings" | "api"), kind ("key" | "oauth"), outcome. */
  "api_key_created",
  "api_key_revoked",
  /** An agent changed something through the API or MCP. props: operation (the tool's name), surface ("api" | "mcp"), status (HTTP status). */
  "agent_call",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];
export type EventProps = Record<string, string | number | boolean | null>;

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /**
     * The browser's anonymous id (the `sc_aid` cookie), when the event came
     * from one. Ties visits before sign-in to the person: `signed_in` carries
     * both ids.
     */
    anonId: uuid("anon_id"),
    name: text("name", { enum: EVENT_NAMES }).notNull(),
    props: jsonb("props").$type<EventProps>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index("events_name_created_idx").on(table.name, table.createdAt),
    index("events_user_created_idx").on(table.userId, table.createdAt),
    index("events_anon_created_idx").on(table.anonId, table.createdAt),
    index("events_org_created_idx").on(table.orgId, table.createdAt),
    // One link per browser and person, however many pages or server instances record it.
    uniqueIndex("events_identified_unique").on(table.anonId, table.userId).where(sql`${table.name} = 'identified'`),
    // One visit per person per day, however many pages or server instances record it.
    uniqueIndex("events_daily_visit_unique")
      .on(table.userId, sql`((${table.createdAt} at time zone 'UTC')::date)`)
      .where(sql`${table.name} = 'dashboard_visit'`),
  ],
);

// ---- CVE directory ---------------------------------------------------------
// Known vulnerabilities (OSV advisories) matched against each repository's
// dependency inventory. Advisories are public data; inventories hold package
// names, versions and import locations, never code.

export const ADVISORY_SEVERITIES = ["critical", "high", "medium", "low", "unknown"] as const;
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number];

/** One OSV record that has matched a dependency at least once. Refreshed when OSV changes it. */
export const advisories = pgTable(
  "advisories",
  {
    /** OSV id: GHSA-…, PYSEC-…, GO-…, RUSTSEC-…, MAL-…. */
    id: text("id").primaryKey(),
    /**
     * The vulnerability this record describes, shared by every record of it (OSV often holds a GHSA and a
     * PYSEC or GO record for one bug): its lowest CVE id, else its GHSA id, else its own id.
     */
    vulnKey: text("vuln_key").notNull(),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    summary: text("summary").notNull(),
    details: text("details").notNull(),
    severity: text("severity", { enum: ADVISORY_SEVERITIES }).notNull(),
    /** CVSS 3 base score, when OSV gives a vector (or a GHSA alias does). */
    score: real("score"),
    vector: text("vector"),
    malicious: boolean("malicious").notNull().default(false),
    /** Affected packages and version ranges: [{ ecosystem, name, ranges: [{ introduced, fixed, lastAffected }] }]. */
    affected: jsonb("affected").$type<Array<{ ecosystem: string; name: string; ranges: Array<{ introduced?: string; fixed?: string; lastAffected?: string }> }>>().notNull(),
    references: jsonb("references").$type<Array<{ type: string; url: string }>>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    modifiedAt: timestamp("modified_at", { withTimezone: true }).notNull(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("advisories_vuln_key_idx").on(table.vulnKey), index("advisories_aliases_idx").using("gin", table.aliases)],
);

export const DEPENDENCY_USAGES = ["product", "tooling", "none", "unknown"] as const;
export type DependencyUsage = (typeof DEPENDENCY_USAGES)[number];

/** What a repository's default branch installs, as of its last inventory. Replaced whole each time. */
export const repoDependencies = pgTable(
  "repo_dependencies",
  {
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    ecosystem: text("ecosystem").notNull(),
    name: text("name").notNull(),
    /** The name as advisories are matched on (lowercase; PyPI normalised). */
    packageKey: text("package_key").notNull(),
    version: text("version").notNull(),
    /** The lockfile or manifest the version was read from. */
    manifest: text("manifest").notNull(),
    direct: boolean("direct").notNull(),
    dev: boolean("dev").notNull(),
    /** product: imported by shipped code; tooling: only by tests or config; none: imported by no code; unknown: imports not traced. */
    usage: text("usage", { enum: DEPENDENCY_USAGES }).notNull(),
    /** The version is a manifest range's floor (no lockfile was read), so what is installed may be newer. */
    approximate: boolean("approximate").notNull().default(false),
    /** Up to ten `file:line` import sites, shipped code first. */
    importedAt: text("imported_at").array().notNull().default(sql`'{}'::text[]`),
  },
  (table) => [
    primaryKey({ columns: [table.repoId, table.ecosystem, table.name, table.version] }),
    // A changed advisory's question: which repositories install this package?
    index("repo_dependencies_package_idx").on(table.ecosystem, table.packageKey),
  ],
);

/** When each repository's inventory was read and last checked against OSV. */
export const repoInventories = pgTable(
  "repo_inventories",
  {
    repoId: uuid("repo_id")
      .primaryKey()
      .references(() => repos.id, { onDelete: "cascade" }),
    /** The commit the inventory was read from. Null until the first one. */
    commitSha: text("commit_sha"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    dependencies: integer("dependencies").notNull().default(0),
    /** Last time every package was checked against OSV. */
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    /** A push changed a manifest or lockfile: the inventory needs reading again. */
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    /** A refresh holds the repository while it reads the inventory. */
    runningSince: timestamp("running_since", { withTimezone: true }),
    /** Why the last refresh failed, if it did. */
    error: text("error"),
    /** Refreshes failed in a row since the last one that worked; each waits twice as long before the next try. */
    failures: integer("failures").notNull().default(0),
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (table) => [
    index("repo_inventories_checked_idx").on(table.checkedAt),
    index("repo_inventories_requested_idx").on(table.requestedAt).where(sql`${table.requestedAt} is not null`),
  ],
);

/** An advisory affecting a version a repository installs. Resolved when the version goes or the advisory stops applying. */
export const repoAdvisories = pgTable(
  "repo_advisories",
  {
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    advisoryId: text("advisory_id")
      .notNull()
      .references(() => advisories.id, { onDelete: "cascade" }),
    ecosystem: text("ecosystem").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null while the repository is affected. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** How the match first appeared: an advisory published or changed after the inventory (`feed`), or reading the inventory (`inventory`). */
    origin: text("origin", { enum: ["feed", "inventory"] }).notNull(),
    /** Set once the people with access were emailed about it. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.repoId, table.advisoryId, table.ecosystem, table.name, table.version] }),
    index("repo_advisories_open_idx").on(table.repoId).where(sql`${table.resolvedAt} is null`),
    index("repo_advisories_advisory_idx").on(table.advisoryId),
  ],
);

/** How far each ecosystem's OSV change feed has been read. */
export const advisoryFeeds = pgTable("advisory_feeds", {
  ecosystem: text("ecosystem").primaryKey(),
  /** The newest change already handled (ms since the epoch, as text: OSV stamps are finer than Postgres keeps). */
  cursor: text("cursor").notNull(),
  /** `id@modified` of the changes already handled within the overlap behind the cursor, so a re-read skips them. */
  handled: jsonb("handled").$type<string[]>().notNull().default([]),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgRelations = relations(orgs, ({ many }) => ({ repos: many(repos) }));
export const repoRelations = relations(repos, ({ one, many }) => ({ org: one(orgs, { fields: [repos.orgId], references: [orgs.id] }), scans: many(scans) }));
export const scanRelations = relations(scans, ({ one }) => ({ repo: one(repos, { fields: [scans.repoId], references: [repos.id] }) }));
