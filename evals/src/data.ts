/**
 * Where the eval data lives. Benchmarks, fixtures, judgements, labels, fix
 * pairs and run history are kept out of this repository, in a private data
 * repository checked out at `evals/private` (gitignored here), so the test
 * set never leaks into training data or gets tuned against in public.
 * Override the location with SANDCHEST_EVALS_DIR.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "../..");
export const DATA_DIR = resolve(process.env.SANDCHEST_EVALS_DIR ?? join(REPO_ROOT, "evals/private"));

export const RUNS_DIR = join(DATA_DIR, "runs");
export const JUDGEMENTS_DIR = join(DATA_DIR, "judgements");
export const LABELS_DIR = join(DATA_DIR, "labels");
export const FIXPAIRS_DIR = join(DATA_DIR, "fixpairs");
export const HISTORY_FILE = join(DATA_DIR, "history.jsonl");

/** Fails with instructions when the private data repository isn't checked out. */
export function requireData(): void {
  if (existsSync(join(DATA_DIR, "benchmarks"))) return;
  throw new Error(
    `No eval data at ${DATA_DIR}. Clone the private eval data repository into evals/private, or set SANDCHEST_EVALS_DIR to its checkout.`,
  );
}
