/**
 * Billing (SPEC §12): plans and credits in Autumn, one customer per org.
 *
 * - Every paid scan reserves its credits in Autumn before it runs, and is
 *   charged when it completes, never more than was reserved (the cost shown
 *   up front). A scan that fails, is refused or never starts gives them back;
 *   an unsettled reservation also returns on its own after six hours.
 * - Free scans (recon, fix checks) only need an active plan.
 * - Pages show a copy of each org's Autumn state kept in `org_billing`,
 *   refreshed in the background once it is a minute old, so no page waits on
 *   Autumn except the first one an org ever shows.
 *
 * Without AUTUMN_SECRET_KEY (self-hosted) billing is off: nothing is gated.
 * This module stays light: pages import it, and the workflow runtime is
 * loaded only when an org's first plan starts its recon.
 */
import { autoTopUpControl, createAutumn, planById, type Autumn, type BillingState } from "@sandchest/billing";
import {
  markScanReserved,
  orgBillingRow,
  queuePendingRecons,
  saveOrgBilling,
  setOrgCredits,
  settleScan as settleScanRow,
  type OrgBillingInput,
  type OrgBillingRow,
  type OrgSettings,
} from "@sandchest/db";
import { after } from "next/server";
import { config } from "./config";
import { db } from "./db";
import { noticeCredits } from "./notices";

/** Unsettled reservations return to the org after this long (Autumn allows up to 24 hours). */
const RESERVATION_MS = 6 * 3_600_000;
/** Pages refresh billing in the background after this... */
const SOFT_TTL_MS = 60_000;
/** ...and wait for Autumn after this. */
const HARD_TTL_MS = 10 * 60_000;
/** How recent a cached plan must be for a free scan to trust it. */
const PLAN_TTL_MS = 5 * 60_000;

let instance: Autumn | null | undefined;

/** The Autumn client, or undefined when billing is off. */
export function autumn(): Autumn | undefined {
  if (instance === undefined) {
    const settings = config();
    instance = settings.AUTUMN_SECRET_KEY ? createAutumn({ secretKey: settings.AUTUMN_SECRET_KEY, baseUrl: settings.AUTUMN_BASE_URL }) : null;
  }
  return instance ?? undefined;
}

/** For tests: a fake Autumn, or undefined for billing off. */
export function setAutumn(client: Autumn | undefined): void {
  instance = client ?? null;
}

export function billingEnabled(): boolean {
  return autumn() !== undefined;
}

// ---- The org's state ---------------------------------------------------------

interface BillingOrg {
  id: string;
  githubLogin: string;
}

const syncing = new Map<string, Promise<OrgBillingRow>>();

/**
 * Reads the org's state from Autumn and stores it. Concurrent calls share one
 * read. When the plan changes, auto top-up is matched to the new plan; when
 * the org first has a plan, recon starts on its repositories.
 */
export function syncBilling(org: BillingOrg): Promise<OrgBillingRow> {
  let pending = syncing.get(org.id);
  if (!pending) {
    pending = readAndStore(org).finally(() => syncing.delete(org.id));
    syncing.set(org.id, pending);
  }
  return pending;
}

async function readAndStore(org: BillingOrg): Promise<OrgBillingRow> {
  const client = autumn()!;
  const from = new Date();
  let state = await client.customer(org.id, org.githubLogin);
  const seen = { from, to: new Date() };
  const previous = await orgBillingRow(db(), org.id);
  if (previous && previous.planId !== state.planId) state = await matchAutoTopUp(org.id, state);
  const at = new Date();
  const row = toRow(state);
  const { firstActivation, previousPlanId } = await saveOrgBilling(db(), org.id, row, at);
  if (state.planId && (firstActivation || !previousPlanId)) await startPendingRecon(org.id);
  await noticeCredits(org, row, seen).catch(logFailure("credits email"));
  return { orgId: org.id, ...row, activatedAt: previous?.activatedAt ?? (state.planId ? at : null), checkedAt: at, creditLevel: previous?.creditLevel ?? 0, creditLevelAt: previous?.creditLevelAt ?? null, creditLevelRev: previous?.creditLevelRev ?? 0 };
}

function toRow(state: BillingState): OrgBillingInput {
  return {
    planId: state.planId,
    pastDue: state.pastDue,
    endsAt: state.endsAt,
    renewsAt: state.renewsAt,
    nextPlanId: state.nextPlanId,
    credits: state.credits.remaining,
    creditsResetAt: state.credits.resetsAt,
    autoTopUp: state.autoTopUp,
  };
}

/**
 * The org's billing for a page: the stored copy while it is recent, refreshed
 * in the background once it is a minute old, read from Autumn first if it is
 * missing or older than ten minutes. Falls back to the stored copy if Autumn
 * is unreachable.
 */
export async function pageBilling<T extends { checkedAt: Date }>(org: BillingOrg, stored: T | null): Promise<T | OrgBillingRow | null> {
  if (!billingEnabled()) return stored;
  const age = stored ? Date.now() - stored.checkedAt.getTime() : Number.POSITIVE_INFINITY;
  if (age < SOFT_TTL_MS) return stored;
  if (age < HARD_TTL_MS) {
    after(() => syncBilling(org).catch(logFailure("refresh")));
    return stored;
  }
  return (await syncBilling(org).catch(logFailure("read"))) ?? stored;
}

/** Whether the org has an active plan, trusting a copy up to five minutes old. */
export async function hasPlan(org: BillingOrg): Promise<boolean> {
  if (!billingEnabled()) return true;
  const stored = await orgBillingRow(db(), org.id);
  if (stored && Date.now() - stored.checkedAt.getTime() < PLAN_TTL_MS) return stored.planId !== null;
  return (await syncBilling(org)).planId !== null;
}

/** Queues and starts recon on repositories that have none, once an org has a plan. */
export async function startPendingRecon(orgId: string): Promise<string[]> {
  const ids = await queuePendingRecons(db(), orgId);
  if (ids.length === 0) return ids;
  // Loaded on demand: pages that sync billing never trace the workflow runtime.
  const { startScan } = await import("./start");
  // A start that fails is picked up by the stranded-scan sweep.
  await Promise.allSettled(ids.map((id) => startScan(id)));
  return ids;
}

// ---- Auto top-up -------------------------------------------------------------

/** Pushes the org's auto top-up choice to Autumn, sized for its current plan. */
export async function applyAutoTopUp(orgId: string, planId: string | null, choice: OrgSettings["autoTopUp"]): Promise<BillingState["autoTopUp"]> {
  const plan = planById(planId);
  const control = plan && choice ? autoTopUpControl(plan, choice.enabled, choice.monthlyLimitUsd) : null;
  const off = { enabled: false, threshold: 0, quantity: 0, perMonth: 1 };
  await autumn()!.setAutoTopUp(orgId, control ?? off);
  return control ?? off;
}

/** After a plan change: resize auto top-up for the new plan, or turn it off without one. */
async function matchAutoTopUp(orgId: string, state: BillingState): Promise<BillingState> {
  const org = await db().query.orgs.findFirst({ where: (orgs, { eq }) => eq(orgs.id, orgId), columns: { settings: true } });
  const choice = org?.settings.autoTopUp;
  if (!choice?.enabled && !state.autoTopUp?.enabled) return state;
  return { ...state, autoTopUp: await applyAutoTopUp(orgId, state.planId, choice) };
}

// ---- The scan gate -----------------------------------------------------------

export type Gate = { ok: true } | { ok: false; reason: "no_plan" | "out_of_credits"; credits: number };

/**
 * Lets a scan run: holds its credits in Autumn, or for a free scan checks the
 * org has a plan. Idempotent per scan, since the scan id is the lock id.
 * Records the hold on the scan unless `record` is false (the scan row does
 * not exist yet).
 */
export async function reserveScan(scanId: string, org: BillingOrg, credits: number, record = true): Promise<Gate> {
  const client = autumn();
  if (!client) return { ok: true };
  if (credits === 0) {
    if (!(await hasPlan(org))) return { ok: false, reason: "no_plan", credits };
  } else {
    const from = new Date();
    const result = await client.reserve({ customerId: org.id, credits, lockId: scanId, expiresAt: new Date(Date.now() + RESERVATION_MS) });
    const seen = { from, to: new Date() };
    if (!result.allowed) {
      // Refused: read the org again, both to say why and so the dashboard shows the balance that refused it.
      // If Autumn can't be read just now, the stored copy says whether there is a plan: an outage is not "no plan".
      const state = (await syncBilling(org).catch(() => null)) ?? (await orgBillingRow(db(), org.id));
      return { ok: false, reason: state?.planId ? "out_of_credits" : "no_plan", credits };
    }
    if (result.remaining !== null) {
      const stored = await setOrgCredits(db(), org.id, result.remaining);
      if (stored) await noticeCredits(org, stored, seen).catch(logFailure("credits email"));
    }
  }
  if (record) await markScanReserved(db(), scanId, credits);
  return { ok: true };
}

/**
 * Charges a completed scan (at most what it reserved) or releases a scan that
 * did not complete. Safe to repeat: only a scan still holding credits is
 * settled, and Autumn finalizes a lock once.
 */
export async function settleScan(scan: { id: string; orgId: string; billing: string | null; creditsReserved: number | null }, outcome: "charge" | "release", credits = 0): Promise<void> {
  if (scan.billing !== "reserved") return;
  const reserved = scan.creditsReserved ?? 0;
  const charged = outcome === "charge" ? Math.min(Math.max(credits, 0), reserved) : 0;
  const client = autumn();
  if (client && reserved > 0) {
    await client.finalize({ customerId: scan.orgId, lockId: scan.id, action: outcome === "charge" ? "confirm" : "release", ...(outcome === "charge" && charged < reserved ? { credits: charged } : {}) });
  }
  await settleScanRow(db(), scan.id, outcome === "charge" ? "charged" : "released", charged);
}

function logFailure(what: string) {
  return (error: unknown) => {
    console.error(`Billing ${what} failed: ${error instanceof Error ? error.message : "error"}`);
    return null;
  };
}
