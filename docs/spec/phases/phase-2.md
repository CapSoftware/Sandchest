# Phase 2 — Core Runtime

> The hardest phase. Build the guest agent, node daemon, control plane, and get a full E2E working: create a sandbox, run a command, get output back through the SDK.

<!--
SELF-HEALING INSTRUCTIONS
=========================
When you receive "continue docs/spec/phases/phase-2.md":

1. Read this file top to bottom
2. Find the FIRST task with `[ ]` (unchecked)
3. Read the task's full context, spec references, and acceptance criteria
4. Read the referenced spec files for additional detail
5. Execute the task — create/modify files as specified
6. When the task is complete:
   a. Run any acceptance criteria checks (build, typecheck, tests, cargo check)
   b. Mark the checkbox `[x]`
   c. Fill in the "Learnings" section with anything discovered during execution
   d. Stage the relevant files with `git add` (specific files, not -A)
   e. Commit: `git commit -m "{type}: {description}"`
      - Use conventional commit types: feat|fix|chore|test|refactor|ci|docs|perf
      - Author will be git config default (Richie McIlroy)
      - NO Co-Authored-By lines
   f. Save/update this phase file with the checked box + learnings
7. Move to the next `[ ]` task and repeat
8. If ALL tasks are `[x]`, report: "Phase 2 complete. Ready for Phase 3."

IMPORTANT:
- Phase 2 depends on Phase 1 being complete (monorepo, contracts, schema exist)
- Read the spec files referenced in each task before starting work
- Rust tasks require bare-metal Linux for full testing — build/check is sufficient on other platforms
- If a task is blocked, note the blocker in Learnings and move to the next unblocked task
-->

**Prerequisites**: Phase 1 complete (monorepo structure, contract types, protobuf definitions, DB schema, SDK skeleton, CI pipeline).

### Phase 1 Discoveries (apply to all Phase 2 tasks)

These were learned during Phase 1 execution and affect how Phase 2 tasks should be implemented:

1. **`bun test`, not vitest** — The project uses `bun test` (Jest-compatible API, `@types/bun` for types). Do not add vitest as a dependency.
2. **Proto types use namespace re-exports** — Generated proto types conflict with hand-written REST types (e.g., both define `ExecRequest`). Contract exports them as `nodeRpc.*` and `agentRpc.*`. All Phase 2 imports must use:
   ```ts
   import { nodeRpc, agentRpc } from '@sandchest/contract'
   // nodeRpc.ExecRequest (proto), ExecRequest (REST)
   ```
3. **gRPC stubs are `generic-definitions`** — ts-proto was configured with `outputServices=generic-definitions` (framework-agnostic, no `@grpc/grpc-js` dependency). Use `nice-grpc` (which natively consumes generic definitions) instead of raw `@grpc/grpc-js` for the control plane gRPC server and client.
4. **tonic pinned at 0.12** — Rust crates use tonic 0.12 / prost 0.12. Keep `tonic-build` at 0.12 to match. Upgrade to 0.14 only if a specific feature is needed.
5. **DB package uses Bundler resolution** — `packages/db` uses `"moduleResolution": "Bundler"` (drizzle-kit requirement). Its `dist/` output is compatible with NodeNext consumers, but extensionless imports are used internally.
6. **BetterAuth already configured** — `apps/api/src/auth.ts` and `apps/api/src/auth-client.ts` exist from Phase 1 Task 9. BetterAuth uses its own `mysql2/promise` pool. Share or coordinate with Drizzle's pool.
7. **`exactOptionalPropertyTypes` is enabled** — All optional properties must use `| undefined` (not just `?:`). This catches real bugs but causes cryptic errors if forgotten.
8. **No local MySQL for BetterAuth CLI** — `@better-auth/cli generate` requires a running MySQL instance. The Phase 1 migration was hand-written from BetterAuth source.

---

## Task 1: Scaffold guest agent with vsock gRPC server and health endpoint

- [x] **Status**: Complete
- **Commit type**: `feat`
- **Commit message**: `feat: scaffold guest agent with vsock gRPC server and health check`

### What to build

Set up the Rust guest agent binary that will run inside each Firecracker microVM. It listens on vsock (CID=3, port=52) and serves gRPC. Start with just the Health endpoint.

### Context

Reference `docs/spec/03-firecracker-runtime.md` → "Guest agent" section. The agent:
- Is a statically-linked Rust binary (~5 MB) compiled with musl
- Runs as a systemd service
- Listens on vsock CID=3, port=52
- Serves the `GuestAgent` gRPC service defined in `packages/contract/proto/sandchest/agent/v1/agent.proto`
- Signals readiness via sd_notify (or by responding to Health RPC)

### Files to create/modify

- `crates/sandchest-agent/Cargo.toml` — Dependencies:
  - `tokio` (full features)
  - `tonic = "0.12"` (gRPC framework — match existing pin)
  - `prost = "0.12"` (protobuf — match tonic 0.12)
  - `tonic-build = "0.12"` (build script — must match tonic version)
  - `tokio-vsock` (vsock listener — may need `vsock` crate)
  - `tracing`, `tracing-subscriber` (logging)

- `crates/sandchest-agent/build.rs` — Compile proto files with tonic-build

- `crates/sandchest-agent/src/main.rs` — Entry point:
  - Parse CLI args (optional: vsock CID and port)
  - Initialize tracing
  - Start gRPC server on vsock
  - Log "Guest agent ready on vsock CID=3 port=52"

- `crates/sandchest-agent/src/service.rs` — GuestAgent service implementation:
  - `Health` — Returns `HealthResponse { ready: true }`
  - All other RPCs — Return `Status::unimplemented()` for now

- `crates/sandchest-agent/src/vsock.rs` — vsock listener wrapper:
  - Abstract over vsock vs TCP for development (vsock only works in VMs)
  - Feature flag: `--features tcp-dev` to listen on TCP instead of vsock for local development

### Key technical notes

- **vsock may not be available on dev machines.** Add a TCP fallback for local development. Use a feature flag or env var (`SANDCHEST_AGENT_DEV=1`) to switch.
- The proto files are in `packages/contract/proto/`. Configure tonic-build to find them.
- Static linking with musl: add `x86_64-unknown-linux-musl` target for production builds. Dev builds can use default target.

### Acceptance criteria

- `cargo check -p sandchest-agent` passes
- `cargo build -p sandchest-agent` succeeds
- Agent binary starts and logs readiness message
- In TCP dev mode, `grpcurl` (or similar) can call Health and get a response
- Unimplemented RPCs return proper gRPC status

### Learnings

1. **prost must be 0.13, not 0.12** — `tonic 0.12.3` internally depends on `prost 0.13.5`. Using `prost = "0.12"` in `Cargo.toml` causes a version conflict: generated code uses prost 0.13 derive macros (via `prost-build 0.13`), but runtime expects prost 0.12 traits. Fix: use `prost = "0.13"` and `prost-types = "0.13"`.
2. **vsock feature flag, not `tcp-dev`** — Since vsock only compiles on Linux, the feature flag is `vsock` (opt-in for production) rather than `tcp-dev` (opt-in for development). TCP is the default, vsock requires `--features vsock` on Linux. Runtime also checks `SANDCHEST_AGENT_DEV=1` env var.
3. **`tonic::include_proto!("sandchest.agent.v1")`** — The proto package name is used directly with dots as the module identifier. tonic-build generates the file as `sandchest.agent.v1.rs` in `OUT_DIR`.
4. **`google.protobuf.Empty` maps to `()`** — With tonic-build + prost-build 0.13, `google.protobuf.Empty` is mapped to unit type `()` in method signatures, not a separate struct.
5. **Streaming RPCs need associated types** — Server-streaming RPCs (like `Exec`) require defining `type ExecStream = ReceiverStream<Result<ExecEvent, Status>>` on the service impl. Client-streaming RPCs (like `PutFile`) receive `Request<Streaming<FileChunk>>`.
6. **`tokio-vsock 0.4`** — Version 0.4 is compatible with tokio 1.x. Latest is 0.7.2. Pinned as optional `cfg(target_os = "linux")` dep.

---

## Task 2: Implement guest agent exec — spawn process, stream output, resource tracking

- [x] **Status**: Complete
- **Commit type**: `feat`
- **Commit message**: `feat: implement exec RPC in guest agent with output streaming and resource tracking`

### What to build

Implement the `Exec` RPC on the guest agent. It spawns a process, streams stdout/stderr as `ExecEvent` messages, and reports exit code + resource usage on completion.

### Context

Reference `docs/spec/03-firecracker-runtime.md` → "gRPC service definition" for the proto, and → "Resource usage tracking" for /proc reading.

The Exec RPC:
- Input: `ExecRequest` with `cmd` (array) or `shell_cmd` (string), `cwd`, `env`, `timeout_seconds`
- Output: `stream ExecEvent` — sequence of stdout/stderr chunks followed by an ExitEvent
- If `cmd` is set: execute directly (no shell interpretation) — use `tokio::process::Command`
- If `shell_cmd` is set: execute via `/bin/sh -c "{shell_cmd}"`
- Stream stdout and stderr as separate `ExecEvent` variants with sequential `seq` numbers
- On process exit: read `/proc/{pid}/stat` for CPU time, `/proc/{pid}/status` for VmHWM
- Final event: `ExitEvent { exit_code, cpu_ms, peak_memory_bytes, duration_ms }`
- Timeout: kill process after `timeout_seconds` (SIGTERM, wait 5s, SIGKILL)

### Files to create/modify

- `crates/sandchest-agent/src/exec.rs`:
  - `run_exec(request: ExecRequest) -> impl Stream<Item = ExecEvent>`
  - Spawn process with `tokio::process::Command`
  - Set cwd, env vars
  - Read stdout/stderr concurrently (tokio::select! or spawn separate tasks)
  - Track sequence numbers
  - Read resource usage from /proc before process exits (sample at start and end)
  - Handle timeout (tokio::time::timeout wrapping the process)
  - Return ExitEvent as final stream item

- `crates/sandchest-agent/src/proc.rs`:
  - `read_cpu_time(pid: u32) -> Result<u64>` — Parse `/proc/{pid}/stat`, extract utime + stime
  - `read_peak_memory(pid: u32) -> Result<u64>` — Parse `/proc/{pid}/status`, extract VmHWM
  - Note: These /proc reads may fail if process exits before we read. Handle gracefully.

- Update `crates/sandchest-agent/src/service.rs`:
  - Wire up `Exec` RPC to `exec::run_exec`

### Key implementation details

- Use `tokio::process::Command` with `.stdout(Stdio::piped())` and `.stderr(Stdio::piped())`
- Read stdout/stderr in chunks (4-8 KB buffers) — don't wait for full output
- Resource usage: Read `/proc/{pid}/stat` at spawn and at exit. CPU = (end_utime + end_stime) - (start_utime + start_stime). Convert from clock ticks to milliseconds (divide by sysconf(_SC_CLK_TCK), typically 100).
- If /proc reads fail (process already exited), report 0 for resource usage
- Timeout flow: spawn process → wait with timeout → if timeout: SIGTERM → wait 5s → SIGKILL

### Acceptance criteria

- `cargo check -p sandchest-agent` passes
- In TCP dev mode: can call Exec with `cmd: ["echo", "hello"]` and receive stdout "hello\n" + exit 0
- Streaming works: events arrive as they're produced, not all at once
- Timeout kills long-running processes
- Exit code is correctly reported (including non-zero)

### Learnings

1. **`tokio::select!` for concurrent stdout/stderr** — Using `tokio::select!` with boolean guards (`if !stdout_done`) is the cleanest way to read both streams concurrently without spawning separate tasks. The guards prevent polling completed streams.
2. **Timeout via `sleep_until` avoids Option** — Instead of wrapping timeout in `Option<Sleep>` (which is awkward to pin), use `sleep_until` with a far-future deadline when no timeout is set. This keeps the `tokio::select!` branch always present.
3. **`libc::kill` for SIGTERM** — `tokio::process::Child::kill()` sends SIGKILL (not SIGTERM). For graceful shutdown, use `libc::kill(pid, libc::SIGTERM)` directly, guarded by `#[cfg(unix)]`.
4. **Process killed by signal → 128 + signal** — On Unix, when a process is killed by a signal, `ExitStatus::code()` returns `None`. Use `ExitStatusExt::signal()` to get the signal number and return `128 + signal` (standard Unix convention).
5. **`/proc` reads fail gracefully on non-Linux** — Since `/proc/{pid}/stat` and `/proc/{pid}/status` don't exist on macOS, all proc reads return `Err` which maps to 0 via `unwrap_or(0)`. Dev mode still works.

---

## Task 3: Implement guest agent sessions — persistent shell with pty

- [x] **Status**: Complete
- **Commit type**: `feat`
- **Commit message**: `feat: implement session RPCs in guest agent with pty and sentinel-based output capture`

### What to build

Implement CreateSession, SessionExec, SessionInput, and DestroySession RPCs. Sessions are persistent shell processes where commands share state.

### Context

Reference `docs/spec/03-firecracker-runtime.md` → "Session management" section.

Sessions work differently from exec:
- CreateSession spawns a persistent shell process (`/bin/bash`) with a pty
- SessionExec writes a command to the shell's stdin with a sentinel marker, captures output until the sentinel, extracts exit code
- SessionInput sends raw stdin to the shell (for interactive use)
- DestroySession kills the shell process (SIGHUP → wait 5s → SIGKILL)

**Sentinel pattern for SessionExec:**
```bash
{command}; __sc_exit=$?; echo "__SC_SENTINEL_${seq}_${__sc_exit}__"
```
The agent scans output for `__SC_SENTINEL_{seq}_{exit_code}__` to determine when the command finished.

### Files to create/modify

- `crates/sandchest-agent/src/session.rs`:
  - `SessionManager` struct — manages active sessions by session_id
  - `create_session(request: CreateSessionRequest) -> SessionResponse`
    - Spawn shell process with a pty (use `portable-pty` or `nix::pty::openpty`)
    - Track by session_id
    - Max 5 concurrent sessions (return error if exceeded)
  - `session_exec(request: SessionExecRequest) -> impl Stream<Item = ExecEvent>`
    - Write command + sentinel to shell stdin
    - Read output from pty, scan for sentinel
    - Everything before sentinel is command output
    - Extract exit code from sentinel
    - One command at a time per session (mutex or check)
  - `session_input(request: SessionInputRequest) -> Empty`
    - Raw write to shell stdin
  - `destroy_session(request: DestroySessionRequest) -> Empty`
    - SIGHUP to process group → wait 5s → SIGKILL
    - Remove from session manager

- Update `crates/sandchest-agent/src/service.rs`:
  - Wire up all session RPCs

### Key implementation details

- **PTY**: Use `nix::pty::openpty` or the `portable-pty` crate for pty allocation. The pty gives us a master/slave pair — shell reads/writes from slave, we read/write from master.
- **Sentinel scanning**: Read pty output in a buffer, scan for the sentinel pattern. Handle the case where the sentinel spans two read chunks.
- **Concurrency**: Only one SessionExec at a time per session. Use a per-session mutex. Concurrent exec → return gRPC error (maps to HTTP 409 Conflict).
- **Resource usage**: Sessions don't track per-command resource usage (no separate /proc entry per command in a persistent shell). Report duration only.

### Acceptance criteria

- `cargo check -p sandchest-agent` passes
- Can create a session, run `cd /tmp`, then run `pwd` and get `/tmp` back
- Environment variables set in one command persist to the next
- Sentinel is properly parsed and exit codes are correct
- DestroySession kills the shell process
- Concurrent exec on same session returns error

### Learnings

1. **`nix 0.29` for PTY operations** — `nix::pty::openpty(None, None)` returns `OpenptyResult { master: OwnedFd, slave: OwnedFd }`. The slave must stay alive through `cmd.spawn()` (since `pre_exec` runs in the child after fork) and then be dropped in the parent.
2. **PTY master async I/O via `spawn_blocking`** — Rather than wrapping the PTY master fd in `AsyncFd`, using `fcntl(O_NONBLOCK)` on the master and reading via `spawn_blocking` with `WouldBlock` → empty vec is simpler. The 10ms poll interval is acceptable for interactive shell use.
3. **Sentinel must be unique per exec** — Using nanosecond timestamp in the sentinel marker (`__SC_SENTINEL_{nanos}_{exit_code}__`) prevents false matches. Sentinel scanning handles cross-chunk boundaries by keeping a 256-byte tail buffer.
4. **PTY echoes input** — When writing a command to a PTY master, the terminal driver echoes it back. `strip_command_echo` removes this by looking for the `__sc_exit=$?;` pattern and stripping everything up to that line.
5. **Session shell flags** — `--norc --noprofile` with `PS1=""` and `TERM=dumb` prevents shell startup files and prompts from interfering with sentinel detection.
6. **`std::mem::forget(file)` for borrowed fd I/O** — When using `File::from_raw_fd()` to read/write a borrowed fd in `spawn_blocking`, the `File` must be forgotten to prevent it from closing the fd owned by the session.
7. **Pre-existing clippy fix** — `exec.rs` had `let _ = child.kill()` flagged as `let_underscore_future`. Fixed by awaiting it.

---

## Task 4: Implement guest agent file operations and shutdown

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: implement file operations and shutdown handler in guest agent`

### What to build

Implement PutFile, GetFile, ListFiles, and Shutdown RPCs on the guest agent.

### Context

Reference `docs/spec/03-firecracker-runtime.md` → "gRPC service definition" for the proto types. File operations transfer files between the node daemon and the guest filesystem via gRPC streaming.

### Files to create/modify

- `crates/sandchest-agent/src/files.rs`:
  - `put_file(stream: Streaming<FileChunk>) -> PutFileResponse`
    - Receive file chunks via streaming RPC
    - Write to destination path (path specified in first chunk's metadata)
    - Create parent directories if they don't exist
    - Return bytes written, sha256 checksum
  - `get_file(request: GetFileRequest) -> impl Stream<Item = FileChunk>`
    - Read file at path, stream back in chunks (64 KB)
    - Return error if file doesn't exist
  - `list_files(request: ListFilesRequest) -> ListFilesResponse`
    - List directory contents at path
    - Include: name, size, is_directory, modified_at
    - Non-recursive (single level)
    - Handle pagination if needed (offset/limit)

- `crates/sandchest-agent/src/shutdown.rs`:
  - `shutdown() -> Empty`
    - Kill all running execs (iterate exec manager)
    - Destroy all sessions
    - Flush any pending data
    - Signal systemd (sd_notify STOPPING=1) if applicable
    - Exit process

- `crates/sandchest-agent/src/snapshot.rs`:
  - Snapshot awareness for fork support (Phase 3, but scaffold now):
    - Heartbeat file writer: periodically write timestamp to `/tmp/.sandchest_heartbeat`
    - On startup: check if heartbeat file exists with stale timestamp → snapshot restore detected
    - If restore detected: re-seed `/dev/urandom`, correct system clock, re-init vsock listener

- Update `crates/sandchest-agent/src/service.rs`:
  - Wire up PutFile, GetFile, ListFiles, Shutdown RPCs

### Acceptance criteria

- `cargo check -p sandchest-agent` passes
- PutFile: can upload a file and read it back with GetFile
- ListFiles: returns correct directory listing
- Shutdown: agent exits cleanly
- Heartbeat file is written periodically (every 1s)
- All guest agent RPCs are now implemented (no more unimplemented stubs)

### Learnings
<!-- Filled in after completion -->

---

## Task 5: Scaffold node daemon with Firecracker process management

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: scaffold node daemon with firecracker process lifecycle management`

### What to build

Set up the Rust node daemon binary that manages Firecracker microVMs on a bare-metal Linux host. Implement the core VM lifecycle: create from rootfs (cold boot), configure, start, wait for agent health, destroy.

### Context

Reference `docs/spec/03-firecracker-runtime.md` → "Sandbox lifecycle" → "Cold boot" section, and → "MicroVM configuration" for the Firecracker config format.

The node daemon:
- Runs directly on the host (not in a container)
- Manages Firecracker processes (one per sandbox)
- Communicates with the control plane via gRPC
- Communicates with guest agents via vsock

### Files to create/modify

- `crates/sandchest-node/Cargo.toml` — Dependencies:
  - `tokio` (full features)
  - `tonic = "0.12"` (gRPC — match existing pin)
  - `prost = "0.12"` (protobuf — match tonic 0.12)
  - `tonic-build = "0.12"` (build script — must match tonic version)
  - `reqwest` (Firecracker API is HTTP over Unix socket)
  - `serde`, `serde_json` (Firecracker config)
  - `tracing`, `tracing-subscriber`
  - `uuid` (UUIDv7)

- `crates/sandchest-node/src/main.rs` — Entry point:
  - Parse config (node ID, control plane address, data directory paths)
  - Initialize tracing
  - Start gRPC server for control plane communication
  - Start heartbeat loop

- `crates/sandchest-node/src/firecracker.rs` — Firecracker process management:
  - `FirecrackerVM` struct: pid, api_socket_path, sandbox_id, vsock_path
  - `create_vm(config: VmConfig) -> Result<FirecrackerVM>`:
    1. Create data directory: `/var/sandchest/sandboxes/{sandbox_id}/`
    2. Write Firecracker config JSON (from spec: boot-source, drives, machine-config, vsock, network-interfaces)
    3. Start Firecracker process: `firecracker --api-sock {path} --config-file {path}`
    4. Wait for Firecracker API to be ready (poll socket)
    5. Return VM handle
  - `destroy_vm(vm: &FirecrackerVM) -> Result<()>`:
    1. Kill Firecracker process (SIGTERM → wait 5s → SIGKILL)
    2. Clean up data directory
    3. Clean up vsock socket

- `crates/sandchest-node/src/config.rs` — Firecracker VM configuration builder:
  - Build JSON config from `VmConfig` struct
  - Map profile (small/medium/large) to vcpu_count + mem_size_mib
  - Set kernel path, rootfs path, vsock path
  - Configure network interface (TAP device name, guest MAC)

- `crates/sandchest-node/src/sandbox.rs` — Sandbox state manager:
  - `SandboxManager` struct — tracks active sandboxes by ID
  - `create_sandbox(request) -> Result<SandboxInfo>` — orchestrates the full cold boot flow
  - `destroy_sandbox(sandbox_id) -> Result<()>`
  - `get_sandbox(sandbox_id) -> Option<&SandboxInfo>`
  - `list_sandboxes() -> Vec<SandboxInfo>`

### Key details from spec

Firecracker config structure (from `docs/spec/03-firecracker-runtime.md`):
```json
{
  "boot-source": {
    "kernel_image_path": "/var/sandchest/images/vmlinux-5.10",
    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/overlay-init"
  },
  "drives": [{
    "drive_id": "rootfs",
    "path_on_host": "/var/sandchest/sandboxes/{id}/rootfs.ext4",
    "is_root_device": true,
    "is_read_only": false
  }],
  "machine-config": { "vcpu_count": 2, "mem_size_mib": 4096, "smt": false },
  "vsock": { "guest_cid": 3, "uds_path": "/var/sandchest/sandboxes/{id}/vsock.sock" },
  "network-interfaces": [{
    "iface_id": "eth0",
    "guest_mac": "AA:FC:00:00:00:01",
    "host_dev_name": "tap-{id}"
  }]
}
```

Resource profiles: small (2cpu/4GB), medium (4cpu/8GB), large (8cpu/16GB).

### Acceptance criteria

- `cargo check -p sandchest-node` passes
- `cargo build -p sandchest-node` succeeds
- Node daemon starts and logs readiness
- Firecracker config JSON generation produces valid configs
- SandboxManager tracks sandbox state correctly (unit tests)
- On a bare-metal Linux host (if available): can cold boot a Firecracker VM

### Learnings
<!-- Filled in after completion -->

---

## Task 6: Implement node daemon cold boot and warm start

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: implement cold boot and snapshot-based warm start in node daemon`

### What to build

Complete the sandbox creation flow with both cold boot (from rootfs) and warm start (from snapshot). This includes per-sandbox disk cloning via reflink copy to produce an ext4 file Firecracker can use directly as a block device.

### Context

Reference `docs/spec/03-firecracker-runtime.md` → "Cold boot" and "Warm start" sections, plus → "Disk management" → "Copy-on-write strategy".

**Disk cloning strategy**: Use `cp --reflink=auto` to clone the base ext4 image into a per-sandbox ext4 file. On XFS or btrfs this is an instant CoW clone (no data copied); on other filesystems it falls back to a regular copy. The cloned file is passed directly to Firecracker as the drive's `path_on_host` — no intermediate loop device or overlay mount needed. The `overlay-init` custom init inside the VM (specified in `boot_args`) handles the read-write upper layer inside the guest; the host only needs to supply the base ext4 file per sandbox.

**Cold boot flow** (3-5 seconds):
1. Clone base image ext4: `cp --reflink=auto /var/sandchest/images/{image_id}/rootfs.ext4 /var/sandchest/sandboxes/{sandbox_id}/rootfs.ext4`
2. Configure Firecracker with the cloned ext4 file as `path_on_host`
3. Start Firecracker process
4. Wait for guest agent health check (poll vsock, 100ms intervals, 10s timeout)
5. Store environment variables in sandbox state for inclusion in all exec/session requests
6. Mark sandbox as running

**Warm start flow** (1-2 seconds):
1. Clone snapshot's disk state: `cp --reflink=auto /var/sandchest/snapshots/{image_id}/rootfs.ext4 /var/sandchest/sandboxes/{sandbox_id}/rootfs.ext4`
2. Start new Firecracker process
3. Load snapshot: `PUT /snapshot/load` via Firecracker API
4. Resume VM: `PATCH /vm` with `state: "Resumed"`
5. Wait for agent health (near-instant — agent was running at snapshot time)
6. Store environment variables in sandbox state for inclusion in all exec/session requests
7. Mark running

### Files to create/modify

- `crates/sandchest-node/src/disk.rs` — CoW disk management:
  - `clone_disk(src_ext4: &str, sandbox_id: &str) -> Result<String>`
    - Create sandbox directory: `/var/sandchest/sandboxes/{sandbox_id}/`
    - Run: `cp --reflink=auto {src_ext4} /var/sandchest/sandboxes/{sandbox_id}/rootfs.ext4`
    - Return the dest path: `/var/sandchest/sandboxes/{sandbox_id}/rootfs.ext4`
  - `cleanup_disk(sandbox_id: &str) -> Result<()>`
    - Remove sandbox directory and its contents
    - Return error if already absent (idempotent)

- `crates/sandchest-node/src/snapshot.rs` — Snapshot operations:
  - `restore_snapshot(sandbox_id: &str, snapshot_path: &str, mem_path: &str) -> Result<()>`
    - Call Firecracker API: `PUT /snapshot/load` with paths
  - `resume_vm(api_socket: &str) -> Result<()>`
    - Call Firecracker API: `PATCH /vm` with `state: "Resumed"`
  - `pause_vm(api_socket: &str) -> Result<()>`
    - Call Firecracker API: `PATCH /vm` with `state: "Paused"`
  - `take_snapshot(api_socket: &str, snapshot_path: &str, mem_path: &str) -> Result<()>`
    - Call Firecracker API: `PUT /snapshot/create`

- `crates/sandchest-node/src/agent_client.rs` — Guest agent gRPC client:
  - `AgentClient` — connects to guest agent via vsock
  - `wait_for_health(vsock_path: &str, timeout: Duration) -> Result<()>` — Poll health endpoint
  - Later: exec, session, file methods will be added (env vars are passed per-request via `ExecRequest.env` / `CreateSessionRequest.env`)

- Update `crates/sandchest-node/src/sandbox.rs`:
  - `create_sandbox` now uses full cold boot or warm start flow
  - Check if base snapshot exists → warm start, else → cold boot
  - After VM is running, wait for agent health
  - Store sandbox env vars in `SandboxManager` state; merge into every `ExecRequest.env` and `CreateSessionRequest.env` when proxying to the guest agent
  - Track boot_duration_ms

### Acceptance criteria

- `cargo check -p sandchest-node` passes
- `clone_disk()` produces a file at `/var/sandchest/sandboxes/{id}/rootfs.ext4` (unit test with a small ext4 fixture; integration test on Linux verifies reflink is used when available)
- Firecracker config uses the cloned ext4 path as `path_on_host` — not a directory
- Firecracker API calls are correctly formatted
- Agent client can connect via vsock (or TCP in dev mode) and call Health
- Cold boot and warm start paths are both implemented
- Sandbox env vars are stored locally and merged into exec/session requests
- Boot duration is tracked

### Learnings
<!-- Filled in after completion -->

---

## Task 7: Implement node daemon networking — TAP device and NAT

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: implement per-sandbox TAP device and NAT networking in node daemon`

### What to build

Set up per-sandbox networking: create a TAP device, configure NAT via iptables, and clean up on sandbox destruction.

### Context

Reference `docs/spec/03-firecracker-runtime.md` → "Networking" section.

Each microVM gets a TAP device with NAT. This provides outbound internet access (for git clone, npm install, etc.) with no inbound access.

**Network setup per sandbox:**
```bash
# Create tap device
ip tuntap add tap-{id} mode tap
ip addr add 172.16.{slot}.1/30 dev tap-{id}
ip link set tap-{id} up

# NAT masquerade
iptables -t nat -A POSTROUTING -o eth0 -s 172.16.{slot}.0/30 -j MASQUERADE
iptables -A FORWARD -i tap-{id} -o eth0 -j ACCEPT
iptables -A FORWARD -i eth0 -o tap-{id} -m state --state RELATED,ESTABLISHED -j ACCEPT
```

**Guest VM configured with:**
- IP: `172.16.{slot}.2/30`
- Gateway: `172.16.{slot}.1`
- DNS: `1.1.1.1`

### Files to create/modify

- `crates/sandchest-node/src/network.rs`:
  - `setup_network(sandbox_id: &str, slot: u16) -> Result<NetworkConfig>`
    - Create TAP device: `tap-{sandbox_id_short}`
    - Assign IP: `172.16.{slot}.1/30`
    - Bring up interface
    - Add iptables rules for NAT
    - Return `NetworkConfig { tap_name, host_ip, guest_ip, gateway, dns }`
  - `teardown_network(sandbox_id: &str, slot: u16) -> Result<()>`
    - Remove iptables rules
    - Delete TAP device
  - `setup_bandwidth_limit(tap_name: &str, rate_mbps: u32) -> Result<()>`
    - Use `tc` to rate-limit per-sandbox bandwidth (default 100 Mbps)

- `crates/sandchest-node/src/slot.rs`:
  - `SlotManager` — tracks which network slots (0-255) are in use
  - `allocate_slot() -> Result<u16>`
  - `release_slot(slot: u16)`

- Update `crates/sandchest-node/src/sandbox.rs`:
  - Integrate network setup into sandbox creation flow
  - Integrate network teardown into sandbox destruction

### Key details

- The `{slot}` number determines the /30 subnet. Slot 0 = 172.16.0.0/30, Slot 1 = 172.16.1.0/30, etc.
- TAP device names are limited to 15 chars. Use `tap-{first_8_chars_of_sandbox_id}` or similar truncation.
- All network commands require root privileges (the node daemon runs as root).
- Guest MAC address format: `AA:FC:00:00:{slot_hi}:{slot_lo}`

### Acceptance criteria

- `cargo check -p sandchest-node` passes
- Network setup creates TAP device and iptables rules (verifiable with ip/iptables commands on Linux)
- Network teardown removes all created resources
- Slot allocation prevents IP conflicts
- Bandwidth limiting is applied

### Learnings
<!-- Filled in after completion -->

---

## Task 8: Implement node daemon exec/session/file routing to guest agent

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: implement exec, session, and file routing from node daemon to guest agent`

### What to build

The node daemon receives requests from the control plane and routes them to the appropriate guest agent inside the microVM. Implement the full routing layer for exec, sessions, and file operations.

### Context

Reference `docs/spec/01-architecture.md` → "Internal RPC (Control Plane ↔ Node)" for the message types, and `docs/spec/01-architecture.md` → "Data flow: sandbox create → exec → replay" for the flow.

The node daemon acts as a proxy:
1. Receives `Exec` request from control plane (with sandbox_id)
2. Looks up the sandbox → finds its vsock path
3. Connects to the guest agent via vsock
4. Forwards the exec request, streams output back
5. Reports events to control plane (ExecOutput, ExecCompleted)

### Files to create/modify

- `crates/sandchest-node/src/agent_client.rs` — Extend with full operations:
  - `exec(request: ExecRequest) -> impl Stream<Item = ExecEvent>` — Forward to guest agent, stream output
  - `create_session(request: CreateSessionRequest) -> SessionResponse`
  - `session_exec(request: SessionExecRequest) -> impl Stream<Item = ExecEvent>`
  - `session_input(request: SessionInputRequest) -> Empty`
  - `destroy_session(request: DestroySessionRequest) -> Empty`
  - `put_file(chunks: impl Stream<Item = FileChunk>) -> PutFileResponse`
  - `get_file(request: GetFileRequest) -> impl Stream<Item = FileChunk>`
  - `list_files(request: ListFilesRequest) -> ListFilesResponse`

- `crates/sandchest-node/src/router.rs` — Request routing:
  - Lookup sandbox by ID → get agent client connection
  - Handle sandbox-not-found errors
  - Handle agent-unreachable errors (sandbox failed/stopped)
  - Connection pooling: keep agent client connections alive per sandbox

- `crates/sandchest-node/src/rpc_server.rs` — gRPC server for control plane:
  - Implement the Node service (from `packages/contract/proto/sandchest/node/v1/node.proto`)
  - Use `tonic-build` 0.12 in `build.rs` to generate Rust server stubs from the same proto files
  - Handle all Control → Node messages
  - Route to appropriate sandbox's agent client
  - Stream responses back to control plane

### Acceptance criteria

- `cargo check -p sandchest-node` passes
- Node daemon accepts gRPC connections from control plane
- Exec requests are routed to the correct guest agent
- Streaming output flows: guest agent → node daemon → control plane
- Session operations are properly routed
- File operations work through the proxy layer
- Unknown sandbox IDs return proper errors

### Learnings
<!-- Filled in after completion -->

---

## Task 9: Implement node daemon heartbeat and event reporting

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: implement heartbeat and event reporting in node daemon`

### What to build

Implement the heartbeat loop that reports node health to the control plane, and the event reporting system that streams sandbox lifecycle events.

### Context

Reference `docs/spec/01-architecture.md` → "Internal RPC" → "Keepalive" and "Node → Control messages".

**Heartbeat** (every 15 seconds):
- Active sandbox IDs
- Slot utilization (used / total)
- Snapshot inventory (which base snapshots are available on this node)
- Node version, Firecracker version

**Events** (real-time):
- `SandboxEvent` — created, ready, stopped, failed, forked
- `ExecOutput` — streaming stdout/stderr (exec_id, seq, type, data)
- `ExecCompleted` — final status (exec_id, exit_code, cpu_ms, peak_memory_bytes)
- `SessionOutput` — streaming session output
- `ArtifactReport` — batched artifact metadata after upload

Control plane marks node offline after 60 seconds of silence.

### Files to create/modify

- `crates/sandchest-node/src/heartbeat.rs`:
  - `start_heartbeat(control_plane_client, sandbox_manager, interval: Duration)`
  - Collect: active sandbox IDs, slot utilization, available snapshots
  - Send heartbeat via gRPC stream to control plane
  - Log warnings if heartbeat fails

- `crates/sandchest-node/src/events.rs`:
  - `EventReporter` — buffers and sends events to control plane
  - `report_sandbox_event(sandbox_id, event_type, data)`
  - `report_exec_output(exec_id, seq, stream_type, data)` — Real-time streaming
  - `report_exec_completed(exec_id, exit_code, cpu_ms, peak_memory_bytes)`
  - Events are sent via a persistent gRPC stream to the control plane
  - Buffer events if the stream is temporarily disconnected, replay on reconnect

- Update `crates/sandchest-node/src/sandbox.rs`:
  - Report `SandboxEvent(created)` when VM starts booting
  - Report `SandboxEvent(ready)` when agent health check passes
  - Report `SandboxEvent(stopped)` on graceful shutdown
  - Report `SandboxEvent(failed)` on errors

### Acceptance criteria

- `cargo check -p sandchest-node` passes
- Heartbeat sends every 15 seconds
- Sandbox lifecycle events are reported
- Exec output is streamed in real-time
- Event buffering handles temporary disconnections

### Learnings
<!-- Filled in after completion -->

---

## Task 10: Scaffold control plane API with EffectTS and BetterAuth

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: scaffold control plane API with effect-ts, BetterAuth dual-mode auth, and error handling`

### What to build

Set up the control plane HTTP API server using EffectTS on Node.js. Mount BetterAuth at `/api/auth/*`. Implement the middleware stack: dual-mode authentication (API key + session), rate limiting, error handling, request ID generation, and idempotency.

### Context

Reference `docs/spec/01-architecture.md` → "Control plane responsibilities" and `docs/spec/02-api-contract.md` → "Design principles" and `docs/spec/10-security.md` → "Authentication".

The control plane is the public-facing API that clients (SDK, CLI, MCP) talk to. It:
- Mounts BetterAuth at `/api/auth/*` (handles signup, signin, OAuth, org management, API key management)
- Authenticates requests via dual-mode middleware (API key or session cookie)
- Rate-limits requests
- Generates request IDs
- Handles idempotency
- Routes to business logic
- Communicates with nodes via gRPC
- Reads/writes PlanetScale MySQL
- Reads/writes Redis

### Files to create/modify

- `apps/api/package.json` — Dependencies:
  - `effect` (EffectTS core)
  - `@effect/platform` (HTTP server)
  - `@sandchest/db` (workspace dependency — Drizzle schema, client, column helpers)
  - `ioredis` (Redis client)
  - `nice-grpc` + `nice-grpc-server-middleware` (gRPC — consumes `generic-definitions` output from ts-proto natively; do NOT use `@grpc/grpc-js` directly as the generated stubs are framework-agnostic)
  - Note: `better-auth` and `mysql2` already installed from Phase 1 Task 9

- `apps/api/src/index.ts` — Entry point: start HTTP server on port 3000

- `apps/api/src/middleware/auth.ts` — BetterAuth dual-mode authentication:
  - **API key path**: Check `Authorization: Bearer {key}` header → validate via `auth.api.verifyApiKey({ key })` → extract `org_id` from key metadata → attach to request context
  - **Session path**: No Bearer token → validate via `auth.api.getSession({ headers })` → extract user and active org → attach `org_id` to request context
  - Missing/invalid credentials → 401
  - Note: BetterAuth handles key hashing, lookup, and revocation checks internally

- Mount BetterAuth handler in `apps/api/src/index.ts`:
  - `apps/api/src/auth.ts` already exists from Phase 1 Task 9 — import and mount it, do not recreate
  - `apps/api/src/auth-client.ts` already exists — use it for server-side auth calls
  - All requests to `/api/auth/*` are forwarded to BetterAuth's handler
  - BetterAuth manages signup, signin, signout, OAuth callbacks, org CRUD, API key CRUD

- `apps/api/src/middleware/rate-limit.ts` — Redis-backed rate limiting:
  - Token bucket per org per endpoint category
  - Categories: sandbox_create, exec, read
  - Limits from `org_quotas` table (cached)
  - Add `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers
  - 429 with `Retry-After` when exceeded

- `apps/api/src/middleware/request-id.ts`:
  - Generate `req_` prefixed request ID (UUIDv7)
  - Set `X-Request-Id` header on response
  - Propagate to all downstream calls

- `apps/api/src/middleware/idempotency.ts`:
  - Check `Idempotency-Key` header on mutations
  - Look up in `idempotency_keys` table
  - If found + completed: return cached response
  - If found + processing: return 409 (concurrent request)
  - If not found: insert as processing, continue, update on completion
  - Only cache 2xx responses

- `apps/api/src/middleware/error-handler.ts`:
  - Catch all errors, format as spec error envelope:
    ```json
    { "error": "error_code", "message": "...", "request_id": "req_...", "retry_after": null }
    ```

- `apps/api/src/db.ts` — Database setup using `createDatabase()` from `@sandchest/db`:
  ```typescript
  import { createDatabase } from '@sandchest/db'
  export const db = createDatabase(process.env.DATABASE_URL!)
  ```
  **Note**: BetterAuth (`apps/api/src/auth.ts`) already creates its own `mysql2/promise` pool. Consider sharing the same pool or at least using the same `DATABASE_URL`. Both pools connect to PlanetScale — two pools is acceptable (BetterAuth manages its own queries via Kysely), but don't create unnecessary connections. Keep BetterAuth's pool as-is and create a separate Drizzle pool in `db.ts`.
- `apps/api/src/redis.ts` — Redis connection setup (ioredis)

- `apps/api/src/routes/health.ts`:
  - `GET /healthz` — shallow liveness (return 200)
  - `GET /readyz` — deep readiness (check DB + Redis + at least one node online via node registry)

- `apps/api/src/grpc-server.ts` — gRPC server for node daemon connections:
  - **Use `nice-grpc` server** — it natively consumes the `generic-definitions` service definitions exported as `nodeRpc.ControlDefinition` from `@sandchest/contract`
  - Listen on a configurable port (default 50051) for incoming gRPC connections from node daemons
  - Implement the control plane side of the `StreamEvents` bidirectional stream from `packages/contract/proto/sandchest/node/v1/node.proto`
  - Import proto types via namespace: `import { nodeRpc } from '@sandchest/contract'` — use `nodeRpc.Heartbeat`, `nodeRpc.SandboxEvent`, etc.
  - Receives: `Heartbeat`, `SandboxEvent`, `ExecOutput`, `ExecCompleted`, `SessionOutput`, `ArtifactReport`
  - Route received events to appropriate handlers (node registry for heartbeats, event recorder + Redis SSE buffers for the rest)
  - Node daemons identify themselves by `node_id` in the initial heartbeat — the control plane looks up the node in the DB and rejects unknown nodes

- `apps/api/src/services/node-registry.ts` — Node heartbeat processing and status management:
  - `processHeartbeat(nodeId, heartbeat)` — update `nodes.status = 'online'`, `nodes.last_seen_at = NOW()`, slot utilization, and snapshot inventory in the `nodes` table
  - `startOfflineSweep(intervalMs: number)` — background loop (every 15s) that runs `UPDATE nodes SET status = 'offline' WHERE status = 'online' AND last_seen_at < NOW() - INTERVAL 60 SECOND`
  - `getOnlineNodes(profile?: string) -> Node[]` — query for nodes with `status = 'online'` and compatible capacity (used by scheduler in Task 14)
  - On control plane startup: start the gRPC server, start the offline sweep, begin accepting heartbeats
  - **Why this is needed**: Without heartbeat ingestion, no node can ever transition from `'offline'` to `'online'`. The scheduler (Tasks 11, 14) queries for online nodes — sandbox creation would always fail with `NoCapacity`.

### Acceptance criteria

- `npx tsc --noEmit` passes in `apps/api/`
- Server starts and responds to `/healthz`
- BetterAuth endpoints respond at `/api/auth/*` (signup, signin, signout)
- Dual-mode auth middleware validates API keys via `auth.api.verifyApiKey()` and sessions via `auth.api.getSession()`
- API key validation works via `auth.api.verifyApiKey()`
- Session validation works via `auth.api.getSession()`
- Error responses match the spec format
- Request IDs are generated and returned
- gRPC server starts on port 50051 and accepts node daemon connections
- Heartbeat processing updates `nodes.status` to `'online'` and sets `nodes.last_seen_at`
- Offline sweep marks nodes as `'offline'` after 60s of heartbeat silence
- `/readyz` checks node registry for at least one online node

### Learnings
<!-- Filled in after completion -->

---

## Task 11: Implement control plane sandbox CRUD, stop, and delete endpoints

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: implement sandbox CRUD, stop, and delete endpoints on control plane`

### What to build

Implement the sandbox lifecycle endpoints: create, get, list, stop, delete. Plus the supporting services: sandbox business logic, node gRPC client, and a replay placeholder.

### Context

Reference `docs/spec/02-api-contract.md` for every endpoint's request/response format, status codes, and behavior. This task focuses on the sandbox resource itself — exec, sessions, and files are added in Tasks 12 and 13.

### Endpoints to implement

1. **`POST /v1/sandboxes`** — Create sandbox
   - Validate image exists, profile exists
   - Check org quota (concurrent sandboxes)
   - Run scheduler (find node, reserve slot) — use a simple inline approach: query `nodes` table for an online node with available slots. Task 14 replaces this with Redis-backed atomic slot leasing.
   - Send CreateSandbox to node via gRPC client
   - Insert sandbox row in DB
   - Return sandbox with status (201)

2. **`GET /v1/sandboxes/{id}`** — Get sandbox
   - Look up by ID, verify org ownership
   - Return full sandbox object (200)

3. **`GET /v1/sandboxes`** — List sandboxes
   - Filter by status, image, forked_from
   - Cursor-based pagination (default 50, max 200)

4. **`POST /v1/sandboxes/{id}/stop`** — Graceful shutdown
   - Verify sandbox is running (409 if not)
   - Send StopSandbox to node
   - Update status to `stopping`
   - Return 202

5. **`DELETE /v1/sandboxes/{id}`** — Hard stop + soft delete
   - Send DestroySandbox to node (if running)
   - Update status to `deleted`
   - Return 200

### Files to create/modify

- `apps/api/src/routes/sandboxes.ts` — Sandbox CRUD + stop + delete routes
- `apps/api/src/routes/replay.ts` — Replay endpoint (placeholder for Phase 3, returns 501)
- `apps/api/src/services/sandbox.ts` — Sandbox business logic:
  - `createSandbox(orgId, options)` — validate, schedule, create on node, insert DB row
  - `getSandbox(orgId, sandboxId)` — lookup + ownership check
  - `listSandboxes(orgId, filters, cursor, limit)` — paginated query
  - `stopSandbox(orgId, sandboxId)` — graceful shutdown flow
  - `destroySandbox(orgId, sandboxId)` — hard stop + soft delete
- `apps/api/src/services/node-client.ts` — gRPC client to Firecracker nodes:
  - **Use `nice-grpc` client** — it natively consumes the `generic-definitions` service definitions exported as `nodeRpc.NodeDefinition` from `@sandchest/contract`
  - Import proto types via namespace: `import { nodeRpc } from '@sandchest/contract'`
  - `createSandbox(nodeId, config)` — send CreateSandbox RPC
  - `stopSandbox(nodeId, sandboxId)` — send StopSandbox RPC
  - `destroySandbox(nodeId, sandboxId)` — send DestroySandbox RPC
  - Connection management (one connection per node)

### Key details

- Sandbox status transitions follow the state machine from `docs/spec/02-api-contract.md`: `queued → provisioning → running → stopping → stopped` (with `failed` and `deleted` branches)
- Create returns 201 with initial status (`queued` or `provisioning`)
- Stop returns 202 (async operation)
- Delete is idempotent (deleting already-deleted returns 200)
- Stop is idempotent (stopping already-stopped returns 200 with `"status": "stopped"`)

### Acceptance criteria

- All 5 sandbox lifecycle endpoints are implemented
- Status code handling matches spec (201 for create, 202 for stop, 200 for get/list/delete)
- Pagination works with cursor-based approach
- Sandbox status transitions follow the state machine from spec
- Org ownership is verified on all operations
- `npx tsc --noEmit` passes

### Learnings
<!-- Filled in after completion -->

---

## Task 12: Implement scheduler and Redis integration

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: implement scheduler with Redis slot leasing and rate limiting`

### What to build

Implement the scheduler that assigns sandboxes to nodes, plus all Redis-backed functionality: slot leasing, rate limiting, SSE buffers, and idempotency cache.

### Context

Reference `docs/spec/01-architecture.md` → "Scheduler" and `docs/spec/09-infrastructure.md` → "Redis dependency".

**Scheduler flow:**
1. Check org quota (concurrent sandboxes)
2. Find node with available slot (query nodes table + Redis slot leases)
3. Reserve slot via Redis lease (key: `slot:{node_id}:{slot_num}`, TTL: 60s, renewable)
4. If no capacity → queue with timeout (`queue_timeout_seconds`)
5. Return assigned node

**Redis key patterns (from spec):**
| Function | Key pattern | TTL |
|----------|-----------|-----|
| Slot leasing | `slot:{node_id}:{slot_num}` | 60s (renewable) |
| Rate limiting | `rate:{org_id}:{endpoint}` | 60s (sliding window) |
| SSE replay buffer | `exec_events:{exec_id}` | exec lifetime + 5 min |
| Replay live events | `replay_events:{sandbox_id}` | sandbox lifetime + 10 min |
| Idempotency cache | `idem:{key}` | 24h |

### Files to create/modify

- `apps/api/src/services/scheduler.ts`:
  - `schedule(orgId: string, profile: string) -> { nodeId, slot }` or throws NoCapacity
  - Query online nodes with compatible profiles
  - Try to acquire slot lease on each candidate node
  - Redis SETNX for atomic slot reservation
  - If all nodes full: check queue_timeout, enqueue or reject
  - Renew slot lease periodically while sandbox is active

- `apps/api/src/services/redis.ts` — Redis utility layer:
  - `acquireSlotLease(nodeId, slot, sandboxId, ttl) -> boolean`
  - `releaseSlotLease(nodeId, slot)`
  - `renewSlotLease(nodeId, slot, ttl)`
  - `checkRateLimit(orgId, category, limit) -> { allowed, remaining, resetAt }`
  - `pushExecEvent(execId, event, ttl)`
  - `getExecEvents(execId, afterSeq) -> events[]`
  - `pushReplayEvent(sandboxId, event, ttl)`
  - `getReplayEvents(sandboxId) -> events[]`

- Update `apps/api/src/middleware/rate-limit.ts` to use the Redis functions

### Acceptance criteria

- Scheduler selects nodes with available capacity
- Slot leases are atomic (two concurrent creates don't get the same slot)
- Rate limiting correctly counts and rejects
- SSE event buffers work (push + read with sequence support)
- All Redis key patterns match the spec

### Learnings
<!-- Filled in after completion -->

---

## Task 13: Implement exec endpoints with sync, async, and SSE streaming

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: implement exec endpoints with sync, async, and SSE streaming`

### What to build

Implement all exec-related endpoints: execute a command (sync + async), get exec status, list execs, and stream exec output via Server-Sent Events.

### Context

Reference `docs/spec/02-api-contract.md` → "Exec", "Get exec", "List execs", and "Stream exec output" sections. Exec is the core interaction model — every sandbox operation goes through exec. This task depends on Task 11 (sandbox CRUD + node client exist) and Task 12 (Redis utility layer — `pushExecEvent` and `getExecEvents` are required for SSE event buffering and `Last-Event-ID` reconnection).

### Endpoints to implement

1. **`POST /v1/sandboxes/{id}/exec`** — Execute command
   - Verify sandbox is running (409 if not)
   - Route to node daemon via gRPC client
   - Sync mode (`wait: true`, default): block until done, return result with stdout/stderr
   - Async mode (`wait: false`): return exec_id immediately with status `running`
   - Insert exec row in DB
   - `wait: true` with `timeout_seconds > 300` → 400 Bad Request

2. **`GET /v1/sandboxes/{id}/exec/{exec_id}`** — Get exec status
   - Return full exec object with status, exit_code, duration_ms, resource_usage

3. **`GET /v1/sandboxes/{id}/execs`** — List execs
   - Filterable by: status, session_id
   - Cursor-based pagination

4. **`GET /v1/sandboxes/{id}/exec/{exec_id}/stream`** — SSE stream
   - Server-Sent Events for real-time stdout/stderr output
   - Support `Last-Event-ID` header for reconnection
   - Events buffered in Redis (`exec_events:{exec_id}`, TTL: exec lifetime + 5 min) via `pushExecEvent`/`getExecEvents` from Task 12
   - Final event: exit with code, duration, resource usage

### Files to create/modify

- `apps/api/src/routes/exec.ts` — Exec routes (create, get, list, stream)
- `apps/api/src/services/exec.ts` — Exec orchestration:
  - `execCommand(orgId, sandboxId, options)` — validate, route to node, handle sync/async
  - `getExec(orgId, sandboxId, execId)` — lookup
  - `listExecs(orgId, sandboxId, filters, cursor, limit)` — paginated query
  - `streamExec(sandboxId, execId, lastEventId?)` — SSE event stream using `getExecEvents` from Task 12's `redis.ts`
- Update `apps/api/src/services/node-client.ts`:
  - Use `nodeRpc.*` types for all gRPC request/response types (namespaced imports from `@sandchest/contract`)
  - Add `exec(nodeId, sandboxId, request)` — send Exec RPC, stream output back

### Key details

- Stdout/stderr truncated at 1 MB in sync mode; full output via stream endpoint
- SSE format: `data: {"seq":1,"t":"stdout","data":"..."}\n\n`
- Exit event: `data: {"seq":N,"t":"exit","code":0,"duration_ms":3200,"resource_usage":{...}}\n\n`
- Exec status values: `queued → running → done` (or `failed` / `timed_out`)
- Exec row in DB tracks: cmd, cmd_format, cwd, env, status, exit_code, resource usage, timestamps

### Acceptance criteria

- Sync exec blocks until done and returns stdout/stderr/exit_code
- Async exec returns immediately with exec_id
- SSE streaming produces valid Server-Sent Events with sequential `seq` numbers
- `Last-Event-ID` reconnection works (picks up where the client left off)
- Exec status transitions are correct (queued → running → done/failed/timed_out)
- List execs supports filtering by status and session_id
- `npx tsc --noEmit` passes

### Learnings
<!-- Filled in after completion -->

---

## Task 14: Implement session and file endpoints

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: implement session and file operation endpoints on control plane`

### What to build

Implement all session endpoints (create, exec, input, stream, list, destroy) and all file endpoints (upload, upload batch, download, list, delete).

### Context

Reference `docs/spec/02-api-contract.md` → "Sessions (stateful shell)" and "Files" sections. Sessions provide persistent shell environments where commands share state. File operations transfer files between the client and the sandbox filesystem. This task depends on Task 11 (sandbox service + node client) and Task 13 (exec patterns, since session exec is similar).

### Session endpoints to implement

1. **`POST /v1/sandboxes/{id}/sessions`** — Create session
   - Max 5 concurrent sessions per sandbox (409 if exceeded)
   - Optional: shell (default `/bin/bash`), env
   - Insert sandbox_sessions row in DB
   - Return 201 with session_id

2. **`POST /v1/sandboxes/{id}/sessions/{session_id}/exec`** — Session exec
   - `cmd`: string only (not array) — runs inside session shell
   - One command at a time per session (concurrent exec → 409 Conflict)
   - Same `wait` semantics as sandbox exec

3. **`POST /v1/sandboxes/{id}/sessions/{session_id}/input`** — Session input
   - Raw stdin write to session shell
   - Request: `{ "data": "console.log('hello')\n" }`

4. **`GET /v1/sandboxes/{id}/sessions/{session_id}/stream`** — Session output stream (SSE)
   - Same format as exec streaming

5. **`GET /v1/sandboxes/{id}/sessions`** — List sessions

6. **`DELETE /v1/sandboxes/{id}/sessions/{session_id}`** — Destroy session

### File endpoints to implement

1. **`PUT /v1/sandboxes/{id}/files?path=/work/input.zip`** — Upload single file
   - Stream body, max 5 GB, `Content-Length` required

2. **`PUT /v1/sandboxes/{id}/files?path=/work&batch=true`** — Upload tarball
   - `Content-Type: application/x-tar`, max 10 GB, extracted to path

3. **`GET /v1/sandboxes/{id}/files?path=/work/output.zip`** — Download single file

4. **`GET /v1/sandboxes/{id}/files?path=/work&list=true`** — Directory listing
   - Cursor-based pagination (max 200)

5. **`DELETE /v1/sandboxes/{id}/files?path=/work/temp`** — Delete file/directory (recursive)

### Files to create/modify

- `apps/api/src/routes/sessions.ts` — Session routes (create, exec, input, stream, list, destroy)
- `apps/api/src/routes/files.ts` — File routes (upload, upload batch, download, list, delete)
- `apps/api/src/services/session.ts` — Session orchestration:
  - `createSession(orgId, sandboxId, options)` — validate, enforce max 5, route to node
  - `sessionExec(orgId, sandboxId, sessionId, options)` — route to node, handle sync/async
  - `sessionInput(orgId, sandboxId, sessionId, data)` — raw stdin forwarding
  - `destroySession(orgId, sandboxId, sessionId)` — route to node, update DB
  - `listSessions(orgId, sandboxId)` — query sandbox_sessions table
- Update `apps/api/src/services/node-client.ts`:
  - Use `nodeRpc.*` types for all gRPC request/response types (namespaced imports from `@sandchest/contract`)
  - Add `createSession(nodeId, sandboxId, request)` — send CreateSession RPC
  - Add `sessionExec(nodeId, sessionId, request)` — send SessionExec RPC
  - Add `sessionInput(nodeId, sessionId, request)` — send SessionInput RPC
  - Add `destroySession(nodeId, sessionId)` — send DestroySession RPC
  - Add `putFile(nodeId, sandboxId, chunks)` — send PutFile streaming RPC
  - Add `getFile(nodeId, sandboxId, path)` — send GetFile RPC, stream response
  - Add `listFiles(nodeId, sandboxId, path)` — send ListFiles RPC

### Key details

- Session concurrent exec enforcement: check if another exec is in-progress for the session → 409
- Session exec `cmd` is always a string (shell-interpreted), never an array
- File upload streams the raw request body to the node (no JSON wrapping)
- File download streams the raw response body from the node
- All operations require sandbox to be in `running` status (409 if not)

### Acceptance criteria

- Session create/exec/input/stream/list/destroy all work
- Max 5 concurrent sessions enforced (409 on 6th)
- Concurrent session exec returns 409
- File upload/download round-trips correctly
- Batch tar upload extracts to the specified path
- Directory listing returns correct entries with pagination
- File delete works recursively
- `npx tsc --noEmit` passes

### Learnings
<!-- Filled in after completion -->

---

## Task 15: Implement event recording to object storage

- [ ] **Status**: Pending
- **Commit type**: `feat`
- **Commit message**: `feat: implement append-only event recording to S3-compatible object storage`

### What to build

Implement the event recording system that writes sandbox events to an append-only log in S3-compatible object storage (Scaleway Object Storage).

### Context

Reference `docs/spec/04-session-replay.md` → "Event model" and "Event log management".

Every action in a sandbox produces an event. Events are written in two paths simultaneously:
1. **Object storage** (durable): Append to `events.jsonl` in batches
2. **Redis** (ephemeral): Push for live replay and SSE streaming

**Storage path**: `s3://sandchest-events/{org_id}/{sandbox_id}/events.jsonl`

**Event format** (JSON lines):
```json
{"ts":"2026-02-19T12:00:00.000Z","seq":1,"type":"sandbox.created","data":{...}}
```

**Exec output stored separately**: `s3://sandchest-events/{org_id}/{sandbox_id}/exec/{exec_id}.log`

**Batching**: Buffer in memory, flush to object storage every 5 seconds or when buffer exceeds 64 KB.

### Files to create/modify

- `apps/api/src/services/object-storage.ts` — S3 client wrapper:
  - Configure for Scaleway Object Storage (S3-compatible)
  - `appendEvents(orgId, sandboxId, events: Event[])` — Append to events.jsonl
  - `writeExecOutput(orgId, sandboxId, execId, events: ExecOutputEvent[])` — Write exec log
  - `readEvents(orgId, sandboxId) -> Event[]` — Read full event log
  - `readExecOutput(orgId, sandboxId, execId) -> ExecOutputEvent[]`
  - `generatePresignedUrl(key, ttl) -> string` — For artifact downloads

- `apps/api/src/services/event-recorder.ts`:
  - `EventRecorder` class — per-sandbox event buffer
  - `record(sandboxId, event)` — Add to buffer + push to Redis
  - `flush(sandboxId)` — Write buffered events to object storage
  - Automatic flush: timer (5s) or buffer size (64 KB)
  - `finalize(sandboxId)` — Final flush on sandbox stop (ensures all events are written)

- `apps/api/src/services/events.ts` — Event type definitions:
  - All event types from `docs/spec/04-session-replay.md` → "Event types" table
  - `sandbox.created`, `sandbox.ready`, `sandbox.forked`, `sandbox.stopping`, `sandbox.stopped`, `sandbox.failed`
  - `exec.started`, `exec.output`, `exec.completed`, `exec.failed`
  - `session.created`, `session.destroyed`
  - `file.written`, `file.deleted`
  - `artifact.registered`, `artifact.collected`

### Acceptance criteria

- Events are written to object storage in JSONL format
- Batching works (events accumulate, flush on timer or size)
- Exec output is stored in separate files per exec
- Redis gets events in real-time (for live replay)
- Event format matches the spec exactly
- Finalize ensures no events are lost

### Learnings
<!-- Filled in after completion -->

---

## Task 16: E2E integration test — create, exec, session, file, stop

- [ ] **Status**: Pending
- **Commit type**: `test`
- **Commit message**: `test: add end-to-end integration test for sandbox create, exec, session, file, and stop`
<!-- Note: Previously Task 14. Renumbered after splitting the original Task 11. -->

### What to build

Write an end-to-end test that exercises the full stack: HTTP API → Control Plane → Node Daemon → Guest Agent → back. This proves the entire system works together.

**Important**: The SDK is not wired up to make real HTTP calls until Phase 4. These E2E tests use raw `fetch` calls against the control plane REST API directly (referencing `docs/spec/02-api-contract.md` for endpoints and shapes). A thin test helper wraps fetch for convenience.

### Context

Reference `docs/spec/11-milestones.md` → Milestone 1 acceptance criteria:
- Create a sandbox and run `echo "hello"` → get "hello" back through the API
- Session workflow: create session → `cd /tmp` → `pwd` returns `/tmp`
- File upload → download round-trip
- Exec streaming works (SSE events arrive in real-time)
- Cold boot time < 5s, snapshot restore < 2s
- Sandbox stops gracefully and slot is released

### Files to create

- `tests/e2e/helpers.ts` — Thin HTTP test helper (raw `fetch`, NOT the SDK):
  ```typescript
  const BASE_URL = process.env.SANDCHEST_API_URL || 'http://localhost:3000'
  const API_KEY = process.env.SANDCHEST_API_KEY!

  export async function apiPost(path: string, body?: unknown) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, data: await res.json() }
  }

  export async function apiGet(path: string) {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    })
    return { status: res.status, data: await res.json() }
  }

  export async function apiPut(path: string, body: Buffer | string, contentType = 'application/octet-stream') { ... }
  export async function apiDelete(path: string) { ... }

  export async function waitForStatus(sandboxId: string, status: string, timeoutMs = 30_000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const { data } = await apiGet(`/v1/sandboxes/${sandboxId}`)
      if (data.status === status) return data
      if (data.status === 'failed') throw new Error(`Sandbox failed: ${data.failure_reason}`)
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error(`Timeout waiting for status ${status}`)
  }
  ```

- `tests/e2e/basic-workflow.test.ts`:
  ```typescript
  import { apiPost, apiGet, apiPut, apiDelete, waitForStatus } from './helpers'

  // 1. Create sandbox
  const { data: created } = await apiPost('/v1/sandboxes', { image: 'sandchest://ubuntu-22.04/base' })
  expect(created.status).toMatch(/queued|provisioning|running/)
  const sandbox = await waitForStatus(created.sandbox_id, 'running')
  expect(sandbox.replay_url).toContain('sandchest.com/s/')
  const sandboxId = created.sandbox_id

  // 2. Simple exec
  const { data: result } = await apiPost(`/v1/sandboxes/${sandboxId}/exec`, { cmd: 'echo "hello"', wait: true })
  expect(result.exit_code).toBe(0)
  expect(result.stdout.trim()).toBe('hello')

  // 3. Session workflow
  const { data: sess } = await apiPost(`/v1/sandboxes/${sandboxId}/sessions`)
  const sessionId = sess.session_id
  const { data: r1 } = await apiPost(`/v1/sandboxes/${sandboxId}/sessions/${sessionId}/exec`, { cmd: 'cd /tmp', wait: true })
  expect(r1.exit_code).toBe(0)
  const { data: r2 } = await apiPost(`/v1/sandboxes/${sandboxId}/sessions/${sessionId}/exec`, { cmd: 'pwd', wait: true })
  expect(r2.stdout.trim()).toBe('/tmp')
  await apiDelete(`/v1/sandboxes/${sandboxId}/sessions/${sessionId}`)

  // 4. File round-trip
  await apiPut(`/v1/sandboxes/${sandboxId}/files?path=/tmp/test.txt`, Buffer.from('test content'))
  const downloaded = await apiGet(`/v1/sandboxes/${sandboxId}/files?path=/tmp/test.txt`)
  // verify content matches

  // 5. Exec with non-zero exit
  const { data: fail } = await apiPost(`/v1/sandboxes/${sandboxId}/exec`, { cmd: 'exit 42', wait: true })
  expect(fail.exit_code).toBe(42)

  // 6. Stop sandbox
  await apiPost(`/v1/sandboxes/${sandboxId}/stop`)
  const stopped = await waitForStatus(sandboxId, 'stopped')
  expect(stopped.status).toBe('stopped')
  ```

- `tests/e2e/setup.ts` — Test setup:
  - Validate `SANDCHEST_API_KEY` and `SANDCHEST_API_URL` env vars
  - Cleanup: destroy any sandboxes created during test (via `DELETE /v1/sandboxes/{id}`)

- `tests/e2e/bunfig.toml` — Bun test config for E2E tests (project uses `bun test`, not vitest):
  ```toml
  [test]
  timeout = 60000     # sandbox creation takes seconds
  preload = ["./setup.ts"]
  ```
  - Longer timeouts (sandbox creation takes seconds)
  - Sequential execution (shared infrastructure)
  - Use `bun test tests/e2e/` to run

### Acceptance criteria

- Test passes against a running local stack (control plane + node + agent)
- All 6 scenarios work
- Tests use raw HTTP calls (no SDK dependency — SDK is wired up in Phase 4)
- Tests use `bun test` (not vitest) — import from `bun:test` for `describe`/`test`/`expect`
- Test cleans up after itself (no orphaned sandboxes)
- Test can be run from CI (with appropriate infrastructure)

### Learnings
<!-- Filled in after completion -->
