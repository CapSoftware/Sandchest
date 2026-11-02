/**
 * How findings ended, by the signal that raised them — the evidence for tuning
 * thresholds, hunters and prompts. Reads only enum values and counts.
 *
 *   bun run outcomes
 *
 * "Precision" here is fixed ÷ (fixed + false positive): of the findings a team
 * reached a verdict on, the share that were real. Open findings have no verdict yet.
 */
import { createDb, outcomeStats, type OutcomeRow } from "@sandchest/db";

const database = createDb(process.env.DATABASE_URL!, { max: 1 });
const rows = await outcomeStats(database);
await database.$client.end();

function table(title: string, key: (row: OutcomeRow) => string): void {
  const groups = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const group = groups.get(key(row)) ?? {};
    group[row.outcome] = (group[row.outcome] ?? 0) + row.count;
    groups.set(key(row), group);
  }
  console.log(`\n${title}`);
  console.log(`${"".padEnd(28)}${["open", "fixed", "false_pos", "accepted", "precision"].map((h) => h.padStart(10)).join("")}`);
  for (const [name, counts] of [...groups].sort((a, b) => sum(b[1]) - sum(a[1]))) {
    const fixed = counts.fixed ?? 0;
    const fp = counts.false_positive ?? 0;
    const accepted = (counts.accepted_risk ?? 0) + (counts.wont_fix ?? 0);
    const precision = fixed + fp > 0 ? `${Math.round((100 * fixed) / (fixed + fp))}%` : "—";
    console.log(`${name.padEnd(28)}${[counts.open ?? 0, fixed, fp, accepted].map((n) => String(n).padStart(10)).join("")}${precision.padStart(10)}`);
  }
}
const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

const decided = rows.filter((r) => r.outcome !== "open").reduce((n, r) => n + r.count, 0);
console.log(`${rows.reduce((n, r) => n + r.count, 0)} finding-signal pairs; ${decided} with a team verdict.`);
table("By signal", (row) => row.source);
table("By trust tier", (row) => row.trust);
table("By category", (row) => row.category);
if (decided < 30) console.log(`\nOnly ${decided} verdicts so far: treat precision figures as anecdotes until there are a few hundred.`);
