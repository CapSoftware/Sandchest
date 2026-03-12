---
name: sandchest
description: >
  Sandchest sandbox platform for AI agent code execution. Load when you need to
  run code in isolation, test in a clean environment, execute untrusted code,
  build or test a project without polluting the local machine, or try risky
  changes safely. Trigger phrases: "run in sandbox", "test in isolation",
  "safe environment", "sandchest", "sandbox", "microVM", "try this safely",
  "fork and test".
license: MIT
metadata:
  author: sandchest
  version: "1.0.0"
  organization: Sandchest
---

# Sandchest

Use this skill when code should run inside an isolated Linux sandbox instead of on the local machine.

## 1. When To Use A Sandbox

Use a sandbox when:
- The code is untrusted or unknown.
- The task installs packages, runs build tools, or executes shell commands.
- You need a clean Linux environment.
- The workflow is destructive or uncertain and you want a rollback point.
- You want a replay URL or a clean handoff artifact.

Stay local when:
- You are only reading files or making simple edits.
- The task depends on local services, hardware, GUI apps, or host-only credentials.
- No code execution is needed.

Rule of thumb: if it runs code or installs dependencies, sandbox it.

## 2. Setup Recipe

IMPORTANT: Follow this decision tree exactly. Do NOT skip steps or improvise.

### Step 1 — Check for reusable sandbox

Call `sandbox_list` first. If a running sandbox already has the code you need, fork it with `sandbox_fork` and skip to Step 5. This is instant and avoids redundant setup.

### Step 2 — Create sandbox

```text
sandbox_create({ profile: "small" })
```

Only `sandchest://ubuntu-22.04/base` is available. Do not request other images.

### Step 3 — Load code (pick ONE)

| Situation | Tool | Example |
|-----------|------|---------|
| Public repo | `sandbox_git_clone` (preferred) | `sandbox_git_clone({ url: "https://github.com/org/repo", depth: 1 })` |
| Private repo or local-only | `sandbox_upload_dir` | `sandbox_upload_dir({ local_path: "/path/to/project" })` |

NEVER manually tar, base64-encode, split, or chunk files. The tools handle archiving automatically.

If you need git clone AND the sandbox has no network, fall back to `sandbox_upload_dir`.

### Step 4 — Install toolchains and dependencies

Use a session so state persists between commands:

```text
sandbox_session_create({ sandbox_id })
sandbox_session_exec({ cmd: "curl -fsSL https://bun.sh/install | bash" })
sandbox_session_exec({ cmd: "source /root/.bashrc && cd /tmp/work && bun install" })
```

Common toolchain installs:
- Bun: `curl -fsSL https://bun.sh/install | bash && source /root/.bashrc`
- Node.js: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs`
- Python: `apt-get install -y python3.12 python3.12-venv`

### Step 5 — Fork checkpoint

After setup, fork to create a reusable checkpoint:

```text
sandbox_fork({ sandbox_id })  // Keep original as base
```

Do your work in the fork. If anything goes wrong, destroy the fork and create a new one from the original.

### Baseline git (upload_dir only)

If you uploaded local code and want diff workflows, initialize a baseline repo:

```text
git init && git add -A && git -c user.name=Sandchest -c user.email=sandchest@local commit -m "baseline"
```

## 3. Workspace Paths

- `/tmp/work` — recommended workspace (default for uploads, exec cwd, diff, apply_patch)
- `/tmp` and `/var/tmp` — writable scratch space

The root filesystem is **read-only** (including `/work`, `/root`, `/home`). Always use `/tmp/work` as your working directory. Tools default to `/tmp/work`.

## 4. Fork Patterns

Fork before risky work. The main patterns are:
- Checkpoint pattern: fork after clone or install so failures can be discarded.
- Sequential A/B: fork, try one approach, destroy it if it fails, then fork again from the checkpoint.
- Safe experimentation: fork before `rm`, rewrites, migrations, or bulk file operations.

Forking is checkpointing, not parallel execution. Within one agent turn, treat forks as branches you switch between, not concurrent workers.

Read [references/fork-patterns.md](references/fork-patterns.md) for the detailed workflows.

## 5. Results Extraction

Use these outputs in order of fidelity:
- `sandbox_diff` with `mode: "review"` to inspect tracked changes.
- `sandbox_diff` with `mode: "patch"` to export a round-trippable patch.
- `sandbox_download_dir` to pull modified files or a whole workspace.
- `sandbox_apply_patch` to reapply a patch in another sandbox.
- `sandbox_download` for one-off files.

If a patch is too large or the repo is not initialized, fall back to directory download.

## 6. Sandbox Reuse

- **Always check `sandbox_list` before creating a new sandbox.** Reuse beats recreate.
- Fork from a prepared sandbox instead of recreating everything.
- Use sessions for multi-step setup so shell state persists.
- Destroy sandboxes when done. Replay URLs persist, files do not.

## 7. Image Selection Quick Reference

| Image | Use for |
|-------|---------|
| `sandchest://ubuntu-22.04/base` | General Linux work and custom setup |

Note: Node, Bun, Python, and Go toolchain images are listed in docs but must be provisioned per-node. Default to the base image and install toolchains manually.

See [references/image-selection.md](references/image-selection.md) for the full guide.

## 8. Common Patterns

Incorrect:

```text
sandbox_exec({ cmd: "git clone https://user:TOKEN@github.com/org/repo" })
```

Correct:

```text
sandbox_git_clone({ url: "https://github.com/org/repo", depth: 1 })
```

Incorrect — manually uploading, tarring, or base64-encoding files:

```text
git archive ... | base64 | sandbox_upload(...)
```

Correct:

```text
sandbox_upload_dir({ local_path: "/path/to/project" })  // defaults to /tmp/work
```

Incorrect — setting up from scratch every time:

```text
sandbox_create -> git_clone -> install deps -> run task -> destroy
sandbox_create -> git_clone -> install deps -> run task -> destroy  // again!
```

Correct — fork-based reuse:

```text
sandbox_create -> git_clone -> install deps -> fork (checkpoint)
fork checkpoint -> run task 1 -> extract results -> destroy fork
fork checkpoint -> run task 2 -> extract results -> destroy fork
```

## 9. Current Limitations

- No preview URLs. A web server can run, but you cannot open it from outside the sandbox yet.
- No GPU access.
- Filesystem state is ephemeral. Extract results before stop or destroy.
- Sandboxes can idle-stop or hit TTL limits. Check status before reusing one.
- Env vars are set at create or fork time, not updated globally on a running sandbox.
- Sandboxes are Linux only.
- Compound helpers assume the official image baseline includes `git`, `tar`, and `python3`. If an image is missing them, upload, download, and replace helpers may be unavailable.

## References

- [references/fork-patterns.md](references/fork-patterns.md): checkpoint workflows, branch strategies, and when to destroy or keep forks.
- [references/image-selection.md](references/image-selection.md): image catalog and selection guidance.
- [references/troubleshooting.md](references/troubleshooting.md): common failures and the preferred recovery path.
