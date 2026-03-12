# Troubleshooting

## Branch Not Found After Clone

Sandchest clone helpers default to single-branch clone behavior.

Fixes:
- Pass `branch` during clone if you know the branch name.
- Disable single-branch mode if you need more than one branch.
- Run `git fetch origin <branch>` after clone if needed.

## Command Timed Out

Common causes:
- Dependency install taking too long
- Interactive prompt waiting for input
- Large test or build step

Fixes:
- Prefer `sandbox_run_project` for one-shot "new sandbox + run command" tasks so setup, install, and execution are handled together.
- Increase the timeout on the command or helper.
- Set non-interactive env vars where appropriate.
- Use `GIT_TERMINAL_PROMPT=0` style protections for git workflows.
- Switch to a session if the workflow is multi-step.

## Sandbox Not Running

The sandbox may have idle-stopped or hit TTL.

Fixes:
- Check `sandbox_list` or sandbox status first.
- Recreate or fork from a still-running checkpoint if needed.

## Upload Too Large

Fixes:
- Prefer `sandbox_run_project` in `source: "auto"` mode for a one-shot task. It can fall back from upload to clone automatically when a public origin is available.
- Prefer `sandbox_git_clone` for public repos.
- Narrow the upload scope.
- Exclude generated directories and dependency folders.

## Writable Paths

The sandbox root filesystem uses an overlay mount. The guest agent runs with
ProtectSystem=strict, with explicit ReadWritePaths for user-writable directories.

Writable directories:
- `/tmp/work` (recommended default workspace for MCP uploads, clones, exec, and sessions)
- `/root` (root user home)
- `/tmp` and `/var/tmp` (ephemeral scratch space)
- `/home` (user home directories)

Use `/tmp/work` as the default destination unless you know the target image exposes `/work`.

## Image Availability

Only `sandchest://ubuntu-22.04/base` is currently available. Do not request
node-22, bun, python-3.12, or go-1.22 images unless they have been explicitly
provisioned on the target node.

Install toolchains manually in the base image:
- Node.js: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs`
- Bun: `curl -fsSL https://bun.sh/install | bash && export PATH="/root/.bun/bin:$PATH"`
- Python 3.12: `apt-get install -y python3.12 python3.12-venv`

## Directory Upload Failed On Extraction

Bulk upload is not transactional. Partial files may remain.

Fixes:
- Fork before bulk upload.
- Destroy the failed fork and retry from the checkpoint.
- Check whether the archive contains links or unsupported entry types.

## Upload Dir Fails With Symlinks

The sandbox_upload_dir tool filters out directory symlinks and broken symlinks
automatically for git repos. If you still get symlink errors:

Fixes:
- Ensure the MCP server dist is rebuilt and the process is restarted.
- Use the exclude parameter to skip problematic paths.
- For public repos, prefer sandbox_git_clone over sandbox_upload_dir.

## Sandbox Has No Network

If sandbox_git_clone or package install commands fail with network errors:

Possible causes:
- NAT/iptables rules not applied on the host node.
- Outbound interface mismatch (SANDCHEST_OUTBOUND_IFACE).
- DNS resolution failure.

Workarounds:
- Prefer `sandbox_run_project` with `local_path` if the code is already on the local machine.
- Use sandbox_upload_dir to transfer code locally instead of cloning.
- Upload pre-built dependencies via sandbox_upload.

## Private Repo Clone Not Supported Yet

Sandchest does not yet support safe server-side credential injection for clone helpers.

Use one of these instead:
- Clone a public repo directly.
- Stage local code with `sandbox_upload_dir`.
- Wait for first-party private clone support.

Do not embed credentials in the clone URL.

## Patch Or Diff Workflow Not Working

Common causes:
- The uploaded directory was never initialized as a git repo.
- The diff is too large for patch export.
- The patch references paths outside the requested scope.

Fixes:
- Initialize a baseline repo after upload if you need diff workflows.
- Use `sandbox_diff` review mode for inspection.
- Use `sandbox_download_dir` when the patch is too large.

## Fork Failed

Check:
- Whether the source sandbox is still running
- Whether the sandbox has become invalid after a failed workflow
- Whether you can restart from an earlier checkpoint
