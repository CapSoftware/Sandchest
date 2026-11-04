# Repository rules

These apply to everyone contributing to this repository, human or agent.

## Never commit

- **Personal data**: names, emails, usernames, IP addresses, customer or user identifiers, or anything that identifies a person or organisation. Use obvious placeholders (`user@example.com`, `acme/app`).
- **Real scan output**: findings, logs, threat models or code excerpts from any real repository.
- **Eval data**: benchmarks, fixtures, judgements, labels and run results. They live in a separate private data repository checked out at `evals/private/` (gitignored); only the harness code lives in `evals/`.
- **Secrets**: API keys, tokens, private keys, `.env` files. Use `.env.example` with empty values.
- **Model vendor references**: the code is provider-agnostic. Refer to model *roles* (`recon`, `hunt`, `skeptic`, `structure`) and the generic `LLM_*` environment variables, never to specific vendors or hosted model IDs.

## Prompts and logs

- Model prompts must never contain repo names, org names or user identifiers.
- Application logs and analytics events must not record source code, finding contents or personal data beyond opaque internal IDs.

Check `git diff --staged` for any of the above before every commit.

## Before pushing

Pushing to `main` deploys. Run `git config core.hooksPath .githooks` once per clone: the pre-push hook then runs the type check, the tests, and `bun run check:build`, which builds from a clean checkout with no `.env` files, as the deploy does. A page that reads the database, the session or server settings has to opt out of build-time rendering (`await connection()`, or read `searchParams`/cookies first), or that build fails.
