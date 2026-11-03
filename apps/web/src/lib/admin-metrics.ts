/**
 * The arithmetic behind the operator dashboards, kept apart from the queries
 * so it can be tested on its own. Rates are null when there is nothing to
 * divide by, so the page can say so instead of showing 0%.
 */
import { CREDIT_PRICE, isTrial, PLANS, type Plan } from "@sandchest/billing/plans";
import type { AdminRange, DailyScans, FindingTally, Funnel, KindCost, PlanCost, ScanTally } from "@sandchest/db";

/** The ranges offered, in days (the same as the queries accept). */
export const ADMIN_RANGES: readonly AdminRange[] = [7, 30, 90];

export type Rate = number | null;

/** The range asked for in the URL (`?range=7`), or 30 days. */
export function parseRange(value: string | string[] | undefined): AdminRange {
  const days = Number(Array.isArray(value) ? value[0] : value);
  return (ADMIN_RANGES as readonly number[]).includes(days) ? (days as AdminRange) : 30;
}

export function ratio(part: number, whole: number): Rate {
  return whole > 0 ? part / whole : null;
}

/** The `days` UTC dates ending today, oldest first, as YYYY-MM-DD. */
export function lastDays(days: number, now = new Date()): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** One value per day, zero where a day has no rows. */
export function perDay<T extends { day: string }>(days: string[], rows: T[], value: (row: T) => number): number[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.day, (totals.get(row.day) ?? 0) + value(row));
  return days.map((day) => totals.get(day) ?? 0);
}

// ---- Quality -----------------------------------------------------------------

/** Kinds whose candidates and survivors mean "reported by hunters" and "kept by the skeptic". */
export const HUNTING_KINDS = ["deep", "pr_review"] as const;

export interface Survival {
  kind: (typeof HUNTING_KINDS)[number];
  candidates: number;
  survivors: number;
  rate: Rate;
}

/** Candidates against survivors for deep scans and PR reviews, and both together. */
export function survival(tallies: ScanTally[]): { byKind: Survival[]; total: { candidates: number; survivors: number; rate: Rate } } {
  const byKind = HUNTING_KINDS.map((kind) => {
    const rows = tallies.filter((row) => row.kind === kind);
    const candidates = sum(rows, (row) => row.candidates);
    const survivors = sum(rows, (row) => row.survivors);
    return { kind, candidates, survivors, rate: ratio(survivors, candidates) };
  });
  const candidates = sum(byKind, (row) => row.candidates);
  const survivors = sum(byKind, (row) => row.survivors);
  return { byKind, total: { candidates, survivors, rate: ratio(survivors, candidates) } };
}

export interface Outcomes {
  /** Findings people are shown (confidence above low). */
  shown: number;
  open: number;
  fixedAuto: number;
  fixedManual: number;
  falsePositive: number;
  dismissedOther: number;
  promptCopied: number;
  /** Findings someone (or a fix check) has ruled on: fixed or dismissed. Open findings are not yet judged. */
  reviewed: number;
  /** Dismissed as false positive, of findings reviewed. */
  falsePositiveRate: Rate;
  /** 1 - false positive rate: production precision, over reviewed findings only. */
  precision: Rate;
  fixRate: Rate;
  /** Of fixed findings, the share a fix check caught. */
  autoFixShare: Rate;
  promptCopyRate: Rate;
}

/** Where the findings people were shown stand now. Low confidence is hidden by default, so it is left out. */
export function outcomes(tallies: FindingTally[]): Outcomes {
  const shown = tallies.filter((row) => row.confidence !== "low");
  const total = sum(shown, (row) => row.total);
  const fixedAuto = sum(shown, (row) => row.fixedAuto);
  const fixedManual = sum(shown, (row) => row.fixedManual);
  const falsePositive = sum(shown, (row) => row.falsePositive);
  const promptCopied = sum(shown, (row) => row.promptCopied);
  const dismissedOther = sum(shown, (row) => row.dismissedOther);
  // Open findings have not been judged either way, so they count neither for nor against precision.
  const reviewed = fixedAuto + fixedManual + falsePositive + dismissedOther;
  const falsePositiveRate = ratio(falsePositive, reviewed);
  return {
    shown: total,
    open: sum(shown, (row) => row.open),
    fixedAuto,
    fixedManual,
    falsePositive,
    dismissedOther,
    promptCopied,
    reviewed,
    falsePositiveRate,
    precision: falsePositiveRate === null ? null : 1 - falsePositiveRate,
    fixRate: ratio(fixedAuto + fixedManual, total),
    autoFixShare: ratio(fixedAuto, fixedAuto + fixedManual),
    promptCopyRate: ratio(promptCopied, total),
  };
}

// ---- Cost --------------------------------------------------------------------

export interface KindSummary {
  kind: KindCost["kind"];
  scans: number;
  /** Per measured scan. */
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  cachedShare: Rate;
  avgCostUsd: number | null;
  totalCostUsd: number;
  duration: KindCost["duration"];
}

export function kindSummary(row: KindCost): KindSummary {
  const per = (value: number) => (row.measured > 0 ? value / row.measured : null);
  return {
    kind: row.kind,
    scans: row.scans,
    avgInputTokens: per(row.inputTokens),
    avgOutputTokens: per(row.outputTokens),
    cachedShare: ratio(row.cachedTokens, row.inputTokens),
    avgCostUsd: per(row.modelCostUsd),
    totalCostUsd: row.modelCostUsd,
    duration: row.duration,
  };
}

/**
 * Model cost per credit charged: from the scans that held credits alone (not free deep scans), and all in
 * (every scan's cost, free recon and fix checks included, over the same credits).
 */
export function costPerCredit(total: KindCost | undefined): { paid: Rate; allIn: Rate } {
  if (!total) return { paid: null, allIn: null };
  return { paid: ratio(total.chargedModelCostUsd, total.creditsCharged), allIn: ratio(total.modelCostUsd + total.computeCostUsd, total.creditsCharged) };
}

export interface PlanMargin {
  plan: Plan;
  orgs: number;
  creditsCharged: number;
  /** List price of a credit: the plan's monthly credits, or bought ones on a plan without any. */
  revenuePerCredit: number;
  costPerCredit: Rate;
  /** 1 - cost per credit / revenue per credit. */
  margin: Rate;
}

/**
 * Margin per plan: what a credit sells for on the plan, against the model
 * (and compute) cost of every scan its orgs ran per credit charged.
 */
export function planMargins(costs: PlanCost[], plans: readonly Plan[] = PLANS): PlanMargin[] {
  return plans.map((plan) => {
    const row = costs.find((cost) => cost.planId === plan.id);
    // Free credits bring in nothing: their margin is not a number worth showing.
    const revenuePerCredit = isTrial(plan.id) ? 0 : plan.credits > 0 ? plan.price / plan.credits : CREDIT_PRICE;
    const cost = row ? ratio(row.modelCostUsd + row.computeCostUsd, row.creditsCharged) : null;
    return {
      plan,
      orgs: row?.orgs ?? 0,
      creditsCharged: row?.creditsCharged ?? 0,
      revenuePerCredit,
      costPerCredit: cost,
      margin: cost === null || revenuePerCredit === 0 ? null : 1 - cost / revenuePerCredit,
    };
  });
}

/** Scans per day for one kind, and failures per day for all kinds. */
export function dailySeries(days: string[], rows: DailyScans[]) {
  return {
    cost: perDay(days, rows, (row) => row.modelCostUsd),
    failed: perDay(days, rows, (row) => row.failed),
    byKind: (kind: DailyScans["kind"]) =>
      perDay(
        days,
        rows.filter((row) => row.kind === kind),
        (row) => row.scans,
      ),
  };
}

// ---- Funnel ------------------------------------------------------------------

export interface FunnelStep {
  label: string;
  count: number;
  /** Of the step before. */
  fromPrevious: Rate;
  /** Of everyone who signed up. */
  fromStart: Rate;
}

/** The funnel's steps in order. Without billing (a null plan count) there is no plan step. */
export function funnelSteps(funnel: Funnel): FunnelStep[] {
  const steps: Array<[string, number]> = [
    ["Signed up", funnel.signedUp],
    ["Installed the App", funnel.installed],
    ...(funnel.plan === null ? [] : [["Chose a plan", funnel.plan] as [string, number]]),
    ["Recon finished", funnel.recon],
    ["Started a deep scan", funnel.dig],
    ["Back in the last 30 days", funnel.active30],
    ["Back in the last 7 days", funnel.active7],
  ];
  return steps.map(([label, count], i) => ({
    label,
    count,
    fromPrevious: i === 0 ? null : ratio(count, steps[i - 1]![1]),
    fromStart: ratio(count, funnel.signedUp),
  }));
}

function sum<T>(rows: T[], value: (row: T) => number): number {
  return rows.reduce((total, row) => total + value(row), 0);
}
