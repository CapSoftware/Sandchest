import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Sandchest } from '@sandchest/sdk'
import { Session } from '@sandchest/sdk'

function jsonContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

export function registerTools(server: McpServer, sandchest: Sandchest): void {
  server.registerTool('sandbox_create', {
    description:
      "Create a new isolated Linux sandbox (Firecracker microVM). Use this when you need a clean environment to run commands, install packages, clone repos, run tests, or execute any code safely. The sandbox is fully isolated — nothing you do affects the host. Returns a sandbox_id for use with other tools. The sandbox is ready to use immediately.",
    inputSchema: {
      image: z
        .string()
        .optional()
        .describe(
          "Image URI. Default: 'sandchest://ubuntu-22.04/base'. Options: 'sandchest://ubuntu-22.04/node-22', 'sandchest://ubuntu-22.04/python-3.12', 'sandchest://ubuntu-24.04/base'.",
        ),
      profile: z
        .enum(['small', 'medium', 'large'])
        .optional()
        .describe('Resource profile. small=2vCPU/4GB, medium=4vCPU/8GB, large=8vCPU/16GB. Default: small.'),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe('Environment variables to set in the sandbox.'),
    },
  }, async (args) => {
    const sb = await sandchest.create({
      image: args.image,
      profile: args.profile,
      env: args.env,
    })
    return jsonContent({ sandbox_id: sb.id, replay_url: sb.replayUrl })
  })

  server.registerTool('sandbox_exec', {
    description:
      'Execute a command in a sandbox. Returns exit code, stdout, and stderr. Use this for running build commands, tests, scripts, or any shell command. Commands run as root with full access to the sandbox filesystem. For multi-step workflows where commands depend on each other (cd, exports), use sandbox_session_create + sandbox_session_exec instead.',
    inputSchema: {
      sandbox_id: z.string().describe('The sandbox to execute in.'),
      cmd: z.string().describe('The command to run. Interpreted by /bin/sh.'),
      cwd: z.string().optional().describe('Working directory. Default: /root'),
      timeout: z.number().optional().describe('Timeout in seconds. Default: 300'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const result = await sb.exec(args.cmd, {
      cwd: args.cwd,
      timeout: args.timeout,
    })
    return jsonContent({
      exec_id: result.execId,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.durationMs,
    })
  })

  server.registerTool('sandbox_session_create', {
    description:
      'Create a persistent shell session where commands share state. Use this when you need multiple commands that depend on each other — like cd into a directory, then npm install, then npm test. Each command inherits the working directory, environment variables, and other shell state from previous commands. Prefer this over sandbox_exec for multi-step workflows.',
    inputSchema: {
      sandbox_id: z.string(),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const session = await sb.session.create()
    return jsonContent({ session_id: session.id })
  })

  server.registerTool('sandbox_session_exec', {
    description:
      'Run a command in a persistent session. The command inherits all prior state (working directory, environment variables, aliases) from previous commands in this session. Returns exit code, stdout, and stderr.',
    inputSchema: {
      sandbox_id: z.string(),
      session_id: z.string(),
      cmd: z.string().describe('The command to run in the session shell.'),
      timeout: z.number().optional().describe('Timeout in seconds. Default: 300'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const session = new Session(args.session_id, args.sandbox_id, sb._http)
    const result = await session.exec(args.cmd, {
      timeout: args.timeout,
    })
    return jsonContent({
      exec_id: result.execId,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.durationMs,
    })
  })

  server.registerTool('sandbox_fork', {
    description:
      "Create an instant copy of a running sandbox (memory + filesystem + all state). The original sandbox is untouched. The fork is a new, independent sandbox.\n\nUSE THIS WHEN:\n- You want to try something risky or experimental (the original stays safe)\n- You want to compare two approaches side by side\n- You're about to run a destructive command (rm, overwrite files, drop tables)\n- You've completed expensive setup (git clone + npm install) and want a checkpoint\n- You're less than 80% confident in your next approach\n\nFork is cheap and fast (<1 second). When in doubt, fork first.",
    inputSchema: {
      sandbox_id: z.string().describe('The sandbox to fork.'),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe('Additional environment variables for the fork.'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const fork = await sb.fork({ env: args.env })
    return jsonContent({
      sandbox_id: fork.id,
      forked_from: sb.id,
      replay_url: fork.replayUrl,
    })
  })

  server.registerTool('sandbox_upload', {
    description:
      'Upload a file to a sandbox. Use this to place source code, configuration files, or test data into the sandbox filesystem.',
    inputSchema: {
      sandbox_id: z.string(),
      path: z.string().describe('Destination path in the sandbox (e.g., /work/config.json)'),
      content: z.string().describe('File content (text). For binary files, use base64 encoding.'),
      encoding: z
        .enum(['utf-8', 'base64'])
        .optional()
        .describe('Content encoding. Default: utf-8'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const encoding = args.encoding ?? 'utf-8'
    let bytes: Uint8Array
    if (encoding === 'base64') {
      bytes = Uint8Array.from(atob(args.content), (c) => c.charCodeAt(0))
    } else {
      bytes = new TextEncoder().encode(args.content)
    }
    await sb.fs.upload(args.path, bytes)
    return jsonContent({ ok: true })
  })

  server.registerTool('sandbox_download', {
    description:
      'Download a file from a sandbox. Use this to retrieve output files, build artifacts, or read generated content.',
    inputSchema: {
      sandbox_id: z.string(),
      path: z.string().describe('File path in the sandbox'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const bytes = await sb.fs.download(args.path)
    let content: string
    let encoding: string
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      content = text
      encoding = 'utf-8'
    } catch {
      content = btoa(String.fromCharCode(...bytes))
      encoding = 'base64'
    }
    return jsonContent({ content, encoding })
  })

  server.registerTool('sandbox_stop', {
    description:
      "Gracefully stop a sandbox. Collects any registered artifacts and flushes logs before shutdown. The sandbox's replay URL remains accessible after stopping.",
    inputSchema: {
      sandbox_id: z.string(),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    await sb.stop()
    return jsonContent({ ok: true, replay_url: sb.replayUrl })
  })

  server.registerTool('sandbox_list', {
    description: 'List your active sandboxes. Returns sandbox IDs, status, and replay URLs.',
    inputSchema: {
      status: z
        .enum(['running', 'stopped', 'failed'])
        .optional()
        .describe('Filter by status. Default: all.'),
    },
  }, async (args) => {
    const sandboxes = await sandchest.list({
      status: args.status,
    })
    return jsonContent({
      sandboxes: sandboxes.map((sb) => ({
        sandbox_id: sb.id,
        status: sb.status,
        replay_url: sb.replayUrl,
      })),
    })
  })

  server.registerTool('sandbox_destroy', {
    description:
      'Permanently destroy a sandbox and all its data. Unlike sandbox_stop (graceful shutdown), this is an immediate hard delete. The sandbox cannot be recovered. The replay URL will still be accessible. Use this to clean up sandboxes you no longer need.',
    inputSchema: {
      sandbox_id: z.string().describe('The sandbox to destroy.'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    await sb.destroy()
    return jsonContent({ ok: true, sandbox_id: sb.id })
  })

  server.registerTool('sandbox_artifacts_list', {
    description:
      'List all registered artifacts for a sandbox. Artifacts are files explicitly marked for collection (e.g., build outputs, test reports, coverage data). They persist after the sandbox is stopped and include download URLs.',
    inputSchema: {
      sandbox_id: z.string().describe('The sandbox to list artifacts for.'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const artifacts = await sb.artifacts.list()
    return jsonContent({
      artifacts: artifacts.map((a) => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        bytes: a.bytes,
        sha256: a.sha256,
        download_url: a.download_url,
        exec_id: a.exec_id,
        created_at: a.created_at,
      })),
    })
  })

  server.registerTool('sandbox_file_list', {
    description:
      'List files and directories at a path inside a sandbox. Returns names, types (file/directory), and sizes. Use this to explore the sandbox filesystem before downloading or modifying files.',
    inputSchema: {
      sandbox_id: z.string().describe('The sandbox to list files in.'),
      path: z.string().describe('Directory path to list (e.g., /root, /work).'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const entries = await sb.fs.ls(args.path)
    return jsonContent({
      entries: entries.map((e) => ({
        name: e.name,
        path: e.path,
        type: e.type,
        size_bytes: e.size_bytes,
      })),
    })
  })

  server.registerTool('sandbox_session_destroy', {
    description:
      'Destroy a persistent shell session. Use this to clean up sessions you no longer need. The sandbox itself is not affected.',
    inputSchema: {
      sandbox_id: z.string(),
      session_id: z.string().describe('The session to destroy.'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const session = new Session(args.session_id, args.sandbox_id, sb._http)
    await session.destroy()
    return jsonContent({ ok: true })
  })

  server.registerTool('sandbox_replay', {
    description:
      'Get the replay URL for a sandbox. The replay URL is a permanent link showing everything that happened in the sandbox — every command, output, and file change. Share it for debugging, code review, or documentation. Works for both running and stopped sandboxes.',
    inputSchema: {
      sandbox_id: z.string().describe('The sandbox to get the replay URL for.'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    return jsonContent({ sandbox_id: sb.id, replay_url: sb.replayUrl })
  })
}
