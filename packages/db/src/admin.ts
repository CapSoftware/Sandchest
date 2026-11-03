/**
 * Operator dashboards (SPEC §13 Admin, §15): quality, cost and the signup
 * funnel, read straight from scans, metrics, findings and their events.
 * Every function is one aggregate statement, so a page runs them all in one
 * parallel wave. Nothing here returns code, finding text, names or emails:
 * only counts, sums, enums and dates.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { events, findingEvents, findings, orgAdmins, orgBilling, orgs, permissionCache, repos, scanMetrics, scans, users, type EventName, type EventProps } from "./schema";

/** The time ranges the dashboards offer, in days. */
export const ADMIN_RANGES = [7, 30, 90] as const;
export type AdminRange = (typeof ADMIN_RANGES)[number];

type Kind = (typeof scans.$inferSelect)["kind"];
type Status = (typeof scans.$inferSelect)["status"];
type Severity = (typeof findings.$inferSelect)["severity"];
type Confidence = (typeof findings.$inferSelect)["confidence"];

/** The start of a range: midnight UTC, `days - 1` days ago, so a range is whole UTC days ending today. */
const since = (days: AdminRange) => sql`(((now() at time zone 'UTC')::date - ${days - 1}::int)::timestamp at time zone 'UTC')`;
/** A UTC calendar day as YYYY-MM-DD. */
const utcDay = (column: unknown) => sql`to_char((${column} at time zone 'UTC')::date, 'YYYY-MM-DD')`;

// ---- Recording ---------------------------------------------------------------

export interface AnalyticsEvent {
  name: EventName;
  userId?: string | null;
  orgId?: string | null;
  /** The browser's anonymous id, when the event came from one. */
  anonId?: string | null;
  props?: EventProps;
}

/**
 * Analytics writes give way to everything else: a write that would wait on a
 * lock for more than LOCK_MS, or run for more than STATEMENT_MS, is dropped
 * rather than hold a connection the app needs. Set per transaction, so it
 * works behind a transaction-mode pooler and never leaks to other queries.
 */
const STATEMENT_MS = 1_000;
const LOCK_MS = 200;

/** At most this many events in one insert (the beacon sends a page's worth at a time). */
export const MAX_EVENTS_PER_WRITE = 50;

/**
 * Records analytics events in one bounded insert. `props` must hold only
 * opaque ids, counts and enums. `ignoreDuplicates` skips events a unique index
 * already has (daily visits, browser links).
 */
export async function recordEvents(database: Db, list: AnalyticsEvent[], options: { ignoreDuplicates?: boolean } = {}): Promise<void> {
  const rows = list.slice(0, MAX_EVENTS_PER_WRITE).map((event) => ({
    name: event.name,
    userId: event.userId ?? null,
    orgId: event.orgId ?? null,
    anonId: event.anonId ?? null,
    props: event.props ?? {},
  }));
  if (rows.length === 0) return;
  await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', ${String(STATEMENT_MS)}, true), set_config('lock_timeout', ${String(LOCK_MS)}, true)`);
    const insert = tx.insert(events).values(rows);
    await (options.ignoreDuplicates ? insert.onConflictDoNothing() : insert);
  });
}

/** Records one analytics event (see `recordEvents`). */
export async function recordEvent(database: Db, event: AnalyticsEvent): Promise<void> {
  await recordEvents(database, [event]);
}

/** Records that someone opened the dashboard today (UTC). A second call the same day changes nothing. */
export async function recordDailyVisit(database: Db, userId: string, anonId?: string | null): Promise<void> {
  await recordEvents(database, [{ name: "dashboard_visit", userId, anonId }], { ignoreDuplicates: true });
}

/** Ties a browser to the signed-in person using it. Recorded once per browser and person. */
export async function recordIdentified(database: Db, userId: string, anonId: string): Promise<void> {
  await recordEvents(database, [{ name: "identified", userId, anonId }], { ignoreDuplicates: true });
}

// ---- Quality -----------------------------------------------------------------

export interface ScanTally {
  kind: Kind;
  status: Status;
  scans: number;
  /** Candidates the hunters reported and those that survived the skeptic (deep scans and PR reviews). */
  candidates: number;
  survivors: number;
}

/** Scans started in the range, by kind and status, with candidates and survivors. */
export async function adminScanTallies(database: Db, days: AdminRange): Promise<ScanTally[]> {
  const rows = await database.execute<{ kind: Kind; status: Status; scans: number; candidates: number; survivors: number }>(sql`
    select s.kind, s.status, count(*)::int as scans,
      coalesce(sum(m.candidates), 0)::int as candidates, coalesce(sum(m.survivors), 0)::int as survivors
    from ${scans} s
    left join ${scanMetrics} m on m.scan_id = s.id
    where s.created_at >= ${since(days)}
    group by s.kind, s.status
  `);
  return [...rows];
}

export interface FindingTally {
  severity: Severity;
  confidence: Confidence;
  total: number;
  open: number;
  /** Fixed, most recently by a fix check. */
  fixedAuto: number;
  /** Fixed, most recently by a person. */
  fixedManual: number;
  falsePositive: number;
  /** Dismissed as accepted risk or won't fix. */
  dismissedOther: number;
  /** Findings whose fix prompt someone took at least once. */
  promptCopied: number;
}

/** Findings first seen in the range, by severity and confidence, with where each stands now. */
export async function adminFindingTallies(database: Db, days: AdminRange): Promise<FindingTally[]> {
  const rows = await database.execute<{
    severity: Severity;
    confidence: Confidence;
    total: number;
    open: number;
    fixed_auto: number;
    fixed_manual: number;
    false_positive: number;
    dismissed_other: number;
    prompt_copied: number;
  }>(sql`
    with cohort as (
      select id, severity, confidence, status, dismiss_reason from ${findings} where first_seen_at >= ${since(days)}
    ),
    -- One pass over the cohort's fix and prompt events (by type, so "seen" rows are never read).
    took as (
      select e.finding_id,
        bool_or(e.type = 'prompt_copied') as copied,
        -- Who fixed it last: a fix check (with a scan) or a person.
        (array_agg(e.scan_id is not null order by e.id desc) filter (where e.type = 'fixed'))[1] as auto
      from ${findingEvents} e
      join cohort c on c.id = e.finding_id
      where e.type in ('prompt_copied', 'fixed')
      group by e.finding_id
    )
    select c.severity, c.confidence, count(*)::int as total,
      count(*) filter (where c.status = 'open')::int as open,
      count(*) filter (where c.status = 'fixed' and t.auto)::int as fixed_auto,
      count(*) filter (where c.status = 'fixed' and not coalesce(t.auto, false))::int as fixed_manual,
      count(*) filter (where c.status = 'dismissed' and c.dismiss_reason = 'false_positive')::int as false_positive,
      count(*) filter (where c.status = 'dismissed' and c.dismiss_reason is distinct from 'false_positive')::int as dismissed_other,
      count(*) filter (where t.copied)::int as prompt_copied
    from cohort c
    left join took t on t.finding_id = c.id
    group by c.severity, c.confidence
  `);
  return rows.map((row) => ({
    severity: row.severity,
    confidence: row.confidence,
    total: row.total,
    open: row.open,
    fixedAuto: row.fixed_auto,
    fixedManual: row.fixed_manual,
    falsePositive: row.false_positive,
    dismissedOther: row.dismissed_other,
    promptCopied: row.prompt_copied,
  }));
}

export interface FindingActivity {
  type: "fixed" | "dismissed" | "reopened" | "prompt_copied";
  /** True for fix checks; false for people. */
  auto: boolean;
  events: number;
  findings: number;
}

/** What happened to findings during the range, whenever they were found: fixes, dismissals, reopens and prompt copies. */
export async function adminFindingActivity(database: Db, days: AdminRange): Promise<FindingActivity[]> {
  const rows = await database.execute<FindingActivity & Record<string, unknown>>(sql`
    select e.type, e.scan_id is not null as auto, count(*)::int as events, count(distinct e.finding_id)::int as findings
    from ${findingEvents} e
    where e.created_at >= ${since(days)} and e.type in ('fixed', 'dismissed', 'reopened', 'prompt_copied')
    group by 1, 2
  `);
  return [...rows];
}

// ---- Cost --------------------------------------------------------------------

export interface KindCost {
  /** Null for the total across kinds. */
  kind: Kind | null;
  scans: number;
  /** Scans that reported usage. */
  measured: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  modelCostUsd: number;
  computeCostUsd: number;
  /** Duration percentiles of measured scans, in milliseconds; null without any. */
  duration: { p50: number; p90: number; p99: number } | null;
  /** Credits charged for scans that were billed, and the model cost of those scans alone. */
  creditsCharged: number;
  chargedModelCostUsd: number;
}

/** Usage, cost and duration per scan kind for scans started in the range, plus a total row. */
export async function adminCostByKind(database: Db, days: AdminRange): Promise<KindCost[]> {
  const rows = await database.execute<{
    kind: Kind | null;
    scans: number;
    measured: number;
    input_tokens: number;
    cached_tokens: number;
    output_tokens: number;
    model_cost_usd: number;
    compute_cost_usd: number;
    duration: number[] | null;
    credits_charged: number;
    charged_model_cost_usd: number;
  }>(sql`
    select s.kind, count(*)::int as scans, count(m.scan_id)::int as measured,
      coalesce(sum(m.input_tokens), 0)::float8 as input_tokens,
      coalesce(sum(m.cached_tokens), 0)::float8 as cached_tokens,
      coalesce(sum(m.output_tokens), 0)::float8 as output_tokens,
      coalesce(sum(m.model_cost_usd), 0)::float8 as model_cost_usd,
      coalesce(sum(m.compute_cost_usd), 0)::float8 as compute_cost_usd,
      percentile_cont(array[0.5, 0.9, 0.99]) within group (order by m.duration_ms) as duration,
      coalesce(sum(s.credits) filter (where s.billing = 'charged' and s.credits_reserved > 0), 0)::int as credits_charged,
      coalesce(sum(m.model_cost_usd) filter (where s.billing = 'charged' and s.credits_reserved > 0), 0)::float8 as charged_model_cost_usd
    from ${scans} s
    left join ${scanMetrics} m on m.scan_id = s.id
    where s.created_at >= ${since(days)}
    group by grouping sets ((s.kind), ())
  `);
  return rows.map((row) => ({
    kind: row.kind,
    scans: row.scans,
    measured: row.measured,
    inputTokens: row.input_tokens,
    cachedTokens: row.cached_tokens,
    outputTokens: row.output_tokens,
    modelCostUsd: row.model_cost_usd,
    computeCostUsd: row.compute_cost_usd,
    duration: row.duration ? { p50: row.duration[0]!, p90: row.duration[1]!, p99: row.duration[2]! } : null,
    creditsCharged: row.credits_charged,
    chargedModelCostUsd: row.charged_model_cost_usd,
  }));
}

export interface DailyScans {
  day: string;
  kind: Kind;
  scans: number;
  failed: number;
  modelCostUsd: number;
}

/** Scans and their model cost per UTC day and kind. Days without scans are absent. */
export async function adminDailyScans(database: Db, days: AdminRange): Promise<DailyScans[]> {
  const rows = await database.execute<{ day: string; kind: Kind; scans: number; failed: number; model_cost_usd: number }>(sql`
    select ${utcDay(sql`s.created_at`)} as day, s.kind, count(*)::int as scans,
      count(*) filter (where s.status = 'failed')::int as failed,
      coalesce(sum(m.model_cost_usd), 0)::float8 as model_cost_usd
    from ${scans} s
    left join ${scanMetrics} m on m.scan_id = s.id
    where s.created_at >= ${since(days)}
    group by 1, 2
  `);
  return rows.map((row) => ({ day: row.day, kind: row.kind, scans: row.scans, failed: row.failed, modelCostUsd: row.model_cost_usd }));
}

export interface PlanCost {
  /** The org's plan now; null without one. */
  planId: string | null;
  orgs: number;
  scans: number;
  creditsCharged: number;
  /** Model cost of the scans that were charged. */
  chargedModelCostUsd: number;
  /** Model cost of every scan, free recon and fix checks included. */
  modelCostUsd: number;
  computeCostUsd: number;
}

/** Credits charged and model cost for scans started in the range, by each org's current plan. */
export async function adminPlanCosts(database: Db, days: AdminRange): Promise<PlanCost[]> {
  const rows = await database.execute<{
    plan_id: string | null;
    orgs: number;
    scans: number;
    credits_charged: number;
    charged_model_cost_usd: number;
    model_cost_usd: number;
    compute_cost_usd: number;
  }>(sql`
    select ob.plan_id, count(distinct s.org_id)::int as orgs, count(*)::int as scans,
      coalesce(sum(s.credits) filter (where s.billing = 'charged' and s.credits_reserved > 0), 0)::int as credits_charged,
      coalesce(sum(m.model_cost_usd) filter (where s.billing = 'charged' and s.credits_reserved > 0), 0)::float8 as charged_model_cost_usd,
      coalesce(sum(m.model_cost_usd), 0)::float8 as model_cost_usd,
      coalesce(sum(m.compute_cost_usd), 0)::float8 as compute_cost_usd
    from ${scans} s
    left join ${scanMetrics} m on m.scan_id = s.id
    left join ${orgBilling} ob on ob.org_id = s.org_id
    where s.created_at >= ${since(days)}
    group by ob.plan_id
  `);
  return rows.map((row) => ({
    planId: row.plan_id,
    orgs: row.orgs,
    scans: row.scans,
    creditsCharged: row.credits_charged,
    chargedModelCostUsd: row.charged_model_cost_usd,
    modelCostUsd: row.model_cost_usd,
    computeCostUsd: row.compute_cost_usd,
  }));
}

// ---- Funnel ------------------------------------------------------------------

export interface Funnel {
  signedUp: number;
  /** Can see an account with the App installed. */
  installed: number;
  /** ...with a plan. Null when billing is off (self-hosted), where there are no plans and recon starts at install. */
  plan: number | null;
  /** ...whose recon finished. */
  recon: number;
  /** ...and someone started a deep scan by hand. */
  dig: number;
  /** ...and came back to the dashboard on a later day, within the last 30 or 7 days. */
  active30: number;
  active7: number;
}

/**
 * People who signed up in the range and how far they got. Each step counts
 * only people who reached every step before it, on the same account. With
 * billing off there is no plan step: recon and dig follow from install.
 */
export async function adminFunnel(database: Db, days: AdminRange, options: { billing: boolean }): Promise<Funnel> {
  const [row] = await database.execute<{ signed_up: number; installed: number; plan: number; recon: number; dig: number; active30: number; active7: number }>(sql`
    with cohort as (
      select u.id, u.created_at from ${users} u where u.created_at >= ${since(days)}
    ),
    links as (
      select oa.user_id, oa.org_id from ${orgAdmins} oa join cohort c on c.id = oa.user_id
      union
      select pc.user_id, r.org_id from ${permissionCache} pc join ${repos} r on r.id = pc.repo_id join cohort c on c.id = pc.user_id
    ),
    org_steps as (
      select o.id,
        (${!options.billing}::boolean or ob.activated_at is not null) as plan,
        exists (select 1 from ${scans} s where s.org_id = o.id and s.kind = 'recon' and s.status = 'completed') as recon,
        exists (select 1 from ${scans} s where s.org_id = o.id and s.kind = 'deep' and s.trigger = 'manual' and s.status not in ('refused', 'cancelled')) as dig
      from ${orgs} o
      left join ${orgBilling} ob on ob.org_id = o.id
      where o.installation_id is not null and o.id in (select org_id from links)
    ),
    people as (
      select c.id,
        count(os.id) > 0 as installed,
        coalesce(bool_or(os.plan), false) as plan,
        coalesce(bool_or(os.plan and os.recon), false) as recon,
        coalesce(bool_or(os.plan and os.recon and os.dig), false) as dig,
        (select max(e.created_at) from ${events} e
          where e.user_id = c.id and e.name = 'dashboard_visit'
            and (e.created_at at time zone 'UTC')::date > (c.created_at at time zone 'UTC')::date) as returned_at
      from cohort c
      left join links l on l.user_id = c.id
      left join org_steps os on os.id = l.org_id
      group by c.id, c.created_at
    )
    select count(*)::int as signed_up,
      count(*) filter (where installed)::int as installed,
      count(*) filter (where plan)::int as plan,
      count(*) filter (where recon)::int as recon,
      count(*) filter (where dig)::int as dig,
      count(*) filter (where dig and returned_at >= now() - interval '30 days')::int as active30,
      count(*) filter (where dig and returned_at >= now() - interval '7 days')::int as active7
    from people
  `);
  return {
    signedUp: row?.signed_up ?? 0,
    installed: row?.installed ?? 0,
    plan: options.billing ? (row?.plan ?? 0) : null,
    recon: row?.recon ?? 0,
    dig: row?.dig ?? 0,
    active30: row?.active30 ?? 0,
    active7: row?.active7 ?? 0,
  };
}

export interface Activity {
  people: number;
  /** Distinct people who opened the dashboard in the last 7 and 30 days. */
  people7: number;
  people30: number;
  /** Installed accounts, those with a plan, and those with a scan in the last 7 and 30 days. */
  orgs: number;
  paying: number;
  orgs7: number;
  orgs30: number;
}

/** Who is around now, whatever the range. */
export async function adminActivity(database: Db): Promise<Activity> {
  const [row] = await database.execute<{ people: number; people7: number; people30: number; orgs: number; paying: number; orgs7: number; orgs30: number }>(sql`
    with visits as (
      select user_id, max(created_at) as last from ${events}
      where name = 'dashboard_visit' and created_at >= now() - interval '30 days' group by user_id
    ),
    scanned as (
      select s.org_id, max(s.created_at) as last from ${scans} s
      join ${orgs} o on o.id = s.org_id and o.installation_id is not null
      where s.created_at >= now() - interval '30 days' and s.status <> 'refused' group by s.org_id
    )
    select (select count(*)::int from ${users}) as people,
      (select count(*)::int from visits where last >= now() - interval '7 days') as people7,
      (select count(*)::int from visits) as people30,
      (select count(*)::int from ${orgs} where installation_id is not null) as orgs,
      (select count(*)::int from ${orgBilling} ob join ${orgs} o on o.id = ob.org_id where ob.plan_id is not null and o.installation_id is not null) as paying,
      (select count(*)::int from scanned where last >= now() - interval '7 days') as orgs7,
      (select count(*)::int from scanned) as orgs30
  `);
  return row ?? { people: 0, people7: 0, people30: 0, orgs: 0, paying: 0, orgs7: 0, orgs30: 0 };
}

/** Sign-ups and sign-ins per UTC day. Days with neither are absent. */
export async function adminDailySignups(database: Db, days: AdminRange): Promise<Array<{ day: string; signups: number; signIns: number }>> {
  const rows = await database.execute<{ day: string; signups: number; sign_ins: number }>(sql`
    select day, sum(signups)::int as signups, sum(sign_ins)::int as sign_ins from (
      select ${utcDay(sql`created_at`)} as day, count(*) as signups, 0 as sign_ins from ${users} where created_at >= ${since(days)} group by 1
      union all
      select ${utcDay(sql`created_at`)} as day, 0, count(*) from ${events} where name = 'signed_in' and created_at >= ${since(days)} group by 1
    ) daily
    group by day
  `);
  return rows.map((row) => ({ day: row.day, signups: row.signups, signIns: row.sign_ins }));
}
