/**
 * Every price and credit amount the app says, in the credit unit it runs in. Today's text is the dollar
 * unit's, word for word; the cent unit's says the same prices with every amount of credits times 100.
 * Each test checks the unit this process was built for (NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CREDIT_UNIT } from "@sandchest/billing";
import { creditCount, creditsText } from "@/lib/format";
import { perCredit, PR_REVIEW_RANGE, PRICE_NOTE, PRICES } from "@/lib/pricing";
import { resetConfig } from "@/server/config";

const cent = CREDIT_UNIT === "cent";
/** The dollar unit's text, or the cent unit's. */
const says = (dollar: string, inCents: string) => (cent ? inCents : dollar);
/** Visible text of rendered markup. */
const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

/** Runs with the server settings the API document needs, then puts the environment back. */
async function withSettings<T>(run: () => Promise<T>): Promise<T> {
  const settings = { DATABASE_URL: "postgres://x", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_WEBHOOK_SECRET: "s", SANDCHEST_APP_URL: "https://sandchest.test" };
  const before = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  resetConfig();
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfig();
  }
}

describe("the price list in words", () => {
  test("sentences", () => {
    expect(PRICES).toEqual({
      plan: says("$1 a month, and credits are $1 each, less in bulk.", "$1 a month, and credits are $1 per 100, less in bulk."),
      credits: says(
        "Credits are $1 each; 25 or more at once are $0.90 each, 50 or more $0.85, and 100 or more $0.80.",
        "Credits are $1 per 100; 2,500 or more at once are $0.90 per 100, 5,000 or more $0.85, and 10,000 or more $0.80.",
      ),
      review: says("A pull request review is usually 1 credit; very large ones are 2 or 3.", "A pull request review is usually 100 credits; very large ones are 200 or 300."),
      dig: says("A deep scan of a whole repository is 5, 10 or 25 credits, by its size.", "A deep scan of a whole repository is 500, 1,000 or 2,500 credits, by its size."),
      free: "Recon and fix checks are free while there are credits left.",
    });
    expect(PRICE_NOTE).toBe(`${PRICES.review} ${PRICES.dig} ${PRICES.free}`);
    expect(PR_REVIEW_RANGE).toBe(says("1 to 3 credits", "100 to 300 credits"));
    expect(perCredit(0.9)).toBe(says("$0.90 each", "$0.90 per 100"));
  });

  test("credit counts are grouped only where they run to five figures", () => {
    expect([1, 3, 1_000, 2_500].map(creditsText)).toEqual(cent ? ["1 credit", "3 credits", "1,000 credits", "2,500 credits"] : ["1 credit", "3 credits", "1000 credits", "2500 credits"]);
    expect(creditCount(100_000)).toBe(says("100000", "100,000"));
  });
});

describe("pages and forms", () => {
  test("the landing page's examples", async () => {
    const { HowItWorks } = await import("@/components/how-it-works");
    const { FindingStrip } = await import("@/components/finding-strip");
    const how = text(renderToStaticMarkup(<HowItWorks />));
    expect(how).toContain(says("|From 5 credits|", "|From 500 credits|"));
    expect(how).toContain(says("|1 credit|", "|100 credits|"));
    expect(text(renderToStaticMarkup(<FindingStrip />))).toContain(says("|Reviewed · 2 credits|", "|Reviewed · 200 credits|"));
  });

  test("review settings", async () => {
    const { OrgReviewsForm } = await import("@/components/app/org-reviews");
    const { RepoSettingsForm } = await import("@/components/app/repo-settings");
    expect(renderToStaticMarkup(<OrgReviewsForm orgId="o" mode="auto" admin />)).toContain(`Every push to a pull request is reviewed, for ${says("1 to 3", "100 to 300")} credits by the size of the change.`);
    expect(renderToStaticMarkup(<RepoSettingsForm repoId="r" branch="main" prReviews="auto" schedule="off" nextDeepScanAt={null} price={null} />)).toContain(
      `Each push to an open pull request is reviewed, for ${says("1 to 3", "100 to 300")} credits by the size of the change.`,
    );
  });

  test("buying credits", async () => {
    const { TopUpForm } = await import("@/components/app/top-up-form");
    const { AddCredits } = await import("@/components/app/add-credits");
    const options = [...renderToStaticMarkup(<TopUpForm orgId="o" />).matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((m) => m[1]!.replace(/<!-- -->/g, ""));
    expect(options).toEqual(
      cent
        ? ["1,000 credits, $10", "2,500 credits, $22.50 (save $2.50)", "5,000 credits, $42.50 (save $7.50)", "10,000 credits, $80 (save $20)", "25,000 credits, $200 (save $50)", "50,000 credits, $400 (save $100)"]
        : ["10 credits, $10", "25 credits, $22.50 (save $2.50)", "50 credits, $42.50 (save $7.50)", "100 credits, $80 (save $20)", "250 credits, $200 (save $50)", "500 credits, $400 (save $100)"],
    );
    const dialog = text(renderToStaticMarkup(<AddCredits account={{ id: "o", login: "acme", credits: 2, admin: true }} need={cent ? 500 : 5} open={false} onClose={() => {}} />));
    expect(dialog).toContain(says("This needs 5 credits; acme has 2.", "This needs 500 credits; acme has 2."));
    expect(dialog).toContain(says("|Add 10 credits|", "|Add 1,000 credits|"));
  });

  test("the free credits page", async () => {
    const claim = await import("@/app/claim/page");
    expect(claim.metadata.title).toBe("Claim $20 of free credits · Sandchest");
    expect(claim.metadata.description).toStartWith(says("Test Sandchest on your own code: 20 free credits, no card.", "Test Sandchest on your own code: 2,000 free credits, no card."));
    const page = text(renderToStaticMarkup(<claim.default />));
    for (const line of [
      "Claim $20 of free credits.",
      says("Claim 20 free credits", "Claim 2,000 free credits"),
      says("What 20 credits get you", "What 2,000 credits get you"),
      says("Most reviews cost 1 credit.", "Most reviews cost 100 credits."),
      says("every file: 5 to 25 credits by size.", "every file: 500 to 2,500 credits by size."),
      "|20|pull request reviews|",
      "|4|deep scans|",
    ])
      expect(page).toContain(line);
  });

  test("the recruit contract", async () => {
    const { recruitPainter } = await import("@/components/rig/paint-recruit");
    const { DEFAULT_HACKER } = await import("@/lib/hacker");
    const lines: string[] = [];
    const kit = new Proxy({ W: 1024, H: 768, ctx: { measureText: () => ({ width: 10 }) } } as Record<string | symbol, unknown>, {
      get: (target, key) => (key in target ? target[key] : key === "text" ? (_x: number, _y: number, line: string) => (lines.push(line), 10) : () => 10),
    });
    const start = cent ? 2_500 : 25;
    const paint = recruitPainter({ current: { step: "plan", profile: DEFAULT_HACKER, viewer: "v", accounts: ["acme"], repos: [], org: "acme", credits: start, autoTopUp: true, currentPlan: null, billing: true } });
    paint(kit as never, 0);
    paint(kit as never, 100);
    expect(lines).toContain(says("$1 a month. Credits $1 each, 25 to start.", "$1 a month. Credits $1 per 100, 2,500 to start."));
    expect(lines).toContain(says("A pull request review: 1 credit, most of the time.", "A pull request review: 100 credits, most of the time."));
    expect(lines).toContain(says("A deep scan of a whole repository: 5 to 25 by size.", "A deep scan of a whole repository: 500 to 2,500 by size."));
    expect(lines).toContain(says("25 more whenever fewer than 5 are left.", "2,500 more whenever fewer than 500 are left."));
  });
});

describe("the agent API", () => {
  test("what it says about buying credits and reviews", async () => {
    const { openApi } = await import("@/server/agent/openapi");
    const paths = ((await withSettings(async () => openApi())) as { paths: Record<string, Record<string, { description?: string; requestBody?: { content: { "application/json": { schema: { properties: Record<string, Record<string, unknown>> } } } } }>> }).paths;
    const props = (path: string, method: string) => paths[path]![method]!.requestBody!.content["application/json"].schema.properties;
    expect(props("/api/v1/accounts/{account}/billing/purchase", "post").credits).toMatchObject({
      minimum: cent ? 100 : 1,
      maximum: cent ? 100_000 : 1_000,
      description: says(
        "How many credits to buy (1-1000). Credits are $1 each, less in bigger purchases.",
        "How many credits to buy (100-100000, in multiples of 100). Credits are $1 per 100, less in bigger purchases.",
      ),
    });
    expect(props("/api/v1/accounts/{account}/billing/auto-top-up", "put").credits!.description).toBe(`How many credits each top-up buys. Default: the last choice, else ${says("10", "1000")}.`);
    expect(paths["/api/v1/repos/{repo}"]!.patch!.description).toContain(`reviews every push to a pull request (${says("1 to 3", "100 to 300")} credits each)`);
    expect(paths["/api/v1/accounts/{account}/billing/claim"]!.post!.description).toStartWith(`Claims ${says("20", "2000")} free credits for an account`);
  });

  test("a purchase is whole packs, up to the most one purchase may hold", async () => {
    const { PurchaseCredits } = await import("@/server/purchase-credits");
    const ok = (n: number | string) => PurchaseCredits.safeParse(n).success;
    if (cent) {
      for (const n of [100, 2_500, "1000", 100_000]) expect(ok(n)).toBe(true);
      for (const n of [0, 1, 99, 150, 100_100, 250.5]) expect(ok(n)).toBe(false);
    } else {
      for (const n of [1, 7, "25", 1_000]) expect(ok(n)).toBe(true);
      for (const n of [0, 1_001, 1.5, -1]) expect(ok(n)).toBe(false);
    }
  });
});
