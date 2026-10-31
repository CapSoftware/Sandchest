# Evals

Measures how well the engine finds real vulnerabilities (recall) and how
often what it reports is real (precision), plus time and cost per scan.

```sh
bun run indexer:build            # once, and after indexer changes
bun run evals                    # every benchmark
bun run evals juice-shop dvwa    # a subset
bun run evals --parallel 2       # two benchmarks at a time
bun run evals --rescore evals/results/<run>   # re-score saved scans
```

The model is configured with `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`
in `.env.local`. Set `LLM_PRICE_*` to report cost (see `.env.example`).

## Benchmarks

Each file in [`benchmarks/`](benchmarks) pins a repository to a commit (or
points at a fixture in this directory) and lists the vulnerabilities a
careful reviewer would report, with the lines they would cite:

- **Intentionally vulnerable apps** (`juice-shop`, `nodegoat`, `dvwa`,
  `crapi`) measure recall on well-known bugs across Node, PHP, Java, Python
  and Go.
- **`seeded-app`** ([`fixtures/seeded-app`](fixtures/seeded-app)) is a small
  Next.js and Postgres app with planted bugs in modern code, next to safe
  code that looks dangerous.
- **Clean repositories** (`clean-*`) are well-maintained applications. Every
  serious finding there is a false-positive candidate.

`decoys` are lines that look dangerous but are safe; a finding whose sink
lands on one is a known false positive.

Remote benchmarks are fetched once into `.sandchest/benchmarks/`.

## Scoring

A finding matches an expected vulnerability when any line it cites (entry
point or path hop) falls within an expected location, give or take five
lines, and its category or CWE agrees. Committed secrets also count when a
secret lead lands on the location.

- **Recall** is over expected critical and high vulnerabilities, pooled
  across the vulnerable benchmarks. Target: at least 70%.
- **Precision** is over the findings the product shows by default (critical
  and high, not low confidence). Matches and findings judged real are true
  positives; decoy hits and findings judged false are false positives.
  Anything else is unjudged, so precision is shown as a range: unjudged
  counted as false, then left out. Target: at least 80%.
- **Time**: median deep scan under 15 minutes.

## Judging

Unmatched findings are listed in `evals/results/<run>/unjudged.md`. Record a
verdict by adding the fingerprint to
`evals/private/judgements/<benchmark>.json`:

```json
{ "3f9c0a1b2c3d4e5f": "real", "0a1b2c3d4e5f6a7b": "false_positive" }
```

Fingerprints are stable across scans, so judgements carry over to later
runs. Re-score a saved run with `--rescore`.

## Real-world targets

`bun run evals --private` scans the repositories listed in
`evals/private/targets.json` (`[{ "name": "my-app", "path": "/abs/path" }]`)
and writes reports to `evals/private/results/`. Only scan code you own.

## Privacy

Scan reports contain code excerpts and, for real-world targets, live
vulnerabilities. `evals/results/` and `evals/private/` are gitignored; never
commit anything from them.
