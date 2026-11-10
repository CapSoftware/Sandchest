/**
 * What a scan billed from its usage is quoted before it starts (the most it holds, as "up to"), the fast option
 * offered only where everything it needs is true, and every other account quoted exactly as before.
 */
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dig } from "@/components/app/dig";
import { ScanBill } from "@/components/app/scan-bill";
import { UsageHistory } from "@/components/app/usage-history";
import { ranFast } from "@/app/dashboard/scans/[id]/scan-view";
import { digAllCredits, digCredits } from "@/lib/briefing";
import { firstScan } from "@/lib/first-scan";
import { creditsText } from "@/lib/format";
import { sampleBill, sampleRepos, sampleScan, sampleUsageHistory } from "@/lib/samples";
import { deepScanPrice } from "@/server/agent/views";
import { config, fastOffered, resetConfig } from "@/server/config";
import { deepScanQuote, prReviewQuote, quotesByAccount } from "@/server/usage-quote";

const base = {
  DATABASE_URL: "postgres://sandchest@postgres/sandchest",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "key",
  GITHUB_WEBHOOK_SECRET: "secret",
  SANDCHEST_APP_URL: "https://sandchest.example.com",
};
const boat = { SANDCHEST_WORKSPACE: "boat", SANDCHEST_BOAT_API_KEY: "boat_test", SANDCHEST_INDEXER_LINUX_BIN: "/opt/sandchest-index" };
/** Made-up ceilings: a deep scan's, a review's and a fast scan's. */
const slice = { ...base, ...boat, SANDCHEST_ENGINE: "slice", SANDCHEST_GATEWAY_SECRET: "gateway-secret-0123456789abcdef-xyz", SANDCHEST_SLICE_CEILING_USD: "0.5", SANDCHEST_SLICE_CEILING_PR_USD: "0.25" };
const fast = { SANDCHEST_SLICE_CEILING_FAST_USD: "1.5", LLM_AGENT_FAST_MODEL: "fast-model" };
/** A made-up multiplier of 3, credits worth a cent. */
const usage = { SANDCHEST_USAGE_BILLING: "on", SANDCHEST_USAGE_MULTIPLIER: "3", NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "cent" };
const shadow = { SANDCHEST_USAGE_BILLING: "shadow", SANDCHEST_USAGE_MULTIPLIER: "3" };

describe("usage quotes", () => {
  test("only an account billed from its usage is quoted: up to its hold", () => {
    for (const env of [base, slice, { ...slice, ...fast }, { ...slice, ...shadow }, { ...slice, ...fast, ...shadow }]) {
      expect(deepScanQuote("acme", config(env))).toBeUndefined();
      expect(prReviewQuote("acme", config(env))).toBeUndefined();
    }
    // 0.5 × 3 = 1.5 in cents, and 0.25 × 3 for a review.
    expect(deepScanQuote("acme", config({ ...slice, ...usage }))).toEqual({ hold: 150 });
    expect(prReviewQuote("acme", config({ ...slice, ...usage }))).toBe(75);
    // An account the slice engine doesn't take is classic, and classic is always tiered.
    expect(deepScanQuote("other", config({ ...slice, ...usage, SANDCHEST_ENGINE_ORGS: "acme" }))).toBeUndefined();
    expect(deepScanQuote("acme", config({ ...slice, ...usage, SANDCHEST_ENGINE_ORGS: "acme" }))).toEqual({ hold: 150 });
  });

  test("fast is offered only with fast mode available, the slice engine and usage billing, all three", () => {
    expect(fastOffered("acme", config({ ...slice, ...fast, ...usage }))).toBe(true);
    // The larger of the fast and standard ceilings, times 3.
    expect(deepScanQuote("acme", config({ ...slice, ...fast, ...usage }))).toEqual({ hold: 150, fast: 450 });
    // Each one missing.
    expect(fastOffered("acme", config({ ...slice, ...usage }))).toBe(false);
    expect(fastOffered("acme", config({ ...slice, ...fast, ...usage, SANDCHEST_ENGINE_ORGS: "someone-else" }))).toBe(false);
    expect(fastOffered("acme", config({ ...slice, ...fast }))).toBe(false);
    expect(fastOffered("acme", config({ ...slice, ...fast, ...shadow }))).toBe(false);
    expect(fastOffered("acme", config(base))).toBe(false);
    expect(deepScanQuote("acme", config({ ...slice, ...usage }))).toEqual({ hold: 150 });
  });

  test("quotesByAccount works each account out once", () => {
    const before = { ...process.env };
    Object.assign(process.env, slice, usage);
    resetConfig();
    try {
      const quote = quotesByAccount();
      expect(quote("acme")).toEqual({ hold: 150 });
      expect(quote("acme")).toBe(quote("acme"));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
      resetConfig();
    }
  });
});

describe("quoted before a scan", () => {
  test("recruiting's deep scan credits: by size, or each the most it holds", () => {
    expect(digCredits({ loc: 50_000 })).toBe(digCredits({ loc: 50_000 }, undefined));
    expect(digCredits({ loc: 50_000 }, 150)).toBe(150);
    expect(digCredits({ loc: null }, 150)).toBe(150);
    expect(digAllCredits([{ loc: 50_000 }, { loc: null }], 150)).toBe(300);
  });

  test("the first scan panel: a usage account's repositories at up to the hold, every other exactly as before", () => {
    const repos = sampleRepos().map((repo, i) => ({ ...repo, lastDeepScanAt: null, activeDeepScanId: null, loc: i === 0 ? null : repo.loc }));
    const orgId = repos[0]!.orgId;
    const tiered = firstScan(repos, new Map([[orgId, { planId: "standard", credits: 120 }]]), [])!;
    for (const repo of tiered.repos) expect("usage" in repo).toBe(false);
    const billed = firstScan(repos, new Map([[orgId, { planId: "standard", credits: 120, usage: { hold: 150 } }]]), [])!;
    for (const repo of billed.repos) expect(repo).toMatchObject({ credits: 150, usage: true });
    expect(billed.repos.map((repo) => [repo.id, repo.unsized])).toEqual(tiered.repos.map((repo) => [repo.id, repo.unsized]));
  });

  test("the agent API's price: unchanged for a tiered account; up to the hold, with fast, for a usage one", () => {
    expect(deepScanPrice({ loc: null })).toEqual({ credits: null, held_until_sized: 2_500, too_large: false });
    expect(Object.keys(deepScanPrice({ loc: 50_000 }))).toEqual(["credits", "held_until_sized", "too_large"]);
    expect(deepScanPrice({ loc: 50_000 }, { hold: 150 })).toEqual({ credits: null, held_until_sized: null, too_large: false, up_to_credits: 150, fast: { available: false } });
    expect(deepScanPrice({ loc: null }, { hold: 150, fast: 450 })).toEqual({ credits: null, held_until_sized: null, too_large: false, up_to_credits: 150, fast: { available: true, up_to_credits: 450 } });
    expect(deepScanPrice({ loc: 5_000_000 }, { hold: 150 }).too_large).toBe(true);
  });

  test("the deep scan key: a usage account's is named as a maximum, with fast where it is offered", () => {
    const repo = { ...sampleRepos()[0]!, activeDeepScanId: null, loc: 50_000, lastDeepScanAt: null };
    const props = (plan: Parameters<typeof Dig>[0]["plan"]) => (Dig({ repo, plan }) as ReactElement<Record<string, unknown>>).props;

    const tiered = props({ planId: "standard", credits: 1_000 });
    expect(tiered.confirm).toBe(`Scan for ${creditsText(500)}`);
    expect("fast" in tiered).toBe(false);

    const billed = props({ planId: "standard", credits: 1_000, usage: { hold: 150 } });
    expect(billed).toMatchObject({ confirm: `Scan for up to ${creditsText(150)}`, need: 150 });
    expect(billed.note).toBe(`Up to 150 of your ${creditsText(1_000)}`);
    expect("fast" in billed).toBe(false);

    const withFast = props({ planId: "standard", credits: 1_000, usage: { hold: 150, fast: 450 } });
    expect(withFast.fast).toEqual({ confirm: `Scan for up to ${creditsText(450)}`, need: 450, note: `Up to 450 of your ${creditsText(1_000)}` });

    // Not enough for the hold: the key adds credits first, whatever the repository's size.
    const short = props({ planId: "standard", credits: 100, usage: { hold: 150 } });
    expect(short).toMatchObject({ short: true, need: 150, note: `Needs ${creditsText(150)}; 100 left` });
    // Unsized and short: a usage scan is never "priced once mapped".
    expect(renderToStaticMarkup(Dig({ repo: { ...repo, loc: null }, plan: { planId: "standard", credits: 100, usage: { hold: 150 } } }))).not.toContain("Priced once mapped");
  });
});

describe("the bill on the page", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

  test("the bill: every group and total", () => {
    const billed = text(renderToStaticMarkup(<ScanBill bill={sampleBill()} />));
    for (const words of ["|Bill|", "|Hunting|", "|Scoring|", "|Verifying in a sandbox|", "|Looking for variants|", "|Writing up|", "|Sandbox time|", "|Usage|37.89|", "|Carried from earlier scans|0.46|", "|Charged|38|", "|Carried to the next scan|0.35|", "|150 credits held|"]) {
      expect(billed).toContain(words);
    }
    expect(billed).toContain("|24 calls| · |410K tokens in| · |38K out|");
    expect(billed).toContain("6 min 53 s");
    expect(billed).not.toContain("Fast");
  });

  test("fast shows on the page and the bill, only for a scan started fast", () => {
    const { scan } = sampleScan();
    expect(ranFast(scan)).toBe(false);
    const started = { ...scan, fast: true, pricing: { engine: "slice" as const, mode: "usage" as const, unit: "cent" as const, fast: true } };
    expect(ranFast(started)).toBe(true);
    // It ran standard after all (fast became unavailable when the hunt began): not fast.
    expect(ranFast({ ...started, stats: { loc: 1, slice: { fast: false } } })).toBe(false);
    expect(ranFast({ ...started, stats: { loc: 1, slice: { fast: true } } })).toBe(true);
    // Once billed, the bill says.
    expect(ranFast(started, { fast: false })).toBe(false);
    // A flag in a bill alone never makes a scan not started fast say so.
    expect(ranFast(scan, { fast: true })).toBe(false);
    expect(text(renderToStaticMarkup(<ScanBill bill={{ ...sampleBill(), fast: true }} />))).toContain("|Fast · 150 credits held|");
  });

  test("open, capped and waived bills", () => {
    const open = text(renderToStaticMarkup(<ScanBill bill={{ ...sampleBill(), status: "open" }} />));
    expect(open).toContain("|To be charged|38|");
    const capped = text(renderToStaticMarkup(<ScanBill bill={{ ...sampleBill(), capped: true, note: "Capped at the 150 credits held." }} />));
    expect(capped).toContain("|Capped at the 150 credits held.|");
    const waived = text(renderToStaticMarkup(<ScanBill bill={{ ...sampleBill(), status: "waived", charged: 0, carriedIn: 0, carriedOut: 0, note: "Not charged: this scan’s usage could not be measured exactly." }} />));
    expect(waived).toContain("|Charged|0|");
    expect(waived).toContain("|Not charged: this scan’s usage could not be measured exactly.|");
    expect(waived).not.toContain("Carried");
  });

  test("the usage history rows: date, scan, repository, credits; waived ones say so", () => {
    const rows = sampleUsageHistory(3);
    rows[1] = { ...rows[1]!, status: "waived", credits: 0 };
    const html = renderToStaticMarkup(<UsageHistory rows={rows} />);
    expect(html.match(/href="\/dashboard\/scans\//g)).toHaveLength(3);
    const shown = text(html);
    expect(shown).toContain("|Usage|");
    expect(shown).toContain("|Deep scan|acme/api|38 credits|");
    expect(shown).toContain(`|PR #${rows[1]!.prNumber}| review|acme/web|Not charged|`);
  });
});
