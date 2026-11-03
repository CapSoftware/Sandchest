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
  /** Buy `quantity` credits automatically when they run low, up to a monthly spend in USD. Unset means off. Older choices have no quantity. */
  autoTopUp?: { enabled: boolean; monthlyLimitUsd: number; quantity?: number };
  /** The org's hacker, as chosen when recruiting it. Only how the rig looks and talks; scans ignore it. */
  hacker?: HackerProfile;
  /** Who the org is, for receipts: given while recruiting, prefilled from GitHub. */
  company?: { name: string; email: string };
  /** The repository the org chose for its hacker's first Dig (a repos.id in this org). */
  firstTarget?: string;
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
   * The deep scan that used the org's free first Dig. It stays used while
   * that scan is queued, running or completed; if it failed, was refused or
   * is gone, the next Dig is free again. (No foreign key: scans point here.)
   */
  freeDigScanId: uuid("free_dig_scan_id"),
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
    // Operator dashboards read scans by when they started.
    index("scans_created_idx").on(table.createdAt),
    // A PR head is reviewed once, however many times the webhook arrives.
    uniqueIndex("scans_pr_head_unique").on(table.repoId, table.prNumber, table.headSha).where(sql`${table.kind} = 'pr_review'`),
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
  // By type and time for operator dashboards: "seen" rows, by far the most, are skipped.
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
  (table) => [primaryKey({ columns: [table.userId, table.orgId] }), index("org_admins_org_idx").on(table.orgId)],
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
  /** A plan or credits were chosen. props: kind ("plan" | "top_up"), plan, credits, route ("confirm" | "stripe" | "charged"), outcome ("ok" | "invalid" | "not_admin" | "same_plan" | "needs_plan" | "checkout_failed" | "error"). */
  "purchase_started",
  /** A purchase was confirmed on the confirm page. props: kind, plan, credits, route ("stripe" | "charged"), outcome (as purchase_started). */
  "purchase_confirmed",
  /** Stripe's billing portal was opened. props: outcome ("ok" | "error"). */
  "billing_portal_opened",
  /** Auto top-up was changed. props: enabled, quantity, monthly_limit_usd, outcome ("ok" | "error"). */
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
  /** An account's settings were saved. props: check_threshold, email_notifications, outcome ("ok" | "not_admin"). */
  "org_settings_saved",
  /** The findings list was copied out. props: format ("prompt" | "claude" | "codex" | "markdown" | "json"), status, findings (how many), repos (how many), filtered (a severity or repository filter was on), low_confidence. */
  "findings_copied",
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

export const orgRelations = relations(orgs, ({ many }) => ({ repos: many(repos) }));
export const repoRelations = relations(repos, ({ one, many }) => ({ org: one(orgs, { fields: [repos.orgId], references: [orgs.id] }), scans: many(scans) }));
export const scanRelations = relations(scans, ({ one }) => ({ repo: one(repos, { fields: [scans.repoId], references: [repos.id] }) }));
