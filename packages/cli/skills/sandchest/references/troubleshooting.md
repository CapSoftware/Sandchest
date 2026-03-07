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
- Prefer `sandbox_git_clone` for public repos.
- Narrow the upload scope.
- Exclude generated directories and dependency folders.

## Directory Upload Failed On Extraction

Bulk upload is not transactional. Partial files may remain.

Fixes:
- Fork before bulk upload.
- Destroy the failed fork and retry from the checkpoint.
- Check whether the archive contains links or unsupported entry types.

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
