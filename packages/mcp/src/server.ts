import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Sandchest } from '@sandchest/sdk'
import { registerTools } from './tools.js'

const AGENT_INSTRUCTIONS = `You have access to Sandchest — a sandbox platform that gives you isolated Linux environments to run code. Key capabilities:

SANDBOX BASICS:
- sandbox_create: Creates a fresh Linux environment (Firecracker microVM)
- sandbox_exec: Runs a command and returns output
- sandbox_session_create + sandbox_session_exec: For multi-step workflows where commands share state (cd, env vars persist between commands)
- sandbox_session_destroy: Clean up sessions you no longer need
- sandbox_stop: Gracefully stop a sandbox (collects artifacts, flushes logs)
- sandbox_destroy: Permanently delete a sandbox (immediate, non-recoverable)

FILES & ARTIFACTS:
- sandbox_upload / sandbox_download: Transfer individual files to/from a sandbox
- sandbox_upload_dir / sandbox_download_dir: Transfer whole directories as tar.gz archives
- sandbox_file_list: Browse the sandbox filesystem (list directory contents)
- sandbox_artifacts_list: List registered build outputs, test reports, etc. with download URLs
- sandbox_diff: Review tracked changes or export a patch-safe diff from a git repo
- sandbox_apply_patch: Apply a unified diff inside a sandbox git repo

GIT SETUP:
- sandbox_git_clone: Clone a git repository into a sandbox without opening a shell session first

LOADING CODE — DECISION TREE (follow in order):
1. Check sandbox_list first — if a running sandbox already has the code, fork it instead of starting over
2. Public repo → use sandbox_git_clone (fastest, preferred, clones inside sandbox with --depth 1)
3. Private repo or local-only code → use sandbox_upload_dir (respects .gitignore, only sends tracked files)
4. NEVER manually tar, base64-encode, or chunk files — the tools handle this automatically

WORKSPACE:
- /work is the default writable workspace for uploads and clones
- Other writable paths: /root, /tmp, /var/tmp, /home
- Do NOT use paths outside these (root filesystem is read-only)
- All tools default to /work — you rarely need to specify a path

TOOLCHAIN SETUP:
- Only sandchest://ubuntu-22.04/base is currently available — install toolchains manually after clone:
  - Node.js: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
  - Bun: curl -fsSL https://bun.sh/install | bash && source /root/.bashrc
  - Python: apt-get install -y python3.12 python3.12-venv

DIFF WORKFLOW:
- If you uploaded local code instead of cloning a repo, initialize git first:
  git init && git add -A && git -c user.name=Sandchest -c user.email=sandchest@local commit -m "baseline"
- Use sandbox_diff with mode="review" for inspection
- Use sandbox_diff with mode="patch" when you need a round-trippable patch
- Apply exported patches with sandbox_apply_patch
- If the patch is too large, pull files out with a directory download workflow instead of truncating the diff

FORKING (your most powerful tool):
- sandbox_fork: Creates an instant copy of a sandbox's entire state
- Fork BEFORE:
  - Destructive operations (rm, overwrite, drop)
  - Approaches you're <80% confident about
  - When comparing two strategies
  - After expensive setup (git clone + install) as a checkpoint
- Fork is fast (<1 second) and the original is untouched
- When in doubt, fork first. It's always better to fork and throw away than to break your working environment.

WORKFLOW PATTERN:
1. Check sandbox_list for a reusable running sandbox
2. If found → sandbox_fork from it (instant, skip to step 5)
3. If not → sandbox_create, then load code (git_clone or upload_dir), install deps in a session
4. sandbox_fork to create a checkpoint (keep original as reusable base)
5. Do your work in the fork
6. If fork fails → destroy fork, fork from checkpoint again
7. Extract results (diff, download, artifacts) before destroying

REPO-SPECIFIC GUIDANCE:
- Load the sandchest skill if it is available when the task is about sandboxed execution workflows
- The skill covers when to sandbox, setup recipes, checkpoint and fork patterns, results extraction, image selection, and troubleshooting
- Do not duplicate the skill content in your own notes; use it as the workflow guide

REPLAY:
- sandbox_replay: Get the permanent replay URL for any sandbox
- Every sandbox has a replay URL showing everything that happened
- Share replay URLs for debugging, code review, or documentation`

export function createServer(sandchest: Sandchest): McpServer {
  const server = new McpServer(
    { name: 'sandchest', version: '0.0.1' },
    {
      capabilities: { tools: {} },
      instructions: AGENT_INSTRUCTIONS,
    },
  )

  registerTools(server, sandchest)

  return server
}
