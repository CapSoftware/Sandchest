/** The slice engine's daily spend limit: read rarely, never in the way of a scan, reported once per trip. */
import { afterEach, describe, expect, test } from "bun:test";
import { config, scanPricing } from "@/server/config";
import { resetSentry } from "@/server/sentry";
import { resetSliceLimit, sliceAllowedCached, sliceAllowedNow } from "@/server/slice-limit";
import { deepScanQuote, prReviewQuote } from "@/server/usage-quote";

const slice = {
  DATABASE_URL: "postgres://sandchest@postgres/sandchest",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "key",
  GITHUB_WEBHOOK_SECRET: "secret",
  SANDCHEST_APP_URL: "https://sandchest.example.com",
  SANDCHEST_WORKSPACE: "boat",
  SANDCHEST_BOAT_API_KEY: "boat_test",
  SANDCHEST_INDEXER_LINUX_BIN: "/opt/sandchest-index",
  SANDCHEST_ENGINE: "slice",
  SANDCHEST_GATEWAY_SECRET: "gateway-secret-0123456789abcdef-xyz",
  SANDCHEST_SLICE_CEILING_USD: "0.5",
  SANDCHEST_SLICE_CEILING_PR_USD: "0.25",
  SANDCHEST_USAGE_BILLING: "on",
  SANDCHEST_USAGE_MULTIPLIER: "3",
  NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "cent",
};
/** A made-up limit of 10 USD. */
const limited = config({ ...slice, SANDCHEST_SLICE_DAILY_LIMIT_USD: "10" });
const MINUTE = 60_000;
const T0 = Date.UTC(2030, 0, 1);

/** A spend reader that answers `spent` (or throws) and counts its reads, with the start of each window. */
function reader(spent: { usd: string | Error }) {
  const since: Date[] = [];
  resetSliceLimit(async (from) => {
    since.push(from);
    if (spent.usd instanceof Error) throw spent.usd;
    return spent.usd;
  });
  return since;
}

/** A Sentry on localhost for `fn`; returns each event's outcome tag and all its tags. */
async function withSentry(fn: () => Promise<void>): Promise<Array<{ outcome: string; tags: Record<string, unknown> }>> {
  const events: Array<{ outcome: string; tags: Record<string, unknown> }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const [, , event] = (await request.text()).trim().split("\n").map((line) => JSON.parse(line) as { tags?: Record<string, unknown> });
      events.push({ outcome: String(event?.tags?.outcome), tags: event?.tags ?? {} });
      return new Response("{}");
    },
  });
  process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${server.port}/5`;
  resetSentry();
  try {
    await fn();
  } finally {
    delete process.env.SENTRY_DSN;
    resetSentry();
    server.stop(true);
  }
  return events;
}

afterEach(() => resetSliceLimit());

describe("the slice engine's daily limit", () => {
  test("unset: always allowed, and nothing is read", async () => {
    const since = reader({ usd: "999999" });
    for (const kind of ["deep", "pr_review", "recon"]) expect(await sliceAllowedNow(kind, "acme", config(slice), T0)).toBe(true);
    expect(sliceAllowedCached(config(slice), T0)).toBe(true);
    expect(since).toEqual([]);
  });

  test("a scan that would not run slice anyway reads nothing", async () => {
    const since = reader({ usd: "999999" });
    expect(await sliceAllowedNow("recon", "acme", limited, T0)).toBe(true);
    expect(await sliceAllowedNow("fix_check", "acme", limited, T0)).toBe(true);
    const listed = config({ ...slice, SANDCHEST_SLICE_DAILY_LIMIT_USD: "10", SANDCHEST_ENGINE_ORGS: "example-org" });
    expect(await sliceAllowedNow("deep", "acme", listed, T0)).toBe(true);
    expect(since).toEqual([]);
  });

  test("under the limit: allowed; reached: not, and scans are priced classic and tiered", async () => {
    const spent = { usd: "9.999999" };
    const since = reader(spent);
    expect(await sliceAllowedNow("deep", "acme", limited, T0)).toBe(true);
    // The window is the last 24 hours.
    expect(since).toEqual([new Date(T0 - 24 * 60 * MINUTE)]);
    spent.usd = "10.0000000000";
    const allowed = await sliceAllowedNow("pr_review", "acme", limited, T0 + MINUTE);
    expect(allowed).toBe(false);
    for (const kind of ["deep", "pr_review"]) expect(scanPricing({ kind, fast: false }, "acme", limited, allowed)).toEqual({ engine: "classic", mode: "tiered", unit: "cent" });
    expect(scanPricing({ kind: "deep", fast: true }, "acme", limited, allowed)).toEqual({ engine: "classic", mode: "tiered", unit: "cent" });
    expect(scanPricing({ kind: "deep", fast: false }, "acme", limited, true)).toMatchObject({ engine: "slice", mode: "usage" });
  });

  test("two decisions within a minute read once; the next minute reads again", async () => {
    const since = reader({ usd: "1" });
    expect(await sliceAllowedNow("deep", "acme", limited, T0)).toBe(true);
    expect(await sliceAllowedNow("pr_review", "other", limited, T0 + MINUTE - 1)).toBe(true);
    expect(since.length).toBe(1);
    expect(await sliceAllowedNow("deep", "acme", limited, T0 + MINUTE)).toBe(true);
    expect(since.length).toBe(2);
    // Decisions that wait on the same read share it.
    await Promise.all([sliceAllowedNow("deep", "acme", limited, T0 + 2 * MINUTE), sliceAllowedNow("deep", "acme", limited, T0 + 2 * MINUTE)]);
    expect(since.length).toBe(3);
  });

  test("reported once per trip, at most once every 15 minutes, with no amounts", async () => {
    const spent = { usd: "12" };
    reader(spent);
    const events = await withSentry(async () => {
      // One trip, many scans over many minutes: one report.
      for (let minute = 0; minute <= 10; minute++) {
        expect(await sliceAllowedNow("deep", "acme", limited, T0 + minute * MINUTE)).toBe(false);
        expect(await sliceAllowedNow("pr_review", "other", limited, T0 + minute * MINUTE)).toBe(false);
      }
    });
    expect(events).toEqual([{ outcome: "reached", tags: expect.objectContaining({ source: "billing", action: "slice_daily_limit" }) }]);
    expect(Object.keys(events[0]!.tags).sort()).toEqual(["action", "outcome", "runtime", "source"]);

    const again = await withSentry(async () => {
      // Back under, then reached again within 15 minutes of the report: not said yet.
      for (const [minute, usd, allowed] of [[11, "1", true], [12, "12", false], [13, "1", true], [14, "12", false]] as const) {
        spent.usd = usd;
        expect(await sliceAllowedNow("deep", "acme", limited, T0 + minute * MINUTE)).toBe(allowed);
      }
    });
    expect(again).toEqual([]);
    // Said once the 15 minutes are up, while it is still reached, and once only.
    const later = await withSentry(async () => {
      expect(await sliceAllowedNow("deep", "acme", limited, T0 + 15 * MINUTE)).toBe(false);
      expect(await sliceAllowedNow("deep", "acme", limited, T0 + 40 * MINUTE)).toBe(false);
    });
    expect(later.map((event) => event.outcome)).toEqual(["reached"]);
  });

  test("a failed read counts as not reached, is reported, and is not read again within the minute", async () => {
    const since = reader({ usd: new Error("connection refused") });
    const events = await withSentry(async () => {
      expect(await sliceAllowedNow("deep", "acme", limited, T0)).toBe(true);
      expect(await sliceAllowedNow("deep", "acme", limited, T0 + 1_000)).toBe(true);
    });
    expect(since.length).toBe(1);
    expect(events).toEqual([{ outcome: "read_failed", tags: expect.objectContaining({ source: "billing", action: "slice_daily_limit" }) }]);
  });

  test("a failed read during a trip neither ends it nor reports it again", async () => {
    const spent: { usd: string | Error } = { usd: "12" };
    reader(spent);
    const events = await withSentry(async () => {
      expect(await sliceAllowedNow("deep", "acme", limited, T0)).toBe(false);
      spent.usd = new Error("connection refused");
      expect(await sliceAllowedNow("deep", "acme", limited, T0 + MINUTE)).toBe(true);
      spent.usd = "12";
      expect(await sliceAllowedNow("deep", "acme", limited, T0 + 20 * MINUTE)).toBe(false);
    });
    expect(events.map((event) => event.outcome)).toEqual(["reached", "read_failed"]);
  });

  test("quotes follow the last decision within the minute, and never read", async () => {
    const since = reader({ usd: "12" });
    // No decision yet: quoted as usual.
    expect(sliceAllowedCached(limited, T0)).toBe(true);
    expect(deepScanQuote("acme", limited)).toEqual({ hold: 150 });
    expect(since).toEqual([]);
    expect(await sliceAllowedNow("deep", "acme", limited, T0)).toBe(false);
    expect(sliceAllowedCached(limited, T0 + MINUTE - 1)).toBe(false);
    expect(sliceAllowedCached(limited, T0 + MINUTE)).toBe(true);
    expect(since.length).toBe(1);
  });

  test("quotes past the limit: nothing quoted, as for a classic account", async () => {
    reader({ usd: "12" });
    expect(await sliceAllowedNow("deep", "acme", limited)).toBe(false);
    expect(deepScanQuote("acme", limited)).toBeUndefined();
    expect(prReviewQuote("acme", limited)).toBeUndefined();
  });
});
