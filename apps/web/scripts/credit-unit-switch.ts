/**
 * The one-time switch from a dollar credit to a cent credit: the provider side, and the runbook for the whole
 * switch. Every balance and every amount of credits becomes 100 times as many; every dollar price stays the same.
 *
 *   bun --no-env-file apps/web/scripts/credit-unit-switch.ts status
 *   bun --no-env-file apps/web/scripts/credit-unit-switch.ts switch  [--customer <id>]... [--confirm-switch-credits-to-cents] [--live]
 *   bun --no-env-file apps/web/scripts/credit-unit-switch.ts top-ups [--customer <id>]... [--confirm-restore-top-ups] [--live]
 *   bun --no-env-file apps/web/scripts/credit-unit-switch.ts undo    [--customer <id>]... [--confirm-undo-switch] [--live]
 *
 * Env, from the shell it runs in (pass --no-env-file so Bun reads no .env file by itself): AUTUMN_SECRET_KEY and
 * optionally AUTUMN_BASE_URL (the Autumn environment it touches, printed before anything), DATABASE_URL (the journal
 * and the holds), SANDCHEST_BILLING_FREEZE=1. Without its confirm flag a command is a dry run that only reads and
 * prints what it would do. With it, it refuses unless SANDCHEST_BILLING_FREEZE is 1 here, no scan holds credits
 * (checked again before every customer), and, for a live key, --live is passed too. Every customer's progress is in
 * `credit_unit_switch`, so a run killed anywhere is resumed by running it again, and a second full run changes
 * nothing. What each step does and why is in `packages/billing/src/unit-switch.ts`.
 *
 * Runbook
 *
 * Before the day: migration 0023 is applied (`bun run migrate` in packages/db), this branch's code is deployed with
 * the dollar unit, and the whole sequence was rehearsed against Autumn's sandbox.
 *
 * 1. Freeze. Deploy with SANDCHEST_BILLING_FREEZE=1, still in dollars. Purchases, plan changes, auto top-up
 *    changes and free credit claims are refused; paid scans wait instead of holding credits; free scans and
 *    scans already holding credits carry on and settle; billing pages show the stored copy and nothing re-reads
 *    Autumn into it. Undo: deploy with it unset.
 * 2. Drain. Run `status` (here or `packages/db/src/credit-unit-cli.ts status`) until no scan holds credits:
 *    a running scan settles within its budget, and a hold nobody settles returns by itself after 6 hours. Undo:
 *    nothing to undo.
 * 3. Catalog. `NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT=cent bun run autumn:push --prod` in packages/billing (a preview),
 *    then again with --yes. It adds the cent version of every plan and makes it the one sold, and keeps the dollar
 *    versions, inactive, for the customers still on them. Only while frozen: from here anything bought buys cent
 *    credits. Undo: push the dollar config (`bun run autumn:push --prod --yes` without the unit), which takes the
 *    cent versions away again; only once no customer is on them (step 4 undone first).
 * 4. Provider. `switch` (a dry run: read it whole), then `switch --confirm-switch-credits-to-cents --live`. Per
 *    customer: record, auto top-up off, move to the cent plan version, every bucket times 100, verify. It stops at
 *    the first customer that is not exactly as expected and says why; fix that one (or leave it to a person) and run
 *    it again. Undo: `undo --confirm-undo-switch --live` (every customer it touched, or --customer for some) puts
 *    each back exactly as recorded: its dollar version, its balances and its auto top-up.
 * 5. Database. `DATABASE_URL=... SANDCHEST_BILLING_FREEZE=1 bun --no-env-file packages/db/src/credit-unit-cli.ts
 *    convert` (a dry run), then with --confirm-convert-credits-to-cents. One transaction: every amount of credits
 *    times 100, every usage carry to 0; refused until step 4 has verified every customer with a plan or credits.
 *    Undo: `revert --confirm-revert-credits-to-dollars`, only before step 7.
 * 6. Unit. Deploy with NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT=cent (a build setting: it needs a new build) and
 *    SANDCHEST_BILLING_FREEZE=1 still. Undo: deploy without the unit (then steps 5, 4 and 3 in that order).
 * 7. Top-ups. `top-ups` (a dry run), then `top-ups --confirm-restore-top-ups --live`: each customer's recorded auto
 *    top-up, buying 100 times its recorded quantity when fewer than the cent line (500) are left, with the same
 *    monthly limit. Undo: `undo` for the customers concerned puts their dollar top-up back (with steps 6 to 3).
 * 8. Verify. `status` here and in the database CLI: every customer `top_up_restored`, the marker `converted`. Open
 *    a few accounts in the dashboard and in Autumn: the same balance, times 100.
 * 9. Thaw. Deploy with SANDCHEST_BILLING_FREEZE unset. Price a purchase, buy the smallest pack (100 credits for $1)
 *    on a test account, and start a PR review. From here nothing is undone by these commands: amounts written in
 *    cents make a revert refuse.
 */
import { keyEnvironment, createSwitchApi, restoreTopUp, switchCustomer, SwitchStopped, undoCustomer, type JournalEntry, type SwitchJournal, type SwitchRecord, type SwitchStep } from "@sandchest/billing/unit-switch";
import { advanceCustomerJournal, conversionPlan, createDb, customerJournalIds, customerJournalRow, customerJournalSummary, failCustomerJournal, heldCreditScans, recordCustomerJournal, type Db } from "@sandchest/db";

const COMMANDS = { switch: "--confirm-switch-credits-to-cents", "top-ups": "--confirm-restore-top-ups", undo: "--confirm-undo-switch", status: "" } as const;
type Command = keyof typeof COMMANDS;

const args = process.argv.slice(2);
const command = args[0] as Command | undefined;
if (!command || !(command in COMMANDS)) {
  console.error("Usage: bun --no-env-file apps/web/scripts/credit-unit-switch.ts status | switch | top-ups | undo [--customer <id>]... [--confirm-...] [--live]");
  process.exit(2);
}
const customers = args.flatMap((arg, i) => (arg === "--customer" && args[i + 1] ? [args[i + 1]!] : []));
const confirmed = command !== "status" && args.includes(COMMANDS[command]);

const { AUTUMN_SECRET_KEY: key, AUTUMN_BASE_URL: baseUrl, DATABASE_URL: databaseUrl } = process.env;
if (!key || !databaseUrl) {
  console.error("Set AUTUMN_SECRET_KEY and DATABASE_URL in the environment this runs in.");
  process.exit(2);
}
const environment = keyEnvironment(key);
if (!environment) {
  console.error("AUTUMN_SECRET_KEY is neither a live nor a sandbox secret key. Nothing was done.");
  process.exit(2);
}
const api = createSwitchApi({ secretKey: key, baseUrl });
const where = new URL(databaseUrl);
console.log(`Autumn: ${environment === "live" ? "LIVE" : "sandbox"} at ${api.baseUrl}. Journal: database ${where.pathname.slice(1)} on ${where.hostname}.`);
console.log(confirmed ? `Running ${command} for real.` : `${command}: dry run, nothing will change.`);

const database = createDb(databaseUrl, { max: 2 });
try {
  process.exitCode = await main(command, database);
} finally {
  await database.$client.end();
}

async function main(command: Command, database: Db): Promise<number> {
  const journal = dbJournal(database);
  if (command === "status") {
    const summary = await customerJournalSummary(database);
    const plan = await conversionPlan(database);
    console.log(`Scans holding credits: ${await heldCreditScans(database)}. Database: ${plan.marker}.`);
    console.log(`Customers by step: ${JSON.stringify(summary.byStep)}`);
    for (const u of summary.unfinished) console.log(`  ${u.customerId} at ${u.step}${u.error ? `: ${u.error}` : ""}`);
    return 0;
  }

  const refusals = async () => {
    const problems: string[] = [];
    if (process.env.SANDCHEST_BILLING_FREEZE !== "1") problems.push("SANDCHEST_BILLING_FREEZE is not 1 here: freeze the deployment, and run this with it set");
    const held = await heldCreditScans(database);
    if (held > 0) problems.push(`${held} scan(s) hold credits: wait for them to settle`);
    if (environment === "live" && !args.includes("--live")) problems.push("this is the LIVE Autumn: pass --live as well");
    return problems;
  };
  const problems = await refusals();
  const marker = (await conversionPlan(database)).marker;
  if (command === "switch" && marker === "converted") problems.push("the database is converted already: switching more customers now would leave them in dollars there");
  if (command === "top-ups" && marker !== "converted") problems.push("the database is not converted yet (step 5): top-ups come after it, and after the cent deploy");
  if (problems.length > 0) {
    if (confirmed) {
      console.error(`Refused, nothing changed:\n  ${problems.join("\n  ")}`);
      return 1;
    }
    console.log(`It would refuse now:\n  ${problems.join("\n  ")}`);
  }

  const ids = customers.length > 0 ? customers : command === "switch" ? await api.customerIds() : await customerJournalIds(database);
  console.log(`${ids.length} customer(s).`);
  const log = (id: string, line: string) => console.log(`${id}: ${line}`);
  for (const id of ids) {
    if (confirmed) {
      // A hold, or a thaw, while this runs stops it before the next customer.
      const now = await refusals();
      if (now.length > 0) {
        console.error(`Stopped before ${id}, nothing more changed:\n  ${now.join("\n  ")}`);
        return 1;
      }
    }
    try {
      if (command === "switch") await switchCustomer(api, journal, id, { dryRun: !confirmed, log });
      else if (command === "top-ups") await restoreTopUp(api, journal, id, { dryRun: !confirmed, log });
      else await undoCustomer(api, journal, id, { dryRun: !confirmed, log });
    } catch (error) {
      console.error(error instanceof SwitchStopped ? `Stopped: ${error.message}` : `Stopped at ${id}: ${error instanceof Error ? error.message : String(error)}`);
      if (confirmed) return 1;
    }
  }
  console.log(confirmed ? "Done." : "Dry run: nothing changed.");
  return 0;
}

function dbJournal(database: Db): SwitchJournal {
  const entry = (row: { step: string; record: unknown }): JournalEntry => ({ step: row.step as SwitchStep, record: row.record as SwitchRecord });
  return {
    async get(id) {
      const row = await customerJournalRow(database, id);
      return row && entry(row);
    },
    async record(record) {
      return entry(await recordCustomerJournal(database, record.customerId, record));
    },
    advance: (id, step, result) => advanceCustomerJournal(database, id, step, result),
    fail: (id, error) => failCustomerJournal(database, id, error),
  };
}

