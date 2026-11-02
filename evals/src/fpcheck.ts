/**
 * False-positive check: replay a known finding against the VULNERABLE and the
 * PATCHED version of the same code. Confirming it on the vulnerable version is
 * a true positive (recall on the real bug). Confirming it on the PATCHED
 * version — where the fix is present — is a *confirmed false positive*: the
 * skeptic failed to recognize the fix, the exact failure mode behind our
 * real-world FPs (a guard the model missed).
 *
 * This is the principled way to measure precision, because genuine confirmed
 * false positives are otherwise rare: the fix defines the ground truth.
 *
 *   bun run fpcheck [pairs.json] [--repeat N] [--ground]
 *
 * A pair is { name, vulnerableDir, patchedDir, candidate, threatModel }.
 * Dirs are local checkouts (the patched/vulnerable source); the indexer runs
 * on each. Repeats average the skeptic's nondeterminism.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLlmClient, loadLlmConfig, startLocalIndexer } from "@sandchest/engine";
import { loadPricing, verifyFindings, type Candidate, type ThreatModel } from "@sandchest/engine/scan";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { repeat: { type: "string", default: "3" }, ground: { type: "boolean", default: false } },
});

interface Pair {
  name: string;
  vulnerableDir: string;
  patchedDir: string;
  candidate: Candidate;
  threatModel: ThreatModel;
}

const pairsFile = resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0] ?? "evals/private/fixpairs.json");
const pairs = JSON.parse(await readFile(pairsFile, "utf8")) as Pair[];
const repeat = Math.max(1, Math.floor(Number(values.repeat)) || 1);
const client = createLlmClient(loadLlmConfig());
const pricing = loadPricing();
let cost = 0;

/** The fraction of `repeat` runs in which the skeptic confirms the finding (shown, not low) on `dir`. */
async function confirmRate(dir: string, pair: Pair): Promise<number> {
  await using indexer = await startLocalIndexer(dir);
  await indexer.client.ready();
  let confirmed = 0;
  for (let run = 0; run < repeat; run++) {
    const { results, costUsd } = await verifyFindings({
      client,
      indexer: indexer.client,
      threatModel: pair.threatModel,
      findings: [pair.candidate],
      pricing,
      investigateAuth: values.ground,
    });
    cost += costUsd ?? 0;
    const review = results[0]?.review;
    if (review && review.verdict.verdict === "confirmed" && review.verdict.confidence !== "low") confirmed++;
  }
  return confirmed / repeat;
}

const pct = (x: number) => `${Math.round(100 * x)}%`;
console.log(`${"pair".padEnd(26)} vuln→confirmed  patched→confirmed (=FP)`);
let tp = 0;
let fp = 0;
for (const pair of pairs) {
  const vuln = await confirmRate(pair.vulnerableDir, pair);
  const patched = await confirmRate(pair.patchedDir, pair);
  tp += vuln;
  fp += patched;
  console.log(`${pair.name.padEnd(26)} ${pct(vuln).padStart(6)}          ${pct(patched).padStart(6)}`);
}
console.log(`\nPairs: ${pairs.length}, repeat ${repeat}${values.ground ? " (auth-grounded)" : ""}`);
console.log(`Recall on the real bug (confirmed on vulnerable): ${pct(tp / pairs.length)}  (want high)`);
console.log(`False positives (confirmed on patched):           ${pct(fp / pairs.length)}  (want 0 — re-flagging a fixed bug)`);
console.log(`Cost: $${cost.toFixed(2)}`);
