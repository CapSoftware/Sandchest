/**
 * The database side of the switch to a cent credit, for an operator, step 4 of the runbook in
 * `apps/web/scripts/credit-unit-switch.ts`. Never run by a migration or a deploy.
 *
 *   bun packages/db/src/credit-unit-cli.ts status
 *   bun packages/db/src/credit-unit-cli.ts convert                                  # dry run: what it would change
 *   bun packages/db/src/credit-unit-cli.ts convert --confirm-convert-credits-to-cents
 *   bun packages/db/src/credit-unit-cli.ts revert --confirm-revert-credits-to-dollars
 *
 * Reads DATABASE_URL from the environment it is run with, and no env file. `convert` and `revert` change anything
 * only with their flag, with SANDCHEST_BILLING_FREEZE=1 in that environment (the deployment must be frozen too),
 * with no scan holding credits, and (`convert`) once the provider side has verified every customer with a plan or
 * credits. Each is one transaction under a marker row: a crash changes nothing, and a second run does nothing.
 */
import { createDb } from "./client";
import { conversionPlan, convertCredits, customerJournalSummary, heldCreditScans, revertCredits, unswitchedOrgs, type ConversionPlan } from "./credit-unit";

const [command, ...flags] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !["status", "convert", "revert"].includes(command ?? "")) {
  console.error("Usage: DATABASE_URL=... bun packages/db/src/credit-unit-cli.ts status | convert [--confirm-convert-credits-to-cents] | revert [--confirm-revert-credits-to-dollars]");
  process.exit(2);
}
const where = new URL(url);
console.log(`Database: ${where.pathname.slice(1)} on ${where.hostname}`);

const database = createDb(url, { max: 1 });
try {
  process.exitCode = await main(command!, flags);
} finally {
  await database.$client.end();
}

async function main(command: string, flags: string[]): Promise<number> {
  const plan = await conversionPlan(database);
  const journal = await customerJournalSummary(database);
  const missing = await unswitchedOrgs(database);
  print(plan, journal, missing);
  if (command === "status") return 0;

  const flag = command === "convert" ? "--confirm-convert-credits-to-cents" : "--confirm-revert-credits-to-dollars";
  const problems: string[] = [];
  if (process.env.SANDCHEST_BILLING_FREEZE !== "1") problems.push("SANDCHEST_BILLING_FREEZE is not 1 here: freeze the deployment, and run this with it set");
  if ((await heldCreditScans(database)) > 0) problems.push("scans still hold credits: wait for them to settle");
  if (command === "convert") {
    if (plan.marker === "converted") problems.push("converted already: nothing to do");
    if (journal.unfinished.length > 0 || Object.keys(journal.byStep).length === 0) problems.push("the provider side has not verified every customer it started (or none): run it first");
    if (missing.length > 0) problems.push(`${missing.length} org(s) with a plan or credits have no verified customer: ${missing.slice(0, 10).join(", ")}`);
  } else if (plan.marker !== "converted") problems.push("not converted: nothing to revert");

  if (!flags.includes(flag)) {
    console.log(`\nDry run: nothing changed.${problems.length ? `\nIt would refuse now:\n  ${problems.join("\n  ")}` : ` To ${command}, run again with ${flag}.`}`);
    return 0;
  }
  if (problems.length > 0) {
    console.error(`Refused, nothing changed:\n  ${problems.join("\n  ")}`);
    return 1;
  }
  if (command === "convert") {
    const outcome = await convertCredits(database);
    if (!outcome.done) {
      console.error(`Refused, nothing changed: ${outcome.reason}`);
      return 1;
    }
    console.log("Converted: every amount of credits is now in cents, every carry is 0.");
    return 0;
  }
  const outcome = await revertCredits(database);
  if (!outcome.done) {
    console.error(`Refused, nothing changed: ${outcome.reason}`);
    return 1;
  }
  console.log("Reverted: every amount of credits is back in dollars, and the carries are restored.");
  return 0;
}

function print(plan: ConversionPlan, journal: Awaited<ReturnType<typeof customerJournalSummary>>, missing: string[]): void {
  const row = (name: string, a: { rows: number; sum: number; max: number }) => `  ${name}: ${a.rows} rows, ${a.sum} credits in all, largest ${a.max} -> x100`;
  console.log(`Marker: ${plan.marker}. Scans holding credits: ${plan.heldScans}.`);
  console.log(`Provider side: ${JSON.stringify(journal.byStep)}${journal.unfinished.length ? `; not verified: ${journal.unfinished.map((u) => `${u.customerId} at ${u.step}${u.error ? ` (${u.error})` : ""}`).join("; ")}` : ""}`);
  if (missing.length) console.log(`Orgs with a plan or credits and no verified customer: ${missing.length}`);
  console.log("Convert would:");
  console.log(row("scans.credits", plan.scansCredits));
  console.log(row("scans.credits_reserved", plan.scansReserved));
  console.log(row("credit_claims.credits", plan.creditClaims));
  console.log(row("org_billing.credits", plan.orgBillingCredits));
  console.log(`  org_billing.auto_top_up threshold and quantity: ${plan.orgBillingAutoTopUp.rows} rows -> x100`);
  console.log(`  orgs.settings.autoTopUp.quantity: ${plan.orgSettingsAutoTopUp.rows} rows -> x100`);
  console.log(`  usage_carry: ${plan.carries.length} above 0 (${plan.carries.reduce((s, c) => s + c.microUsd, 0)} micro-dollars in all) -> 0`);
  console.log("  scan_bills, scan_usage: unchanged");
}
