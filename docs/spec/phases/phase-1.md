# Phase 1 — Foundation

> Everything needed before we can build features. Contracts, scaffolding, CI, database, SDK skeleton.

<!--
SELF-HEALING INSTRUCTIONS
=========================
When you receive "continue docs/spec/phases/phase-1.md":

1. Read this file top to bottom
2. Find the FIRST task with `[ ]` (unchecked)
3. Read the task's full context, spec references, and acceptance criteria
4. Read the referenced spec files for additional detail
5. Execute the task — create/modify files as specified
6. When the task is complete:
   a. Run any acceptance criteria checks (build, typecheck, tests)
   b. Mark the checkbox `[x]`
   c. Fill in the "Learnings" section with anything discovered during execution
   d. Stage the relevant files with `git add` (specific files, not -A)
   e. Commit: `git commit -m "{type}: {description}"`
      - Use conventional commit types: feat|fix|chore|test|refactor|ci|docs|perf
      - Author will be git config default (Richie McIlroy)
      - NO Co-Authored-By lines
   f. Save/update this phase file with the checked box + learnings
7. Move to the next `[ ]` task and repeat
8. If ALL tasks are `[x]`, report: "Phase 1 complete. Ready for Phase 2."

IMPORTANT:
- Read the spec files referenced in each task before starting work
- If a task is blocked, note the blocker in Learnings and move to the next unblocked task
- Each task should result in ONE commit (unless the task specifies otherwise)
- Do not modify files outside the task's scope
-->

---

## Task 1: Initialize monorepo structure

- [x] **Status**: Done
- **Commit type**: `chore`
- **Commit message**: `chore: initialize monorepo with turborepo and cargo workspace`

### What to build

Set up the Sandchest monorepo with Turborepo for TypeScript packages and a Cargo workspace for Rust crates. Create the full directory skeleton from the spec.

### Context

The repo layout is defined in `docs/spec/09-infrastructure.md` → "Repo layout" section. The project is a polyglot monorepo: TypeScript (control plane, SDK, CLI, MCP, web) + Rust (node daemon, guest agent). Turborepo handles TS build orchestration. Cargo workspace handles Rust builds.

### Directory structure to create

```
sandchest/
  apps/
    api/                  # Control plane HTTP API (EffectTS) — package.json, tsconfig.json
    web/                  # Replay page (Astro) — package.json, tsconfig.json
  packages/
    sdk-ts/               # TypeScript SDK — package.json, tsconfig.json
    mcp/                  # MCP server — package.json, tsconfig.json
    cli/                  # CLI — package.json, tsconfig.json
    contract/             # OpenAPI spec + protobuf — package.json, tsconfig.json
    db/                   # PlanetScale schema + migrations — package.json
    config/               # Shared ESLint, tsconfig base
  crates/
    sandchest-node/       # Rust node daemon — Cargo.toml, src/main.rs
    sandchest-agent/      # Rust guest agent — Cargo.toml, src/main.rs
  images/
    ubuntu-22.04-base/    # Image build scripts (placeholder README)
```

### Files to create/modify

- `package.json` — Root workspace config (npm workspaces pointing to apps/* and packages/*)
- `turbo.json` — Turborepo pipeline config (build, typecheck, lint, test tasks)
- `Cargo.toml` — Root Cargo workspace with members: crates/*
- `crates/sandchest-node/Cargo.toml` — Node daemon crate with placeholder deps (tokio, tonic, serde)
- `crates/sandchest-node/src/main.rs` — Placeholder main
- `crates/sandchest-agent/Cargo.toml` — Guest agent crate with placeholder deps (tokio, tonic, serde)
- `crates/sandchest-agent/src/main.rs` — Placeholder main
- `apps/api/package.json` — Name: `@sandchest/api`, private: true
- `apps/web/package.json` — Name: `@sandchest/web`, private: true
- `packages/sdk-ts/package.json` — Name: `@sandchest/sdk`
- `packages/mcp/package.json` — Name: `@sandchest/mcp`
- `packages/cli/package.json` — Name: `@sandchest/cli`, bin: { sandchest: "./dist/index.js" }
- `packages/contract/package.json` — Name: `@sandchest/contract`
- `packages/db/package.json` — Name: `@sandchest/db`
- `packages/config/package.json` — Name: `@sandchest/config`
- Placeholder `src/index.ts` files in each TS package
- Update `.gitignore` to cover node_modules, dist, target, .turbo, *.tsbuildinfo

### Tech decisions

- Use **npm workspaces** (not yarn/pnpm) — simplest, no extra tooling
- TypeScript packages target **ESM-first** with CJS compatibility
- Rust edition: **2021**
- Node.js target: **20+**

### Acceptance criteria

- `npm install` completes without errors from repo root
- `npx turbo build` runs (even if builds are no-ops with placeholder files)
- `cargo check` passes for both Rust crates
- Directory structure matches the spec layout

### Learnings
- Used `bun` as package manager per project conventions (spec said npm but CLAUDE.md overrides)
- Turbo 2.8.10 warns about missing output files for packages with no-op builds — harmless
- tonic 0.12 is used (0.14 available) to match placeholder Cargo.toml versions — will update when building real gRPC code
- All TS packages use ESM (`"type": "module"`) with NodeNext module resolution

---

## Task 2: Set up shared TypeScript configuration

- [x] **Status**: Done
- **Commit type**: `chore`
- **Commit message**: `chore: add shared tsconfig, eslint, and prettier configuration`

### What to build

Create the shared TypeScript configuration that all packages inherit from. This includes base tsconfig, ESLint config, and Prettier config.

### Context

All TypeScript packages need consistent compiler settings. The SDK targets Node.js 20+ and modern browsers (for replay page integration). ESM-first with CJS compatibility. Strict TypeScript.

### Files to create/modify

- `packages/config/tsconfig.base.json` — Shared base tsconfig:
  - `target`: `ES2022` (Node 20+ supports this)
  - `module`: `NodeNext`
  - `moduleResolution`: `NodeNext`
  - `strict`: true
  - `esModuleInterop`: true
  - `skipLibCheck`: true
  - `declaration`: true
  - `declarationMap`: true
  - `sourceMap`: true
  - `outDir`: `./dist`
  - `rootDir`: `./src`

- `packages/config/eslint.config.mjs` — Flat ESLint config:
  - TypeScript ESLint with recommended rules
  - No-unused-vars as error (but allow underscore prefix)
  - Consistent type imports

- `.prettierrc` — Root Prettier config:
  - `semi`: false
  - `singleQuote`: true
  - `trailingComma`: `all`
  - `printWidth`: 100
  - `tabWidth`: 2

- `.prettierignore` — Ignore dist, node_modules, target, .turbo

- Update each package's `tsconfig.json` to extend the base:
  - `apps/api/tsconfig.json`
  - `apps/web/tsconfig.json`
  - `packages/sdk-ts/tsconfig.json`
  - `packages/mcp/tsconfig.json`
  - `packages/cli/tsconfig.json`
  - `packages/contract/tsconfig.json`

### Acceptance criteria

- `npx tsc --noEmit` passes in each TypeScript package
- ESLint config loads without errors
- Prettier formats a sample file correctly

### Learnings
- Base tsconfig lives in `packages/config/tsconfig.base.json`; all packages extend it with only `outDir`/`rootDir` overrides
- Root `eslint.config.mjs` re-exports from `packages/config/eslint.config.mjs` — ESLint flat config resolves from the root automatically
- ESLint 10 + typescript-eslint 8.56 work with flat config out of the box
- Prettier config at root is picked up by all packages without per-package config
- `exactOptionalPropertyTypes` is enabled in the shared base — this is stricter than default strict mode

---

## Task 3: Create contract package — REST API types

- [x] **Status**: Done
- **Commit type**: `feat`
- **Commit message**: `feat: add REST API contract types for all endpoints`

### What to build

Create TypeScript type definitions for the entire REST API surface. These types are the single source of truth shared between the control plane API (server) and the SDK (client).

### Context

The full API contract is defined in `docs/spec/02-api-contract.md`. Every endpoint, request body, response body, query parameter, and error type needs a corresponding TypeScript type. The contract package is imported by both `@sandchest/api` and `@sandchest/sdk`.

### Types to define

Reference `docs/spec/02-api-contract.md` for the full specification. Key types:

**Enums / Literals:**
- `SandboxStatus`: `'queued' | 'provisioning' | 'running' | 'stopping' | 'stopped' | 'failed' | 'deleted'`
- `ExecStatus`: `'queued' | 'running' | 'done' | 'failed' | 'timed_out'`
- `SessionStatus`: `'running' | 'destroyed'`
- `ProfileName`: `'small' | 'medium' | 'large'`
- `FailureReason`: `'capacity_timeout' | 'node_lost' | 'provision_failed' | 'sandbox_stopped' | 'sandbox_deleted' | 'ttl_exceeded'`

**Request/Response types for each endpoint:**
- `CreateSandboxRequest` / `CreateSandboxResponse`
- `GetSandboxResponse`
- `ListSandboxesParams` / `ListSandboxesResponse`
- `ForkSandboxRequest` / `ForkSandboxResponse`
- `GetForkTreeResponse` / `ForkTreeNode`
- `ExecRequest` / `ExecSyncResponse` / `ExecAsyncResponse`
- `GetExecResponse`
- `ListExecsParams` / `ListExecsResponse`
- `ExecStreamEvent` (stdout | stderr | exit variants)
- `CreateSessionRequest` / `CreateSessionResponse`
- `SessionExecRequest` / `SessionExecResponse`
- `SessionInputRequest`
- `ListSessionsResponse`
- `RegisterArtifactsRequest` / `RegisterArtifactsResponse`
- `ListArtifactsResponse` / `Artifact`
- `ReplayBundle` (reference `docs/spec/04-session-replay.md` for full schema)
- `StopSandboxResponse`
- `ApiError` — `{ error: string, message: string, request_id: string, retry_after: number | null }`

**Common types:**
- `PaginationParams`: `{ cursor?: string, limit?: number }`
- `PaginatedResponse<T>`: `{ items: T[], next_cursor: string | null }`
- `ResourceUsage`: `{ cpu_ms: number, peak_memory_bytes: number }`

### Files to create

- `packages/contract/src/index.ts` — Re-exports all types
- `packages/contract/src/api.ts` — All REST API request/response types
- `packages/contract/src/sandbox.ts` — Sandbox, Exec, Session, Artifact resource types
- `packages/contract/src/replay.ts` — Replay bundle types (from spec 04)
- `packages/contract/src/errors.ts` — Error codes and error response types
- `packages/contract/src/common.ts` — Shared types (pagination, resource usage, etc.)

### Acceptance criteria

- All types from `docs/spec/02-api-contract.md` are represented
- Replay bundle types match `docs/spec/04-session-replay.md`
- Package builds cleanly: `npx tsc --noEmit` in `packages/contract/`
- Types are exported from the package entry point

### Learnings
- All types use `export type` re-exports from index.ts since they're type-only (no runtime values)
- Used `| undefined` on optional properties for `exactOptionalPropertyTypes` compatibility (required by base tsconfig)
- Replay bundle has a recursive `ReplayForkTreeNode` type (children are same type), while API `ForkTreeNode` uses flat `children: string[]` (just IDs)
- Added `FileEntry` and `ListFilesResponse` types for the file listing endpoint — not in the task list but present in the API spec
- `ExecOutputEntry` type added for per-exec JSONL log format from spec 04

---

## Task 4: Create Protobuf definitions for internal RPCs

- [x] **Status**: Done
- **Commit type**: `feat`
- **Commit message**: `feat: add protobuf definitions for node and guest agent RPCs`

### What to build

Create Protocol Buffer definitions for the two internal RPC interfaces:
1. **Control Plane ↔ Node** — Messages for sandbox lifecycle, exec routing, heartbeats
2. **Node ↔ Guest Agent** — The gRPC service running inside the microVM

### Context

The Node ↔ Guest Agent protobuf is fully defined in `docs/spec/03-firecracker-runtime.md` → "gRPC service definition" section. The Control Plane ↔ Node messages are defined in `docs/spec/01-architecture.md` → "Internal RPC" section.

These protobufs will be compiled to:
- **Rust** (tonic) — for node daemon + guest agent
- **TypeScript** (ts-proto or buf) — for control plane

### Files to create

- `packages/contract/proto/sandchest/agent/v1/agent.proto` — Guest agent service:
  ```
  GuestAgent service with: Health, Exec, CreateSession, SessionExec,
  SessionInput, DestroySession, PutFile, GetFile, ListFiles, Shutdown
  ```
  Copy the exact service definition from `docs/spec/03-firecracker-runtime.md`.

- `packages/contract/proto/sandchest/node/v1/node.proto` — Two gRPC services:

  **`service Node`** — hosted on the node daemon. The control plane connects to each node's gRPC port to issue commands:
  ```protobuf
  service Node {
    rpc CreateSandbox(CreateSandboxRequest) returns (CreateSandboxResponse);
    rpc CreateSandboxFromSnapshot(CreateSandboxFromSnapshotRequest) returns (CreateSandboxResponse);
    rpc ForkSandbox(ForkSandboxRequest) returns (ForkSandboxResponse);
    rpc Exec(NodeExecRequest) returns (stream ExecEvent);
    rpc CreateSession(NodeCreateSessionRequest) returns (NodeCreateSessionResponse);
    rpc SessionExec(NodeSessionExecRequest) returns (stream ExecEvent);
    rpc SessionInput(NodeSessionInputRequest) returns (Empty);
    rpc DestroySession(NodeDestroySessionRequest) returns (Empty);
    rpc PutFile(stream NodeFileChunk) returns (NodePutFileResponse);
    rpc GetFile(NodeGetFileRequest) returns (stream NodeFileChunk);
    rpc ListFiles(NodeListFilesRequest) returns (NodeListFilesResponse);
    rpc CollectArtifacts(CollectArtifactsRequest) returns (CollectArtifactsResponse);
    rpc StopSandbox(StopSandboxRequest) returns (StopSandboxResponse);
    rpc DestroySandbox(DestroySandboxRequest) returns (Empty);
  }
  ```
  All Node service requests include a `sandbox_id` field for routing to the correct guest agent. Field-level definitions: reference `docs/spec/01-architecture.md` → "Internal RPC".

  **`service Control`** — hosted on the control plane (port 50051). Node daemons connect and open the `StreamEvents` bidirectional stream to send lifecycle events; the control plane responds with acknowledgements (reserved for future use):
  ```protobuf
  service Control {
    rpc StreamEvents(stream NodeToControl) returns (stream ControlToNode);
  }

  // Wraps all Node → Control event types in a single oneof
  message NodeToControl {
    oneof event {
      Heartbeat heartbeat = 1;
      ExecOutput exec_output = 2;
      SessionOutput session_output = 3;
      ExecCompleted exec_completed = 4;
      SandboxEvent sandbox_event = 5;
      ArtifactReport artifact_report = 6;
    }
  }

  // Acknowledgement / reserved for future control-plane-to-node commands
  message ControlToNode {
    string noop = 1;
  }
  ```

- `packages/contract/proto/buf.yaml` — Buf configuration for linting/generation
- `packages/contract/proto/buf.gen.yaml` — Code generation targets:
  - `ts-proto` → outputs to `packages/contract/src/generated/` (TypeScript stubs used by the control plane gRPC client/server)
  - `tonic` → outputs to Rust crates via `build.rs` (handled at Rust build time, not by buf)

- **Run code generation and commit the output:**
  ```bash
  cd packages/contract
  npx buf generate proto/
  ```
  This produces TypeScript stubs in `packages/contract/src/generated/`. Commit the generated files — they are checked in, not gitignored, so CI doesn't need buf installed to build.

- `packages/contract/package.json` — Add codegen script:
  - `"codegen": "buf generate proto/"` (for regenerating after proto changes)

- `packages/contract/src/index.ts` — Re-export generated types alongside hand-written types:
  ```typescript
  export * from './generated/sandchest/node/v1/node.js'
  export * from './generated/sandchest/agent/v1/agent.js'
  ```

- Update `turbo.json` — The `build` task for `packages/contract` should run `codegen` first (or generated files are checked in and no pipeline change is needed)

### Key details from spec

- **Environment injection**: Uses the existing `env` field on `ExecRequest` and `CreateSessionRequest`. The node daemon stores sandbox-level env vars and merges them into every request. No separate `InjectEnv` RPC is needed.
- Guest agent listens on vsock CID=3, port=52
- ExecEvent has oneof: stdout (bytes), stderr (bytes), exit (ExitEvent)
- ExitEvent includes: exit_code, cpu_ms, peak_memory_bytes, duration_ms
- Heartbeat includes: active sandbox IDs, slot utilization, snapshot inventory
- SandboxEvent types: created, ready, stopped, failed, forked
- Session exec uses sentinel pattern for output demarcation

### Acceptance criteria

- Proto files are valid: `buf lint` passes
- `agent.proto` defines `service GuestAgent` with all 10 RPCs from spec 03
- `node.proto` defines `service Node` with all 14 Control→Node RPCs
- `node.proto` defines `service Control` with `rpc StreamEvents` (bidirectional stream)
- `node.proto` defines `NodeToControl` (oneof of all 6 Node→Control event types) and `ControlToNode`
- All message field types and numbers are consistent
- Proto files have proper package declarations and imports
- `buf generate proto/` runs without errors and produces TypeScript files in `packages/contract/src/generated/`
- Generated TypeScript includes gRPC client/server stubs for both `Node` and `Control` services (not just message types)
- Generated TypeScript files are committed to the repo (not gitignored)
- `packages/contract/src/index.ts` re-exports generated types
- `npx tsc --noEmit` passes in `packages/contract/` (generated stubs typecheck)

### Learnings
- ts-proto v2.11 generates code using `@bufbuild/protobuf/wire` (not protobufjs/minimal) — need `@bufbuild/protobuf` as a runtime dependency
- Generated code uses `Buffer` (Node.js) for `bytes` fields — requires `@types/node` for typecheck
- buf STANDARD lint rules conflict with the spec's naming (no `Service` suffix, reused `Empty` type) — disabled `SERVICE_SUFFIX`, `RPC_REQUEST_STANDARD_NAME`, `RPC_RESPONSE_STANDARD_NAME`, `RPC_REQUEST_RESPONSE_UNIQUE`
- Generated types have naming conflicts with hand-written REST API types (e.g., both have `ExecRequest`) — used namespace re-exports: `export * as agentRpc` / `export * as nodeRpc`
- `outputServices=generic-definitions` generates framework-agnostic service definitions (no @grpc/grpc-js dependency) with full method metadata (request/response types, streaming flags)
- ExecEvent/ExitEvent defined separately in both agent.proto and node.proto to keep proto packages independent

---

## Task 5: Create database package — Drizzle schema and migrations

- [x] **Status**: Done
- **Commit type**: `feat`
- **Commit message**: `feat: add database package with Drizzle schema, migrations, and seeds`

### What to build

Create the `packages/db` package using Drizzle ORM for type-safe schema-as-code. Define all Sandchest-specific tables as Drizzle schema files, generate the initial migration with `drizzle-kit generate`, and create an idempotent seed function.

### Context

The complete data model is in `docs/spec/08-data-model.md`. PlanetScale (Vitess) constraints:
- No stored routines, triggers, or events
- No foreign keys (application-level referential integrity) — use Drizzle `relations()` for logical relationships only
- Design for future sharding by `org_id`
- All IDs are UUIDv7 stored as `BINARY(16)`
- All mutable tables include `updated_at TIMESTAMP(6)`

**Note:** BetterAuth tables are NOT defined in Drizzle schema — BetterAuth owns its schema. The BetterAuth migration (`001_betterauth_schema.sql`) is created in Task 9.

### Files to create

- `packages/db/package.json` — Dependencies:
  - `drizzle-orm` (ORM)
  - `mysql2` (MySQL driver)
  - `drizzle-kit` (devDependency — migration generation CLI)
  - Scripts:
    - `"db:generate": "drizzle-kit generate"`
    - `"db:push": "drizzle-kit push"`
    - `"db:migrate": "drizzle-kit migrate"`
    - `"db:studio": "drizzle-kit studio"`

- `packages/db/drizzle.config.ts` — Drizzle Kit configuration:
  - `schema: './src/schema/index.ts'`
  - `out: './drizzle'`
  - `dialect: 'mysql'`
  - `dbCredentials: { url: process.env.DATABASE_URL! }`

- `packages/db/src/columns.ts` — Custom column helpers:
  ```typescript
  import { binary, timestamp } from 'drizzle-orm/mysql-core'

  /** UUIDv7 stored as BINARY(16) */
  export const uuidv7Binary = (name: string) => binary(name, { length: 16 }).$type<Uint8Array>()

  /** TIMESTAMP(6) — microsecond precision */
  export const timestampMicro = (name: string) => timestamp(name, { fsp: 6, mode: 'date' })

  /** created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) */
  export const createdAt = () => timestampMicro('created_at').notNull().defaultNow()

  /** updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) */
  export const updatedAt = () => timestampMicro('updated_at').notNull().defaultNow().onUpdateNow()
  ```

- **Schema files** in `packages/db/src/schema/` — one file per table, using column helpers:

  - `nodes.ts` — id, name, hostname, slots_total, status (enum), version, firecracker_version, capabilities (json), last_seen_at + indexes
  - `images.ts` — id, os_version, toolchain, kernel_ref, rootfs_ref, snapshot_ref, digest, size_bytes + unique key
  - `profiles.ts` — id, name (unique), cpu_cores, memory_mb, disk_gb, description
  - `sandboxes.ts` — id, org_id (varchar(36)), node_id, image_id, profile_id, profile_name, status (enum), env (json), forked_from, fork_depth, fork_count, ttl_seconds, failure_reason, replay_bundle_ref, created_at, updated_at, started_at, ended_at + all indexes from spec
  - `sandbox-sessions.ts` — id, sandbox_id, shell, status (enum), env (json), created_at, destroyed_at + indexes
  - `execs.ts` — id, sandbox_id, session_id, seq, cmd (text), cmd_format (enum), cwd, env (json), status (enum), exit_code, cpu_ms, peak_memory_bytes, duration_ms, log_ref, created_at, updated_at, started_at, ended_at + indexes
  - `artifacts.ts` — id, sandbox_id, org_id (varchar(36)), exec_id, name, mime, bytes (bigint), sha256 (char(64)), ref, created_at, retention_until + indexes
  - `org-quotas.ts` — id, org_id (varchar(36), unique), all quota fields from spec
  - `idempotency-keys.ts` — idem_key (varchar(64), PK), org_id (varchar(36)), status (enum), response_status, response_body (mediumtext), created_at + indexes

  Reference `docs/spec/08-data-model.md` for exact column definitions and indexes per table. Note: `org_id` columns are `varchar(36)` (BetterAuth uses string IDs).

- `packages/db/src/schema/relations.ts` — Drizzle `relations()` for all logical relationships:
  - sandboxes → node, image, profile, parent sandbox (forked_from)
  - sandbox_sessions → sandbox
  - execs → sandbox, session
  - artifacts → sandbox, exec
  - org_quotas → (org_id is a BetterAuth ID, no Drizzle relation needed)
  - No FK constraints generated (PlanetScale/Vitess requirement) — `relations()` only enables the relational query API

- `packages/db/src/schema/index.ts` — Re-exports all tables and relations

- `packages/db/src/client.ts` — Database client factory:
  ```typescript
  import { drizzle } from 'drizzle-orm/mysql2'
  import mysql from 'mysql2/promise'
  import * as schema from './schema/index.js'

  export function createDatabase(url: string) {
    const pool = mysql.createPool({ uri: url, waitForConnections: true, connectionLimit: 10 })
    return drizzle(pool, { schema, mode: 'default' })
  }
  ```

- `packages/db/src/seed.ts` — Idempotent seed function:
  - Seeds 3 profiles (small: 2cpu/4096MB/40GB, medium: 4cpu/8192MB/80GB, large: 8cpu/16384MB/160GB)
  - Seeds initial image (ubuntu-22.04/base with placeholder refs)
  - Seeds dev node (hostname: `localhost`, slots_total: 10, status: `'offline'`)
  - Uses `onDuplicateKeyUpdate` for idempotency (replaces the old 003/004/005 SQL seed files)

- `packages/db/src/index.ts` — Package entry point: re-exports client, schema, column helpers

- **Run `drizzle-kit generate`** to produce the initial migration in `packages/db/drizzle/`. Commit the generated SQL.

- `packages/db/migrations/` directory remains for BetterAuth-owned SQL only:
  ```
  packages/db/migrations/
    001_betterauth_schema.sql    # Created by Task 9 (BetterAuth CLI)
  ```

### Acceptance criteria

- `packages/db/package.json` has `drizzle-orm`, `mysql2`, and `drizzle-kit` as dependencies
- All 9 Sandchest-specific tables are defined in `packages/db/src/schema/` (no `organizations` or `api_keys`)
- `sandbox_sessions` table (not `sessions`) is used for sandbox shell sessions
- All `org_id` columns are `varchar(36)` (not `binary(16)`)
- Custom column helpers (`uuidv7Binary`, `timestampMicro`, `createdAt`, `updatedAt`) are used consistently
- Drizzle `relations()` are defined for all logical relationships (no FK constraints)
- `drizzle-kit generate` produces a valid initial migration SQL file
- `createDatabase()` factory connects via mysql2 pool and returns a typed Drizzle client
- Seed function is idempotent (safe to run multiple times)
- `npx tsc --noEmit` passes in `packages/db/`
- All indexes from the spec are included (as Drizzle index definitions)

### Learnings
- drizzle-kit's CJS bundler can't resolve ESM `.js` → `.ts` extension remapping — db package uses `"module": "Preserve"` + `"moduleResolution": "Bundler"` in tsconfig to allow extensionless imports
- `tsx` must be installed as a devDependency for drizzle-kit to load TypeScript schema files
- drizzle-kit glob `./src/schema/index.ts` works when using bundler resolution with extensionless imports
- `onDuplicateKeyUpdate` in drizzle-orm expects plain values or `sql` template expressions, not column references — use `sql\`VALUES(column_name)\`` for MySQL upsert no-ops
- All 9 tables generated correctly with 0 FK constraints (PlanetScale/Vitess compatible)
- drizzle `relations()` are defined in a separate file and re-exported — they enable the relational query API without generating FK constraints

---

## Task 6: Build SDK skeleton with core types and client class

- [x] **Status**: Done
- **Commit type**: `feat`
- **Commit message**: `feat: scaffold TypeScript SDK with client classes and full type surface`

### What to build

Create the SDK package structure with all client classes, method signatures, and types. Methods should have full signatures but throw "not implemented" errors — the actual HTTP calls come in Phase 2/4.

### Context

The SDK API surface is fully specified in `docs/spec/06-sdk-cli.md` → "SDK: @sandchest/sdk" section. The SDK imports types from `@sandchest/contract`. Design principles from the spec:
1. `Sandbox` is the primary object — all operations hang off the instance
2. Sensible defaults — `sandchest.create()` with zero args works
3. Streaming is opt-in — `exec()` returns a result by default
4. Sessions are explicit — create when you need state persistence
5. Fork is first-class — `sandbox.fork()` is a method on Sandbox
6. Cleanup is automatic — `using` (Explicit Resource Management)
7. Errors are structured — every error has code, message, requestId

### Files to create

- `packages/sdk-ts/src/index.ts` — Re-exports: Sandchest, Sandbox, Session, ExecResult, errors
- `packages/sdk-ts/src/client.ts` — `Sandchest` class:
  ```typescript
  constructor(options: { apiKey?: string, baseUrl?: string, timeout?: number, retries?: number })
  create(options?: CreateSandboxOptions): Promise<Sandbox>
  get(sandboxId: string): Promise<Sandbox>
  list(options?: ListSandboxesOptions): Promise<Sandbox[]>
  ```
  - `apiKey` defaults to `process.env.SANDCHEST_API_KEY`
  - `baseUrl` defaults to `https://api.sandchest.com`

- `packages/sdk-ts/src/sandbox.ts` — `Sandbox` class:
  ```typescript
  id: string
  status: SandboxStatus
  replayUrl: string
  exec(cmd: string | string[], options?: ExecOptions): Promise<ExecResult>
  exec(cmd: string | string[], options: StreamExecOptions): AsyncIterable<ExecStreamEvent>
  fork(options?: ForkOptions): Promise<Sandbox>
  forks(): Promise<ForkTree>
  stop(): Promise<void>
  destroy(): Promise<void>
  waitReady(options?: { timeout?: number }): Promise<void>
  fs: FileOperations  // upload, uploadDir, download, ls, rm
  artifacts: ArtifactOperations  // register, list
  session: SessionManager  // create
  [Symbol.asyncDispose](): Promise<void>  // calls stop()
  ```

- `packages/sdk-ts/src/session.ts` — `Session` class:
  ```typescript
  id: string
  exec(cmd: string, options?: SessionExecOptions): Promise<ExecResult>
  destroy(): Promise<void>
  ```

- `packages/sdk-ts/src/errors.ts` — Error classes:
  - `SandchestError` (base) — code, message, requestId, status
  - `NotFoundError`
  - `RateLimitError` — adds retryAfter
  - `SandboxNotRunningError`
  - `ValidationError`
  - `AuthenticationError`

- `packages/sdk-ts/src/types.ts` — SDK-specific option types:
  - `CreateSandboxOptions`, `ExecOptions`, `StreamExecOptions`, `ForkOptions`
  - `SessionExecOptions`, `ListSandboxesOptions`
  - `ExecResult` — exitCode, stdout, stderr, durationMs, execId

- `packages/sdk-ts/src/http.ts` — HTTP client skeleton (internal):
  - `request(method, path, body?, options?)` — placeholder for fetch-based client
  - Retry logic structure (exponential backoff, jitter)
  - Idempotency key generation
  - Error response parsing

### Acceptance criteria

- `npx tsc --noEmit` passes in `packages/sdk-ts/`
- All method signatures from `docs/spec/06-sdk-cli.md` are present
- `Sandchest`, `Sandbox`, `Session`, `ExecResult` are exported
- Error classes hierarchy is correct
- SDK imports types from `@sandchest/contract`

### Learnings
- SDK defines its own `SdkErrorCode` type instead of importing `ErrorCode` from contract — contract uses `export type` re-exports which work fine, but keeping the SDK self-contained avoids coupling to contract's internal type naming
- Used `Uint8Array` instead of `Buffer` for file operations — SDK targets both Node.js and browsers, and `Uint8Array` is universal
- `Symbol.asyncDispose` requires `"lib": ["ES2022", "ESNext.Disposable"]` in tsconfig — the base config only has `ES2022`
- `exactOptionalPropertyTypes` interacts with fetch's `RequestInit.body` — must conditionally assign instead of passing `undefined` for body
- Contract package must be built first (`tsc`) to produce `dist/` type declarations before dependents can typecheck — turbo pipeline handles this via `dependsOn: ["^build"]`
- All skeleton methods throw `'Not implemented'` but have full signatures matching the spec — this lets dependents typecheck against the API surface immediately
- Internal fields (`_http`, `_sandboxId`) use `_` prefix + `@internal` JSDoc to satisfy `noUnusedLocals` while signaling they're reserved for implementation

---

## Task 7: Implement UUIDv7 ID generation with prefixed base62 encoding

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: implement UUIDv7 ID generation with prefixed base62 encoding`

### What to build

Create a shared ID generation utility that produces UUIDv7 IDs with prefixed base62 encoding for API representation. This is used by both TypeScript (control plane, SDK) and Rust (node, agent).

### Context

ID format is defined in `docs/spec/08-data-model.md` → "ID format" section:
- **Storage**: UUIDv7 as `BINARY(16)` — sortable by creation time, compact index
- **API representation**: `{prefix}_{base62(uuid_bytes)}`
- Base62 encoding of 16 bytes produces a 22-character string
- Full IDs look like: `sb_7Kj2mNpQ4xRvW2yBcD3z`

**Prefix table:**
| Resource | Prefix |
|----------|--------|
| Sandbox | `sb_` |
| Exec | `ex_` |
| Sandbox Session | `sess_` |
| Artifact | `art_` |
| Image | `img_` |
| Profile | `prof_` |
| Node | `node_` |
| Project | `proj_` |

Note: Organization and API key IDs are managed by BetterAuth (string IDs) — not part of our UUIDv7/base62 system.

### Files to create/modify

- `packages/contract/package.json` — Add test tooling:
  - Add `vitest` to `devDependencies`
  - Add `"test": "vitest run"` to scripts

**TypeScript (shared utility):**
- `packages/contract/src/id.ts`:
  - `generateId(prefix: string): string` — Generate UUIDv7, encode to base62, prepend prefix
  - `parseId(id: string): { prefix: string, bytes: Uint8Array }` — Parse prefixed ID back to bytes
  - `idToBytes(id: string): Uint8Array` — Strip prefix, decode base62 to 16 bytes (for DB storage)
  - `bytesToId(prefix: string, bytes: Uint8Array): string` — Encode bytes to prefixed ID
  - `generateUUIDv7(): Uint8Array` — Pure UUIDv7 generation (48-bit timestamp + 74-bit random, version=7, variant=RFC4122)
  - `base62Encode(bytes: Uint8Array): string` / `base62Decode(str: string): Uint8Array`
  - Helper constants: `SANDBOX_PREFIX = 'sb_'`, `EXEC_PREFIX = 'ex_'`, etc.

- `packages/contract/src/id.test.ts`:
  - UUIDv7 bytes are 16 bytes, version nibble is 7, variant bits are correct
  - Base62 round-trip: encode then decode returns original bytes
  - Generated IDs are sortable by creation time
  - Prefix parsing works for all resource types
  - Two IDs generated in sequence are ordered correctly

**Rust (shared utility):**
- `crates/sandchest-node/src/id.rs` (or a shared crate if preferred):
  - Same functions as TypeScript version
  - Use `uuid` crate for UUIDv7 generation
  - Custom base62 encoding (alphabet: `0-9A-Za-z`)

### Key implementation details

- **UUIDv7 structure**: First 48 bits = Unix timestamp in milliseconds. Next 4 bits = version (0111). Next 12 bits = random. Next 2 bits = variant (10). Remaining 62 bits = random.
- **Base62 alphabet**: `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`
- **Zero dependencies** for the TypeScript implementation (use crypto.randomBytes or Web Crypto API)

### Acceptance criteria

- TypeScript: tests pass, IDs are valid UUIDv7, base62 round-trips correctly
- Rust: `cargo test` passes for ID generation
- IDs generated 1ms apart are lexicographically ordered
- Prefix table matches the spec exactly

### Learnings
<!-- Filled in after completion -->

---

## Task 8: Set up CI pipeline with GitHub Actions



- [ ] **Status**: Pending
- **Commit type**: `ci`
- **Commit message**: `ci: add GitHub Actions workflow for PR checks`

### What to build

Create a GitHub Actions CI pipeline that runs on every PR. It should lint, typecheck, and test all TypeScript packages, plus check the Rust crates.

### Context

From `docs/spec/09-infrastructure.md` → "Build tooling" and `docs/spec/11-milestones.md` → Milestone 0:
- CI: GitHub Actions (lint + typecheck + unit tests on PR, E2E nightly)
- Turborepo for TypeScript orchestration
- Cargo for Rust builds

### Files to create

- `.github/workflows/ci.yml`:
  ```yaml
  name: CI
  on:
    pull_request:
    push:
      branches: [main]

  jobs:
    typecheck-and-lint:
      runs-on: ubuntu-latest
      steps:
        - Checkout
        - Setup Node.js 20
        - npm ci
        - npx turbo typecheck
        - npx turbo lint

    test-ts:
      runs-on: ubuntu-latest
      steps:
        - Checkout
        - Setup Node.js 20
        - npm ci
        - npx turbo test

    check-rust:
      runs-on: ubuntu-latest
      steps:
        - Checkout
        - Setup Rust (stable)
        - cargo check --workspace
        - cargo test --workspace
        - cargo clippy --workspace -- -D warnings
  ```

- Update `turbo.json` to include `typecheck`, `lint`, and `test` tasks if not already defined

- Add scripts to root `package.json`:
  - `"typecheck": "turbo typecheck"`
  - `"lint": "turbo lint"`
  - `"test": "turbo test"`

- Add to each TypeScript package's `package.json`:
  - `"typecheck": "tsc --noEmit"`
  - `"lint": "eslint src/"` (or similar)
  - `"test": "vitest run"` (or `"echo 'no tests yet'"` for packages without tests)

### Acceptance criteria

- GitHub Actions workflow file is valid YAML
- Workflow triggers on PR and push to main
- TypeScript checks run via Turborepo
- Rust checks run via Cargo
- All currently-existing code passes CI (even if it's just placeholders)

### Learnings
<!-- Filled in after completion -->

---

## Task 9: Set up BetterAuth with organization and API key plugins

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: configure BetterAuth with org and API key plugins`

### What to build

Configure BetterAuth as the auth layer for the control plane API. Set up the BetterAuth server with MySQL adapter (PlanetScale), organization plugin, API key plugin, and OAuth providers (GitHub, Google).

### Context

BetterAuth is a framework-agnostic TypeScript auth library. It auto-creates its own tables via a migration CLI and exposes auth endpoints at `/api/auth/*`. We use three plugins:
- **Organization plugin**: team management, roles (owner/admin/member), invitations
- **API key plugin**: managed API keys with hashing, prefix storage, metadata JSON
- **OAuth**: GitHub (primary) and Google providers

Reference `docs/spec/10-security.md` → "Authentication" and `docs/spec/08-data-model.md` → "BetterAuth-managed tables".

### Files to create/modify

- `apps/api/src/auth.ts` — BetterAuth server configuration:
  ```typescript
  import { betterAuth } from 'better-auth'
  import { organization, apiKey } from 'better-auth/plugins'

  export const auth = betterAuth({
    database: {
      type: 'mysql',
      url: process.env.DATABASE_URL!,  // PlanetScale connection string
    },
    emailAndPassword: { enabled: true },
    socialProviders: {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      },
    },
    plugins: [
      organization(),
      apiKey(),
    ],
  })
  ```

- `apps/api/src/auth-client.ts` — BetterAuth client (for server-side API calls):
  ```typescript
  import { createAuthClient } from 'better-auth/client'
  import { organizationClient, apiKeyClient } from 'better-auth/client/plugins'

  export const authClient = createAuthClient({
    plugins: [organizationClient(), apiKeyClient()],
  })
  ```

- Update `apps/api/package.json` — Add `better-auth` dependency

- Update `apps/api/src/index.ts` — Mount BetterAuth handler at `/api/auth/*`

### Key implementation details

- BetterAuth uses Kysely internally for database access — compatible with PlanetScale MySQL
- **This task owns the BetterAuth migration**: Run `npx @better-auth/cli generate` (after creating the auth config above) to produce the migration SQL. Commit it as `packages/db/migrations/001_betterauth_schema.sql`. This creates the 8 BetterAuth-managed tables: `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `apikey`.
- **Do not hand-edit** `001_betterauth_schema.sql` — regenerate via `npx @better-auth/cli generate` if BetterAuth config changes
- API key validation: `auth.api.verifyApiKey({ key })` returns the key's metadata including org_id
- Session validation: `auth.api.getSession({ headers })` returns the user and active org
- BetterAuth handles password hashing, session token generation, OAuth flows, and CSRF protection

### Acceptance criteria

- `npx tsc --noEmit` passes in `apps/api/`
- BetterAuth migration SQL is generated and committed as `packages/db/migrations/001_betterauth_schema.sql`
- BetterAuth migration (001) creates all 8 BetterAuth-managed tables
- BetterAuth handler is exported and mountable (module compiles and exports `auth` object)
- OAuth providers are configured with env var references for `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- Auth config includes `apiKey()` plugin with correct metadata schema for org_id scoping
- Auth config includes `organization()` plugin

### Learnings
<!-- Filled in after completion -->
