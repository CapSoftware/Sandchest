# Evals

Measures how well the engine finds real vulnerabilities (recall), how often
what it reports is real (precision), and everything that makes a report
worth reading: duplicates, severity, test-code noise, false positives on
fixed code, stability across runs, time and cost.

This directory holds the harness. The data it runs on (benchmarks, planted
fixtures, judgements, labels, run history) lives in a private repository
checked out at `evals/private` (gitignored here), or wherever
`SANDCHEST_EVALS_DIR` points. Keeping the test set private stops it leaking
into model training data or being tuned against. Without the data checkout,
the commands below stop with instructions.

```sh
bun run indexer:build                   # once, and after indexer changes
bun run gate                            # every engine change first: coverage + reverify + fpcheck vs a baseline (dollars)
bun run coverage [name|tag]             # does each bug's handler reach a hunter? no hunt (free with the classifier cache)
bun run evals                           # benchmarks tagged `core`
bun run evals cve --repeat 2 --note "…" # by tag or name; `all` for everything
bun run evals --rescore <run>           # re-score saved scans, e.g. after judging
bun run scorecard <run> --baseline <run>
bun run judge <run>                     # the findings still needing a verdict
bun run fpcheck                         # skeptic on vulnerable vs fixed code (cents)
bun run fixeval                         # does a push close fixed findings, and only those? (cents)
bun run restage <run>                   # replay the final merge of repeat reports on saved scans (cents)
bun run validate --fetch                # every cited line exists at its commit
bun run prod                            # production quality, from the read replica
```

Run `bun run gate` before a full benchmark run: most changes sit after the
hunt (skeptic, severity, merging) or before it (which entry points the hunters
see), and both are measured there for a few dollars. A full run costs
20–30 times as much; save it for validating what the gate passed, then `bun run gate
--accept` to make that the new baseline. Classifier answers are cached in
`cache/classifier/` in the data, so entry-point recovery is billed once per
pinned benchmark and no longer varies between runs.

The model is configured with `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`
in `.env.local`. Set `LLM_PRICE_*` to report cost (see `.env.example`).

## Benchmarks

A benchmark pins a repository to a commit (or points at a fixture in the
data repository) and lists the vulnerabilities a careful reviewer would
report, with the lines they would cite. Tags choose run sets:

- `core`: intentionally vulnerable apps across languages, a small app with
  planted bugs next to safe look-alikes, and well-maintained clean apps.
  Run on every engine change.
- `cve`: real, published advisories in real applications, pinned to the
  commit before the fix. Each also names the fixing commit (`patched`), and
  carries a hunter-shaped `replay` of the bug for `fpcheck`.
- `large`: repositories over 200k LOC, where a fixed scan budget is thinnest.

`decoys` are lines that look dangerous but are safe.

## Scoring

A finding matches an expected vulnerability when its sink, or at least two
of the lines it cites, fall within an expected location (give or take five
lines) and its category or CWE agrees. Each expected location is credited to
one finding and each finding to one location (a maximum matching, earlier
findings first), so a finding whose lines also fall in a neighbouring bug's
range doesn't take both. Findings that match only locations already credited
are duplicates.

| Number | Meaning |
|---|---|
| Recall | Expected critical and high bugs found, pooled across vulnerable benchmarks. |
| Recall as shown | Same, counting only bugs found by a finding shown by default (critical/high, not low confidence). The gap to recall is bugs we found and rated too low to show. |
| Precision (strict) | Of unique shown findings: true positives ÷ all, unjudged counted as false. The number we hold to. "Judged only" leaves unjudged out. |
| Duplicate rate | Shown findings that repeat a bug already reported in the same scan. |
| Bugs hidden by merging | The engine merges repeat reports of one issue (`report.merged`). A merge that absorbed a finding matching an expected bug no kept finding reports, or one judged a distinct real bug, hid it. Should be 0. |
| Test/fixture code | Shown findings whose every cited line is in tests, fixtures or examples. |
| Severity | Severity of the best match against the expected severity. |
| Fixed bugs re-flagged | Scanning the fixing commit of a `cve` benchmark: fixed bugs still reported at their patched location. Each is a confirmed false positive; the fix is the ground truth. |
| Same fingerprint across runs | With `--repeat`, of bugs found in two runs, the share reported under the same fingerprint. Below 100%, a rescan files the same bug again as new. |
| Cost, time | Per run, per 100k LOC, median minutes. |

Every run is compared with the last comparable one, both re-scored with the
current scorer and judgements on the benchmarks they share, and changes
beyond run-to-run noise are flagged. Single runs move about ±4 points in
recall with no change at all, so use `--repeat` before trusting a small
difference.

## Judging

Strict precision only rises when unmatched findings are judged.
`bun run judge <run>` writes the queue, in full, to the run's `judge.md`.
Record verdicts with `bun run judge set` (or `judge apply` for a batch):
`real`, `false_positive`, `not_security` (true, but nobody but the attacker
is harmed), `test_code` or `duplicate` (of a fingerprint, or `expected:<id>`
when the line ranges missed a match; a duplicate counts as the bug it repeats
when that bug isn't otherwise in the scan). Fingerprints are stable across
scans, so verdicts carry over to later runs.

## Privacy

Scan reports contain code excerpts and, for real-world targets, live
vulnerabilities. Everything the harness writes goes to the data
repository; nothing from it is committed here. Production findings on
repositories we don't own are labelled by id only.
