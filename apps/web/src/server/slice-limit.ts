/**
 * The slice engine's daily spend limit (SANDCHEST_SLICE_DAILY_LIMIT_USD). The model provider caps nothing, so once
 * what every scan recorded over the last 24 hours reaches the limit, scans priced from then on get the classic
 * engine. Scans already priced keep theirs. The spend is read at most once a minute per server instance. A failed
 * read counts as not reached and is reported: each scan's own ceiling still bounds it, and a database blip must
 * neither stop scans nor change their engine.
 */
import { usdToMicroUsd } from "@sandchest/billing/usage";
import { spendSince } from "@sandchest/db";
import { config, scanEngine, type Config } from "./config";
import { describeError } from "./log";
import { captureException } from "./sentry";
import { db } from "./services";

const DAY_MS = 24 * 60 * 60_000;
const CACHE_MS = 60_000;
const REPORT_EVERY_MS = 15 * 60_000;

type SpendReader = (since: Date) => Promise<string>;
const readSpend: SpendReader = (since) => spendSince(db(), since);

let read = readSpend;
/** The last read: when it started, and the spend in micro-dollars (undefined when it failed). */
let cached: { at: number; spent: Promise<number | undefined> } | undefined;
/** The last decision this instance made, for quotes (see `sliceAllowedCached`). */
let decided: { at: number; allowed: boolean } | undefined;
let tripped = false;
let unreported = false;
let reportedAt: number | undefined;

/**
 * Whether a scan priced now may run on the slice engine. True with no limit set, and for a scan that would not run
 * slice anyway: neither reads anything.
 */
export async function sliceAllowedNow(kind: string, githubLogin: string, settings: Config = config(), now = Date.now()): Promise<boolean> {
  const limit = settings.SANDCHEST_SLICE_DAILY_LIMIT_USD;
  if (limit === undefined || scanEngine(kind, githubLogin, settings) !== "slice") return true;
  if (!cached || now - cached.at >= CACHE_MS) cached = { at: now, spent: spentSince(now) };
  const spent = await cached.spent;
  const reached = spent !== undefined && spent >= usdToMicroUsd(limit);
  decided = { at: now, allowed: !reached };
  if (!reached) {
    // A failed read leaves the trip as it was, so the read after it does not report it again.
    if (spent !== undefined) tripped = false;
    return true;
  }
  if (!tripped) {
    tripped = true;
    unreported = true;
  }
  if (unreported && (reportedAt === undefined || now - reportedAt >= REPORT_EVERY_MS)) {
    unreported = false;
    reportedAt = now;
    console.warn("The slice engine's daily limit is reached: scans priced from now on run on the classic engine.");
    await captureException(Object.assign(new Error("The slice engine's daily limit is reached"), { name: "SliceDailyLimitReached" }), { source: "billing", tags: { action: "slice_daily_limit", outcome: "reached" }, handled: true });
  }
  return false;
}

/**
 * The decision `sliceAllowedNow` last made on this instance, if it made one within the minute; otherwise allowed.
 * Never reads anything: for quotes, which may disagree with the reservation for that minute.
 */
export function sliceAllowedCached(settings: Config = config(), now = Date.now()): boolean {
  if (settings.SANDCHEST_SLICE_DAILY_LIMIT_USD === undefined || !decided || now - decided.at >= CACHE_MS) return true;
  return decided.allowed;
}

async function spentSince(now: number): Promise<number | undefined> {
  try {
    return usdToMicroUsd(await read(new Date(now - DAY_MS)));
  } catch (error) {
    console.error(`Reading the day's spend failed, so the slice engine's daily limit counts as not reached: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "slice_daily_limit", outcome: "read_failed" }, handled: true });
    return undefined;
  }
}

/** For tests: forgets every read and report, and reads the spend with `reader` (default the database). */
export function resetSliceLimit(reader: SpendReader = readSpend): void {
  read = reader;
  cached = undefined;
  decided = undefined;
  tripped = false;
  unreported = false;
  reportedAt = undefined;
}
