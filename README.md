<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="sandchest-logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="sandchest-logo.svg" />
    <img src="sandchest-logo.svg" alt="Sandchest" width="200" />
  </picture>
</p>

<h3 align="center">The sandbox platform for AI agents</h3>

<p align="center">
  From the team behind <a href="https://cap.so">Cap</a>
</p>

---

## What is Sandchest?

Sandchest is a sandbox platform built for AI agent code execution. Every sandbox is an isolated Linux VM that can be **forked in sub-100ms**. Memory, filesystem, everything. Your agents can explore, fail, revert, and try again without consequence.

Most sandbox tools give agents one shot. Sandchest gives them undo.

## Why?

AI agents need to execute code. The current options are containers with no real isolation, clunky VM setups, or sandboxes that treat every run as disposable. None of them give agents what they actually need: the ability to try things, backtrack when they fail, and branch into multiple approaches without starting over.

Sandchest is built around **forkable VMs**. An agent can set up an environment, fork it, try something risky in the fork, and destroy it if it doesn't work. The original is untouched. This makes agents fundamentally smarter because the infrastructure supports exploration.

## Features

- **Sub-100ms VM forking** - fork a running sandbox's full state (memory + disk)
- **VM-grade isolation** - every sandbox is a real virtual machine, not a container
- **TypeScript SDK** - `@sandchest/sdk` with a simple, modern API
- **Python SDK** - `sandchest` on PyPI with full feature parity
- **CLI** - `sandchest create`, `sandchest exec`, `sandchest fork`, `sandchest ssh`
- **MCP server** - `@sandchest/mcp` for Claude Code and other AI tools
- **GitHub Action** - provision sandboxes in CI/CD workflows
- **Session replay** - every sandbox session is fully replayable (logs, actions, file changes) from the dashboard or as full context for agents in the CLI

## Quick start

```bash
npm install @sandchest/sdk
```

```typescript
import Sandchest from "@sandchest/sdk";

const sandchest = new Sandchest();

const sb = await sandchest.create();
await sb.exec("git clone repo && npm install");

// try something risky in a fork
const fork = await sb.fork();
const result = await fork.exec("npm test");

if (result.exitCode !== 0) {
  await fork.destroy(); // original untouched
}
```

## Project structure

```
apps/api            — Control plane API (EffectTS)
apps/web            — Dashboard + replay page (Next.js 15)
apps/docs           — Documentation site (Fumadocs)
packages/sdk-ts     — TypeScript SDK (@sandchest/sdk)
packages/sdk-py     — Python SDK (sandchest)
packages/mcp        — MCP server (@sandchest/mcp)
packages/cli        — CLI tool (sandchest)
packages/contract   — Shared types + protobuf definitions
packages/db         — Database schema + migrations (Drizzle)
packages/github-action — GitHub Action for CI/CD
crates/             — Rust node daemon + guest agent
```

## Development

```bash
bun install       # install dependencies
bun test          # run tests
```

## License

Sandchest is dual-licensed:

- **Core** (SDK, CLI, MCP server, contract, node daemon, guest agent) — [MIT](LICENSE-MIT)
- **Web & API** (`apps/`) — [GPL-3.0](LICENSE-GPL)
