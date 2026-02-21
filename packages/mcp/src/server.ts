import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Sandchest } from '@sandchest/sdk'
import { registerTools } from './tools.js'

const AGENT_INSTRUCTIONS = `You have access to Sandchest — a sandbox platform that gives you isolated Linux environments to run code. Key capabilities:

SANDBOX BASICS:
- sandbox_create: Creates a fresh Linux environment (Firecracker microVM)
- sandbox_exec: Runs a command and returns output
- sandbox_session_create + sandbox_session_exec: For multi-step workflows where commands share state (cd, env vars persist between commands)

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
1. Create sandbox
2. Use a session for setup (git clone, install deps)
3. Fork before risky operations
4. Try approach in fork
5. If fork fails → destroy fork, try different approach in original
6. If fork succeeds → continue in fork (or destroy original)

REPLAY:
- Every sandbox has a replay URL showing everything that happened
- Share replay URLs for debugging, code review, or documentation
- The URL is always in the sandbox_create response`

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
