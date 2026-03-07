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

1. Create a sandbox with `sandbox_create`.
2. Choose an image using [references/image-selection.md](references/image-selection.md).
3. Load code with `sandbox_git_clone` for public git repos, or `sandbox_upload_dir` for local code.
4. Install dependencies with `sandbox_session_create` plus `sandbox_session_exec`.
5. Fork after setup so you have a clean checkpoint before experiments.

If you uploaded local code and you want diff workflows, initialize a baseline repo first:

```text
git init
git add -A
git -c user.name=Sandchest -c user.email=sandchest@local commit -m "baseline"
```

## 3. Fork Patterns

Fork before risky work. The main patterns are:
- Checkpoint pattern: fork after clone or install so failures can be discarded.
- Sequential A/B: fork, try one approach, destroy it if it fails, then fork again from the checkpoint.
- Safe experimentation: fork before `rm`, rewrites, migrations, or bulk file operations.

Forking is checkpointing, not parallel execution. Within one agent turn, treat forks as branches you switch between, not concurrent workers.

Read [references/fork-patterns.md](references/fork-patterns.md) for the detailed workflows.

## 4. Results Extraction

Use these outputs in order of fidelity:
- `sandbox_diff` with `mode: "review"` to inspect tracked changes.
- `sandbox_diff` with `mode: "patch"` to export a round-trippable patch.
- `sandbox_download_dir` to pull modified files or a whole workspace.
- `sandbox_apply_patch` to reapply a patch in another sandbox.
- `sandbox_download` for one-off files.

If a patch is too large or the repo is not initialized, fall back to directory download.

## 5. Sandbox Reuse

- Reuse running sandboxes for related tasks. Check `sandbox_list` first.
- Use sessions for multi-step setup so shell state persists.
- Fork from a prepared sandbox instead of recreating everything.
- Destroy sandboxes when done. Replay URLs persist, files do not.

## 6. Image Selection Quick Reference

| Image | Use for |
|-------|---------|
| `sandchest://ubuntu-22.04/base` | General Linux work and custom setup |
| `sandchest://ubuntu-22.04/node-22` | Node.js, Bun, TypeScript, frontend repos |
| `sandchest://ubuntu-22.04/python-3.12` | Python projects |
| `sandchest://ubuntu-24.04/base` | Newer Ubuntu userland |

See [references/image-selection.md](references/image-selection.md) for the full guide.

## 7. Common Patterns

Incorrect:

```text
sandbox_exec({ cmd: "git clone https://user:TOKEN@github.com/org/repo" })
```

Correct:

```text
sandbox_git_clone({ url: "https://github.com/org/repo" })
```

Incorrect:

```text
sandbox_exec({ cmd: "npm install && npm run build" })
sandbox_exec({ cmd: "rm -rf dist && npm run build:esm" })
```

Correct:

```text
create sandbox
clone or upload code
install deps
sandbox_fork() -> checkpoint
run experiment in fork
if it fails: destroy fork, fork checkpoint again
```

## 8. Current Limitations

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
