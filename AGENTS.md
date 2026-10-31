# Repository rules

These apply to everyone contributing to this repository, human or agent.

## Never commit

- **Personal data**: names, emails, usernames, IP addresses, customer or user identifiers, or anything that identifies a person or organisation. Use obvious placeholders (`user@example.com`, `acme/app`).
- **Real scan output**: findings, logs, threat models or code excerpts from any real repository. These go in `evals/private/`, which is gitignored. Only the public benchmark set lives in `evals/`.
- **Secrets**: API keys, tokens, private keys, `.env` files. Use `.env.example` with empty values.
- **Model vendor references**: the code is provider-agnostic. Refer to model *roles* (`recon`, `hunt`, `skeptic`, `structure`) and the generic `LLM_*` environment variables, never to specific vendors or hosted model IDs.

## Prompts and logs

- Model prompts must never contain repo names, org names or user identifiers.
- Application logs and analytics events must not record source code, finding contents or personal data beyond opaque internal IDs.

Check `git diff --staged` for any of the above before every commit.
