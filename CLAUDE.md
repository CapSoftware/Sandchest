# Sandchest — Development Guide

## Project Overview

Sandchest is a Linux-only sandbox platform for AI agent code execution. Every sandbox is a Firecracker microVM with VM-grade isolation, sub-second fork capability, and a permanent session replay URL.

**Polyglot monorepo:**
- `apps/api` — Control plane HTTP API (EffectTS on Node.js)
- `apps/web` — Replay page (Astro)
- `packages/sdk-ts` — TypeScript SDK (`@sandchest/sdk`)
- `packages/mcp` — MCP server (`@sandchest/mcp`)
- `packages/cli` — CLI tool (`@sandchest/cli`)
- `packages/contract` — Shared types + protobuf definitions
- `packages/db` — PlanetScale schema + migrations
- `packages/config` — Shared ESLint/tsconfig base
- `crates/sandchest-node` — Rust node daemon (bare-metal Firecracker management)
- `crates/sandchest-agent` — Rust guest agent (runs inside microVM)

**Data infrastructure:** PlanetScale MySQL (metadata), Redis (ephemeral state/leasing), Scaleway Object Storage (artifacts, event logs).

---

## Package Manager

**Always use `bun`.** Never use npm, yarn, or pnpm.

```sh
bun install          # install dependencies
bun add <pkg>        # add a dependency
bun add -d <pkg>     # add a dev dependency
bun run <script>     # run a package.json script
```

For workspace operations:
```sh
bun install          # installs all workspace packages from root
```

---

## Testing

**Test suite: `bun test`** (built-in Bun test runner — Jest-compatible API).

```sh
bun test                          # run all tests
bun test packages/contract        # run tests in a specific package
bun test --watch                  # watch mode
bun test path/to/file.test.ts     # run a specific file
```

### Testing principles

- **Test behavior, not implementation.** Tests should survive refactors without changing.
- **Unit test pure functions and utilities aggressively** — especially ID generation, encoding, type transforms.
- **Integration tests for HTTP handlers** — test the full request/response cycle with mocked DB/Redis.
- **Co-locate tests with source** — `src/foo.ts` + `src/foo.test.ts` in the same directory.
- **No test utility files that are themselves untested.** Test helpers must be simple enough to trust.
- One `describe` per module, one `test` per behavior. Use `it` for user-facing behavior descriptions.
- Use `expect.assertions(n)` in async tests that assert inside callbacks to prevent silent passes.

```ts
// Good — tests behavior
test('generateId produces sortable IDs for the same prefix', () => {
  const a = generateId('sb_')
  const b = generateId('sb_')
  expect(a < b).toBe(true)
})

// Bad — tests implementation
test('generateId calls crypto.randomBytes', () => { ... })
```

---

## TypeScript Conventions

### Strictness

All packages use strict TypeScript (`"strict": true`). No exceptions. No `any` without a comment explaining why.

```jsonc
// tsconfig base
{
  "strict": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "exactOptionalPropertyTypes": true
}
```

### Imports

- **ESM-first** — use `.js` extensions in imports even for `.ts` source files (NodeNext resolution).
- Prefer `import type` for type-only imports.
- No barrel re-exports that create circular dependencies.

```ts
import type { SandboxStatus } from '@sandchest/contract'
import { generateId } from './id.js'
```

### Error handling

Errors are **structured and typed**. Never throw raw strings. Every public-facing error has a `code`, `message`, and `requestId`.

```ts
// In SDK/API boundary code
throw new SandboxNotRunningError({
  message: `Sandbox ${sandboxId} is not in running state (current: ${status})`,
  requestId,
})
```

EffectTS is used in `apps/api` — use `Effect.fail` with typed error types, not `throw`. Let the runtime handle unhandled failures at the edge.

### Naming

- Types and interfaces: `PascalCase`
- Functions and variables: `camelCase`
- Constants and env vars: `SCREAMING_SNAKE_CASE`
- Files: `kebab-case.ts`
- Prefixed IDs in API responses: `sb_`, `ex_`, `sess_`, `art_` — never raw UUIDs

---

## React / Frontend Code

The `apps/web` replay page uses Astro (with React islands where interactive). Follow these rules strictly when writing any React component.

### You Might Not Need an Effect

Before reaching for `useEffect`, ask: **why does this code need to run?**

| Reason | Solution |
|--------|----------|
| Derived from props/state | Calculate during render (no hook needed) |
| Expensive calculation | `useMemo` |
| User interaction happened | Event handler |
| External system sync | `useEffect` ✓ |

**Never use Effects for these patterns:**

```tsx
// ❌ Effect to derive state
useEffect(() => {
  setFullName(first + ' ' + last)
}, [first, last])

// ✅ Calculate during render
const fullName = first + ' ' + last

// ❌ Effect to reset state on prop change
useEffect(() => {
  setSelection(null)
}, [userId])

// ✅ Key the component to reset it entirely
<Profile userId={userId} key={userId} />

// ❌ Chained effects
useEffect(() => { if (card.gold) setGoldCount(c => c + 1) }, [card])
useEffect(() => { if (goldCount > 3) setRound(r => r + 1) }, [goldCount])

// ✅ All state in one event handler
function handlePlaceCard(card: Card) {
  setCard(card)
  if (card.gold) {
    setGoldCount(c => (c < 3 ? c + 1 : 0))
    if (goldCount >= 3) setRound(r => r + 1)
  }
}

// ❌ Effect to notify parent
useEffect(() => { onChange(isOn) }, [isOn, onChange])

// ✅ Event handler updates both
function handleClick() {
  const next = !isOn
  setIsOn(next)
  onChange(next)
}
```

Effects are **only** for syncing with external systems (WebSocket subscriptions, browser APIs, non-React widgets, data fetching with cleanup).

### Component design

- Components do one thing. Extract when a component has more than one concern.
- Derive as much as possible from props — minimize `useState`.
- If you need `useRef` to track something between renders that isn't displayed, ask whether it belongs in state or derived instead.
- Prefer controlled components at system boundaries.

### Applied Vercel React principles

Use the `vercel-react-best-practices` skill when writing or reviewing React/Next.js code for performance patterns. Key rules:
- Avoid unnecessary client components — `'use client'` boundary should be as deep as possible.
- Use `Suspense` boundaries for async data, not loading state booleans.
- Server Components fetch data; Client Components handle interaction.
- Lists of items with stable identity use `key` on the outermost element.

Use the `vercel-composition-patterns` skill when designing reusable components that accept variable content or behavior.

---

## Code Quality Rules

### Keep it simple

- **No premature abstraction.** Three similar blocks of code is fine. A helper for a one-time operation is not.
- **No over-engineering.** Add configurability only when there are two real callers with different needs.
- **No defensive code for impossible states.** Trust TypeScript. Don't guard against types you've already narrowed.
- **No feature flags** unless the feature is actively being rolled out to production users.

### Side effects

- Pure functions are easy to test — prefer them everywhere state doesn't need to flow.
- Side effects (DB writes, network calls, file I/O) go at the edges: HTTP handlers, scheduled tasks, CLI commands.
- Validate at system boundaries (user input, external API responses). Don't re-validate internally.

### Security

- Never log API keys, secrets, or raw env vars.
- Memory snapshots in Firecracker contain guest memory — never store snapshot refs in logs.
- All API responses that include secrets should be explicitly listed and audited.
- SQL: use parameterized queries always. Never interpolate user input into queries.
- Rate limiting is Redis-backed token bucket per org — respect it in all new endpoints.

---

## Database (PlanetScale / Vitess + Drizzle ORM)

### PlanetScale constraints

- **No foreign keys** — application-level referential integrity only.
- **No stored routines, triggers, or events** — Vitess constraint.
- All IDs stored as `BINARY(16)` (UUIDv7). API-facing IDs use prefixed base62 encoding.
- All `org_id` columns are `VARCHAR(36)` (BetterAuth string IDs).
- Design tables for future sharding by `org_id`.

### Drizzle ORM

Schema source of truth is `packages/db/src/schema/*.ts`. Migrations are generated by `drizzle-kit generate` — never hand-written. BetterAuth tables stay as raw SQL (BetterAuth owns its schema).

**CLI commands:**

```sh
bun run db:generate    # Generate migration from schema changes
bun run db:push        # Push schema directly to dev database (no migration file)
bun run db:migrate     # Apply pending migrations
bun run db:studio      # Open Drizzle Studio (visual DB browser)
```

Run these from `packages/db/`.

**Query patterns:**

```ts
import { db } from './db.js'
import { sandboxes, execs } from '@sandchest/db/schema'
import { eq, and } from 'drizzle-orm'

// Select with filter
const sandbox = await db.select().from(sandboxes).where(eq(sandboxes.id, id))

// Relational query (uses Drizzle relations)
const result = await db.query.sandboxes.findFirst({
  where: eq(sandboxes.id, id),
  with: { execs: true },
})

// Insert
await db.insert(sandboxes).values({ id, orgId, imageId, profileId, status: 'queued' })

// Update
await db.update(sandboxes).set({ status: 'running' }).where(eq(sandboxes.id, id))

// Raw SQL fallback (when Drizzle query builder isn't enough)
import { sql } from 'drizzle-orm'
await db.execute(sql`SELECT MAX(seq) + 1 FROM execs WHERE sandbox_id = ${sandboxId} FOR UPDATE`)
```

**Rules:**

- Never edit a committed migration — generate a new one instead.
- Use the custom column helpers from `packages/db/src/columns.ts`: `uuidv7Binary()`, `timestampMicro()`, `createdAt()`, `updatedAt()`.
- Prefer the Drizzle query builder over raw SQL. Use `sql` template tag for raw SQL only when necessary.
- BetterAuth tables are raw SQL only — do not add them to Drizzle schema.
- Use Drizzle `relations()` for logical relationships — no FK constraints generated.

Use the `vitess` skill when writing or reviewing PlanetScale queries, schema changes, or indexing decisions.

---

## Rust Crates

- `crates/sandchest-node` — Firecracker VM lifecycle, snapshot management, vsock communication
- `crates/sandchest-agent` — Runs inside microVM; gRPC over vsock; must be tiny and fast

Rust edition: 2021. `cargo clippy -- -D warnings` must pass. `cargo test` must pass.

---

## Commit Conventions

Conventional commits. No `Co-Authored-By` lines.

```
feat: add fork tree visualization to replay page
fix: handle vsock disconnect during exec streaming
chore: update turborepo pipeline for contract codegen
test: add UUIDv7 sortability tests
refactor: extract exec event parsing to pure function
ci: add Rust clippy check to PR workflow
docs: update API contract for session endpoints
perf: use overlayfs instead of device-mapper for CoW clones
```

One commit per task. Stage specific files — never `git add -A` blindly.

---

## Skills to Use

| Situation | Skill |
|-----------|-------|
| Writing/reviewing React or Next.js code | `vercel-react-best-practices` |
| Designing reusable component APIs | `vercel-composition-patterns` |
| React Native / Expo (if mobile surfaces added) | `vercel-react-native-skills` |
| PlanetScale schema, indexing, query tuning | `vitess` |
| MySQL schema design or migrations | `mysql` |
| Reviewing code quality / pending changes | `deslop` |
| Checking UI against design best practices | `web-design-guidelines` |

---

## Environment Variables

```sh
DATABASE_URL=          # PlanetScale connection string
REDIS_URL=             # Redis connection string
SANDCHEST_API_KEY=     # Used by SDK (defaults to this env var)
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

Never commit `.env` files. Never hardcode credentials.
