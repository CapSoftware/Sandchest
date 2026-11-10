/**
 * Every price and amount the app says, in the credit unit it runs in. People read amounts in US dollars, so the
 * pages say the same in either unit; the agent API speaks in credits, which are 100 times as many in the cent
 * unit (the default) as in the dollar unit. Each test checks the unit this process was built for
 * (NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CREDIT_UNIT } from "@sandchest/billing";
import { money, usd } from "@/lib/format";
import { fundsFor, lastScanCost, notEnoughBalance, perCredit, PR_REVIEW_COST, PR_REVIEW_PRICE, PRICE_NOTE, PRICES, sizePrice, usagePrice } from "@/lib/pricing";
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
      plan: "$1 a month, plus what your scans use, paid from your balance.",
      credits: "Add $25 or more at once for 10% less, $50 or more for 15% less, and $100 or more for 20% less.",
      review: says(
        "A pull request review is charged for what it uses: usually a few dollars or less, and nothing when it changes nothing security-relevant.",
        "A pull request review is charged for what it uses: usually a few cents or less, and nothing when it changes nothing security-relevant.",
      ),
      dig: "A deep scan of a whole repository usually costs well under $1, and shows the most it can cost before it starts.",
      free: "Recon and fix checks are free while there is balance left.",
    });
    expect(PRICE_NOTE).toBe(`${PRICES.review} ${PRICES.dig} ${PRICES.free}`);
    expect(PR_REVIEW_PRICE).toBe(says("charged for what it uses, usually a few dollars or less", "charged for what it uses, usually a few cents or less"));
    // The agent API's words, still in credits.
    expect(PR_REVIEW_COST).toBe("charged for what it uses, usually a few credits or less");
    expect(perCredit(0.9)).toBe(says("$0.90 each", "$0.90 per 100"));
  });

  test("an amount of credits is said in dollars: always to the cent, thousands grouped", () => {
    expect([1, 3, 48, 300, 1_000, 2_500, 123_456].map((credits) => money(credits))).toEqual(
      cent ? ["$0.01", "$0.03", "$0.48", "$3.00", "$10.00", "$25.00", "$1,234.56"] : ["$1.00", "$3.00", "$48.00", "$300.00", "$1,000.00", "$2,500.00", "$123,456.00"],
    );
    expect(money(0)).toBe("$0.00");
    // A usage bill's lines are parts of a credit: four decimals.
    expect(money(15.12, true)).toBe(says("$15.1200", "$0.1512"));
    expect(money(0.46, true)).toBe(says("$0.4600", "$0.0046"));
    expect([usd(20), usd(12.5), usd(20, true)]).toEqual(["$20", "$12.50", "$20.00"]);
  });

  test("what a scan costs, before it starts and when the balance is short", () => {
    const hold = cent ? 300 : 3;
    expect(usagePrice(hold)).toBe("You pay for what the scan uses, never more than $3.00.");
    expect(sizePrice(cent ? 500 : 5, false)).toBe("This scan costs $5.00.");
    expect(sizePrice(cent ? 2_500 : 25, true)).toBe("You pay by the repository’s size, never more than $25.00.");
    expect(lastScanCost(cent ? 48 : 1)).toBe(says("The last scan of this repository cost $1.00.", "The last scan of this repository cost $0.48."));
    expect(notEnoughBalance("scan", hold, "acme", cent ? 200 : 2)).toBe("Not enough balance: this scan needs $3.00 available, acme has $2.00.");
    // What the account holds is said only when it is known and really is less.
    expect(notEnoughBalance("review", hold, "acme")).toBe("Not enough balance: this review needs $3.00 available.");
    expect(notEnoughBalance("scan", hold, "acme", hold)).toBe("Not enough balance: this scan needs $3.00 available.");
    // Funds as they are sold: what is added, and its price where a bigger purchase costs less.
    expect([10, 25].map((dollars) => fundsFor(dollars * (cent ? 100 : 1)))).toEqual(["$10.00", "$25.00 for $22.50"]);
  });
});

describe("pages and forms", () => {
  test("the landing page's examples", async () => {
    const { HowItWorks } = await import("@/components/how-it-works");
    const { FindingStrip } = await import("@/components/finding-strip");
    const how = text(renderToStaticMarkup(<HowItWorks />));
    expect(how).toContain("|Usually well under $1|");
    expect(how).toContain(says("|$2.00|", "|$0.02|"));
    expect(how).not.toMatch(/credit/i);
    expect(text(renderToStaticMarkup(<FindingStrip />))).toContain(says("|Reviewed · $2.00|", "|Reviewed · $0.02|"));
  });

  test("review settings", async () => {
    const { OrgReviewsForm } = await import("@/components/app/org-reviews");
    const { RepoSettingsForm } = await import("@/components/app/repo-settings");
    expect(renderToStaticMarkup(<OrgReviewsForm orgId="o" mode="auto" admin />)).toContain(says("Every push to a pull request is reviewed. A review is charged for what it uses, usually a few dollars or less.", "Every push to a pull request is reviewed. A review is charged for what it uses, usually a few cents or less."));
    expect(renderToStaticMarkup(<RepoSettingsForm repoId="r" branch="main" prReviews="auto" schedule="off" nextDeepScanAt={null} price={null} />)).toContain(
      says("Each push to an open pull request is reviewed. A review is charged for what it uses, usually a few dollars or less.", "Each push to an open pull request is reviewed. A review is charged for what it uses, usually a few cents or less."),
    );
  });

  test("adding funds", async () => {
    const { TopUpForm } = await import("@/components/app/top-up-form");
    const { AddCredits } = await import("@/components/app/add-credits");
    const options = [...renderToStaticMarkup(<TopUpForm orgId="o" />).matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((m) => m[1]!.replace(/<!-- -->/g, ""));
    // The same in either unit: the balance added, and its price where they differ.
    expect(options).toEqual(["$10.00", "$25.00 for $22.50 (save $2.50)", "$50.00 for $42.50 (save $7.50)", "$100.00 for $80.00 (save $20)", "$250.00 for $200.00 (save $50)", "$500.00 for $400.00 (save $100)"]);
    const form = text(renderToStaticMarkup(<TopUpForm orgId="o" />));
    expect(form).toContain("|Funds to add|");
    expect(form).toContain("|Add funds|");
    const dialog = text(renderToStaticMarkup(<AddCredits account={{ id: "o", login: "acme", credits: cent ? 200 : 2, admin: true }} need={cent ? 500 : 5} open={false} onClose={() => {}} />));
    expect(dialog).toContain("|Top up to keep going|");
    expect(dialog).toContain("This needs $5.00 available, acme has $2.00.");
    expect(dialog).toContain("Funds you add never expire.");
    expect(dialog).toContain("|$25.00|for $22.50|Save $2.50|");
    expect(dialog).toContain("|Add $10.00|");
    const plain = text(renderToStaticMarkup(<AddCredits account={{ id: "o", login: "acme", credits: cent ? 123_456 : 1_234, admin: true }} open={false} onClose={() => {}} />));
    expect(plain).toContain("|Add funds|");
    expect(plain).toContain(says("Balance $1,234.00.", "Balance $1,234.56."));
    for (const shown of [form, dialog, plain]) expect(shown).not.toMatch(/credit/i);
  });

  test("the billing panel: the balance, and auto top-up in what it adds and may spend", async () => {
    const { BillingPanel } = await import("@/components/app/billing-panel");
    const pack = cent ? 100 : 1;
    const billing = {
      orgId: "o",
      planId: "standard",
      pastDue: false,
      endsAt: null,
      renewsAt: null,
      nextPlanId: null,
      credits: 1_234 * pack,
      creditsResetAt: null,
      autoTopUp: { enabled: true, threshold: 5 * pack, quantity: 10 * pack, perMonth: 50 },
      activatedAt: null,
      checkedAt: new Date(0),
      creditLevel: 0,
      creditLevelAt: null,
      creditLevelRev: 0,
    };
    const org = { id: "o", login: "acme", admin: true, settings: {} as never };
    const panel = text(renderToStaticMarkup(<BillingPanel org={org} billing={billing as never} />));
    expect(panel).toContain("|Balance|$1,234.00|");
    expect(panel).toContain("Funds you add never expire.");
    expect(panel).toContain("On: adds $10.00 when the balance falls below $5.00, up to $500 a month.");
    expect(panel).toContain("|Add|Funds each time|$10.00|$25.00 for $22.50|$50.00 for $42.50|$100.00 for $80.00|when the balance falls below $5.00|");
    expect(panel).not.toMatch(/credit/i);
    // On free balance: what is left, and what happens when it is spent.
    const free = text(renderToStaticMarkup(<BillingPanel org={org} billing={{ ...billing, planId: "trial", credits: 20 * pack, autoTopUp: null } as never} />));
    expect(free).toContain("|Plan|Free| no card, nothing to pay|Balance|$20.00| free balance left|");
    expect(free).toContain("When it runs out, Sandchest stops scanning until acme joins Standard. Anything left carries across.");
    expect(free).not.toMatch(/credit/i);
  });

  test("the free balance page", async () => {
    const claim = await import("@/app/claim/page");
    expect(claim.metadata.title).toBe("Claim your free $20 · Sandchest");
    expect(claim.metadata.description).toStartWith("Test Sandchest on your own code: $20 free, no card.");
    const page = text(renderToStaticMarkup(<claim.default />));
    for (const line of [
      "Claim your free $20.",
      "Claim $20 free",
      "What $20 usually gets you",
      says("Most reviews cost a few dollars or less.", "Most reviews cost a few cents or less."),
      "every file, and usually costs well under $1.",
      "When the $20 runs out, join for $1 a month and keep any left over.",
      "|200+|pull request reviews|",
      "|20+|deep scans|",
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
    expect(lines).toContain("$1 a month. $25.00 to start.");
    expect(lines).toContain(says("A pull request review: a few dollars or less, most of the time.", "A pull request review: a few cents or less, most of the time."));
    expect(lines).toContain("A deep scan of a whole repository: usually well under $1.");
    expect(lines).toContain("$25.00 more when the balance falls below $5.00.");
    expect(lines.join(" ")).not.toMatch(/credit/i);
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
    expect(paths["/api/v1/repos/{repo}"]!.patch!.description).toContain("reviews every push to a pull request (each charged for what it uses, usually a few credits or less)");
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
