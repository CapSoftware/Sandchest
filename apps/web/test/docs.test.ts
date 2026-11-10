/**
 * The docs and legal pages, checked against the code they describe: prices
 * and credit costs come from @sandchest/billing, every internal link points
 * at a real page and heading, and nothing names a model vendor.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  catalog,
  CREDIT_AMOUNTS,
  CREDIT_PACK,
  CREDIT_PRICE,
  CREDIT_TIERS,
  CREDIT_UNIT,
  creditsPrice,
  creditsSaving,
  DEEP_SCAN_TIERS,
  deepScanCredits,
  DEFAULT_TOP_UP_LIMIT_USD,
  FREE_CREDITS,
  isTrial,
  MAX_PURCHASE_CREDITS,
  PLAN,
  PLANS,
  purchasable,
  TOP_UP_BELOW,
} from "@sandchest/billing";
import { setupPrompt } from "@/lib/agent-prompt";
import { site } from "@/lib/site";

const root = join(import.meta.dir, "..");
const docsDir = join(root, "content/docs");
const legalDir = join(root, "content/legal");
const read = (file: string) => readFileSync(file, "utf8");
const mdx = (dir: string) => readdirSync(dir).filter((file) => file.endsWith(".mdx"));
const doc = (name: string) => read(join(docsDir, `${name}.mdx`));
const money = (n: number) => `$${n.toLocaleString("en")}`;
const count = (n: number) => n.toLocaleString("en");

/** The rows of the first Markdown table after `heading`, as trimmed cells. */
function table(source: string, heading: string): string[][] {
  const start = source.indexOf(heading);
  if (start < 0) throw new Error(`No heading ${heading}`);
  const lines = source.slice(start).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith("|")) break;
    rows.push(line.split("|").slice(1, -1).map((cell) => cell.trim()));
  }
  return rows.slice(2); // header and separator
}

describe("pricing matches the billing package", () => {
  const pricing = doc("pricing");
  /** "100": the credits sold for one price. */
  const pack = count(CREDIT_PACK);
  /** How many of today's credits each credit from before the switch became. */
  const factor = catalog(CREDIT_UNIT).pack / catalog("dollar").pack;

  test("the plan", () => {
    expect(table(pricing, "## Plans")).toEqual([[PLAN.name, money(PLAN.price), "Bought as you need them", `${money(CREDIT_PRICE)} per ${pack}, down to $${CREDIT_TIERS.at(-1)!.price.toFixed(2)} per ${pack} in bulk`]]);
    expect(pricing).toContain(`credits bought ahead at ${pack} for ${money(CREDIT_PRICE)}, less when you buy more at once`);
    expect(pricing).toContain(`Balances were multiplied by ${factor} when a credit changed from $1 to 1 cent, so nobody's balance lost value.`);
  });

  test("earlier plans keep their price, with their monthly credits in today's credits", () => {
    const retired = PLANS.filter((plan) => !plan.offered && !isTrial(plan.id));
    expect(table(pricing, "### Earlier plans")).toEqual(retired.map((plan) => [plan.name, money(plan.price), count(plan.credits)]));
    expect(pricing).toContain(`Its monthly credits are ${factor} times what they were.`);
  });

  test("what a scan usually costs is said in words, against a pack of credits, the same on every page", () => {
    for (const page of [pricing, doc("scans")]) {
      expect(page).toContain(`well under ${pack} credits`);
      expect(page).toContain("a few credits or less");
      // Nothing a server setting decides is a number on the page: the most a scan can cost is shown before it starts.
      expect(page).not.toMatch(/up to [\d,]+ credits/i);
    }
    expect(pricing).toContain(`A deep scan usually costs well under ${pack} credits.`);
  });

  test("repositories of a million lines or more are not scanned", () => {
    expect(DEEP_SCAN_TIERS.at(-1)!.maxLoc).toBe(1_000_000);
    expect(deepScanCredits(DEEP_SCAN_TIERS.at(-1)!.maxLoc)).toBeUndefined();
    expect(pricing).toContain("Repositories of a million lines or more aren't scanned at all");
  });

  test("buying credits and auto top-up", () => {
    const amounts = CREDIT_AMOUNTS.map(count);
    expect(pricing).toContain(
      `Credits are ${pack} for ${money(CREDIT_PRICE)} and never expire. They come in packs of ${pack}, so the smallest purchase is ${pack} credits. Buy ${amounts.slice(0, -1).join(", ")} or ${amounts.at(-1)} when you join, and up to ${count(MAX_PURCHASE_CREDITS)} at once after that.`,
    );
    expect(purchasable(CREDIT_PACK)).toBe(true);
    expect(purchasable(CREDIT_PACK - 1)).toBe(false);
    const [, ...bulk] = CREDIT_TIERS.map((tier) => `${count(tier.from)} or more${tier === CREDIT_TIERS[1] ? " are" : ""} $${tier.price.toFixed(2)}${tier === CREDIT_TIERS[1] ? ` per ${pack}` : ""}`);
    expect(pricing).toContain(`Buying more at once costs less: ${bulk.slice(0, -1).join(", ")}, and ${bulk.at(-1)}.`);
    // The credit price table, one row per tier, with a worked example at its first amount offered.
    const cash = (n: number) => (Number.isInteger(n) ? money(n) : `$${n.toFixed(2)}`);
    const example = (credits: number) => {
      const saving = creditsSaving(credits);
      return `${count(credits)} for ${cash(creditsPrice(credits))}${saving > 0 ? `, saving ${cash(saving)}` : ""}`;
    };
    expect(pricing).toContain(`| Credits bought at once | Per ${pack} credits | For example |`);
    expect(table(pricing, "## Buying credits")).toEqual(
      CREDIT_TIERS.map((tier, i) => {
        const next = CREDIT_TIERS[i + 1];
        const amount = CREDIT_AMOUNTS.find((n) => n >= tier.from && (!next || n < next.from))!;
        return [next ? `${count(tier.from)} to ${count(next.from - 1)}` : `${count(tier.from)} or more`, `$${tier.price.toFixed(2)}`, example(amount)];
      }),
    );
    expect(pricing).toContain(`Testers can claim ${count(FREE_CREDITS.credits)} free credits from [sandchest.com/claim](/claim), or by typing a tester's code`);
    expect(pricing).toContain(`when fewer than ${count(TOP_UP_BELOW)} are left`);
    expect(pricing).toContain(`run low (below ${count(TOP_UP_BELOW)})`);
    expect(pricing).toContain(`It spends at most ${money(DEFAULT_TOP_UP_LIMIT_USD)} a month unless you change that`);
  });

  test("getting started says the same price", () => {
    expect(doc("index")).toContain(`It's ${money(PLAN.price)} a month, and credits are ${pack} for ${money(CREDIT_PRICE)}, less when you buy more at once.`);
  });
});

describe("structure", () => {
  test("the sidebar lists every docs page once, in the spec's order", () => {
    const meta = JSON.parse(read(join(docsDir, "meta.json"))) as { pages: string[] };
    expect(meta.pages).toEqual(["index", "agents", "pricing", "scans", "findings", "cves", "fixing", "self-hosting", "security", "acceptable-use"]);
    expect([...meta.pages].sort()).toEqual(mdx(docsDir).map((file) => file.replace(/\.mdx$/, "")).sort());
  });

  test("every page has a title and a description", () => {
    for (const file of [...mdx(docsDir).map((f) => join(docsDir, f)), ...mdx(legalDir).map((f) => join(legalDir, f))]) {
      const front = read(file).split("---")[1] ?? "";
      expect(front, file).toMatch(/^title: \S/m);
      expect(front, file).toMatch(/^description: \S/m);
    }
  });

  test("the agent setup prompt leads Getting started and matches the copy button's", () => {
    const prompt = `\`\`\`text\n${setupPrompt("https://www.sandchest.com")}\n\`\`\``;
    for (const name of ["index", "agents"]) expect(doc(name), name).toContain(prompt);
    expect(doc("index").match(/^## .+$/m)?.[0]).toBe("## Set up with your agent");
  });

  test("docs pages are plain Markdown, so their Markdown copies are complete", () => {
    for (const file of mdx(docsDir)) expect(doc(file.replace(/\.mdx$/, "")), file).not.toMatch(/^(import|export) |<[A-Z]/m);
  });
});

describe("links", () => {
  /** App routes that render a page or a file: src/app, without route groups or dynamic segments. */
  function appRoutes(dir = join(root, "src/app"), routes = new Set<string>()): Set<string> {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) appRoutes(path, routes);
      else if (/^(page\.tsx|route\.ts)$/.test(name)) {
        const url = `/${relative(join(root, "src/app"), dir)}`.replace(/\/\([^)]+\)/g, "").replace(/\/$/, "") || "/";
        if (!url.includes("[")) routes.add(url);
      }
    }
    return routes;
  }

  /** github-slugger's ids for ASCII headings, as remark-heading writes them. */
  const slug = (heading: string) =>
    heading
      .toLowerCase()
      .replace(/[^a-z0-9 _-]/g, "")
      .replace(/ /g, "-");
  const headings = (source: string) => new Set([...source.matchAll(/^#{2,3} (.+)$/gm)].map((m) => slug(m[1]!.replace(/[`*]/g, ""))));

  const routes = appRoutes();
  const pages = new Map<string, string>();
  for (const file of mdx(docsDir)) pages.set(file === "index.mdx" ? "/docs" : `/docs/${file.replace(/\.mdx$/, "")}`, read(join(docsDir, file)));
  for (const file of mdx(legalDir)) pages.set(`/${file.replace(/\.mdx$/, "")}`, read(join(legalDir, file)));

  test("the app has a route for every page and Markdown file", () => {
    for (const path of ["/terms", "/privacy", "/acceptable-use", "/llms.txt", "/llms-full.txt"]) expect(routes.has(path), path).toBe(true);
    for (const file of ["docs/[[...slug]]/page.tsx", "docs-md/[[...slug]]/route.ts"]) expect(existsSync(join(root, "src/app", file)), file).toBe(true);
  });

  test("every internal link reaches a page, and every anchor a heading", () => {
    const broken: string[] = [];
    for (const [from, source] of pages) {
      const targets = [...source.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((href) => !/^(https?:|mailto:)/.test(href));
      for (const href of targets) {
        const [path, hash] = href.split("#") as [string, string | undefined];
        const target = path === "" ? from : path;
        const page = pages.get(target);
        if (!page && !routes.has(target)) broken.push(`${from} → ${href}`);
        else if (hash && page && !headings(page).has(hash)) broken.push(`${from} → ${href} (no heading)`);
        else if (hash && !page) broken.push(`${from} → ${href} (anchor on a page without content)`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("the site header and footer point at real pages", () => {
    for (const href of Object.values(site.links)) expect(routes.has(href) || pages.has(href), href).toBe(true);
  });
});

describe("what the pages must never say", () => {
  const all = [...mdx(docsDir).map((f) => join(docsDir, f)), ...mdx(legalDir).map((f) => join(legalDir, f)), join(root, "src/lib/legal.ts")];

  test("no internal numbers", () => {
    const internal = /\b(margins?|model cost|cost per scan|recall|precision)\b/i;
    for (const file of all) expect(read(file), file).not.toMatch(internal);
  });

  // Vendor and model names can't be listed in a public repository, so the list lives outside it:
  // SANDCHEST_BANNED_TERMS (comma-separated) or evals/private/banned-terms.txt (one per line, gitignored).
  const bannedFile = join(root, "../../evals/private/banned-terms.txt");
  const bannedTerms = (process.env.SANDCHEST_BANNED_TERMS ?? (existsSync(bannedFile) ? read(bannedFile) : ""))
    .split(/[,\n]/)
    .map((term) => term.trim())
    .filter((term) => term && !term.startsWith("#"));

  test.skipIf(bannedTerms.length === 0)("no model vendor names (needs the private banned-terms list)", () => {
    const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const banned = new RegExp(`\\b(${bannedTerms.map(escape).join("|")})\\b`, "i");
    for (const file of all) expect(read(file), file).not.toMatch(banned);
  });

  test("legal facts live only in lib/legal.ts", () => {
    for (const file of mdx(legalDir)) {
      const source = read(join(legalDir, file));
      expect(source, file).toContain('import { legal } from "@/lib/legal";');
      // No email addresses or bracketed placeholders typed into the page itself.
      expect(source.replace(/^import .*$/m, ""), file).not.toMatch(/[\w.+-]+@[\w-]+\.\w+|\[[A-Z][^\]]*\](?!\()/);
    }
  });
});
