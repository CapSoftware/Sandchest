/**
 * Sandchest + Vercel AI SDK Integration
 *
 * Use Sandchest sandboxes as tools with the Vercel AI SDK, enabling AI models
 * to execute code in isolated Firecracker microVMs via generateText / streamText.
 *
 * Install:
 *   bun add @sandchest/sdk ai zod
 */
import { tool } from 'ai'
import { z } from 'zod'
import { Sandchest, type Sandbox } from '@sandchest/sdk'

/**
 * Creates a set of Vercel AI SDK tools backed by a Sandchest sandbox.
 */
export function createSandboxTools(sandbox: Sandbox) {
  return {
    executeCommand: tool({
      description:
        'Execute a shell command in an isolated Linux sandbox. Returns exit code, stdout, and stderr.',
      parameters: z.object({
        command: z.string().describe('The shell command to execute'),
        cwd: z.string().optional().describe('Working directory for the command'),
      }),
      execute: async ({ command, cwd }) => {
        const result = await sandbox.exec(command, {
          cwd: cwd ?? undefined,
        })
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        }
      },
    }),

    readFile: tool({
      description: 'Read a file from the sandbox filesystem. Returns file contents as text.',
      parameters: z.object({
        path: z.string().describe('Absolute path to the file'),
      }),
      execute: async ({ path }) => {
        const bytes = await sandbox.fs.download(path)
        return { content: new TextDecoder().decode(bytes) }
      },
    }),

    writeFile: tool({
      description: 'Write text content to a file in the sandbox filesystem.',
      parameters: z.object({
        path: z.string().describe('Absolute path to the file'),
        content: z.string().describe('File content to write'),
      }),
      execute: async ({ path, content }) => {
        await sandbox.fs.upload(path, new TextEncoder().encode(content))
        return { written: path }
      },
    }),

    listFiles: tool({
      description: 'List files and directories at a given path in the sandbox.',
      parameters: z.object({
        path: z.string().describe('Directory path to list'),
      }),
      execute: async ({ path }) => {
        const entries = await sandbox.fs.ls(path)
        return { entries }
      },
    }),
  }
}

// ---------------------------------------------------------------------------
// Usage with Vercel AI SDK
// ---------------------------------------------------------------------------

async function main() {
  const sandchest = new Sandchest()
  const sandbox = await sandchest.create({ ttlSeconds: 600 })

  try {
    const tools = createSandboxTools(sandbox)

    // Use with generateText or streamText:
    //
    //   import { generateText } from 'ai'
    //   import { openai } from '@ai-sdk/openai'
    //
    //   const { text } = await generateText({
    //     model: openai('gpt-4o'),
    //     tools,
    //     maxSteps: 10,
    //     prompt: 'Write a Python fibonacci script, save it, and run it.',
    //   })

    // Direct invocation:
    const result = await tools.executeCommand.execute(
      { command: 'echo "Hello from Sandchest!"' },
      { toolCallId: 'test', messages: [] },
    )
    console.log(result)
  } finally {
    await sandbox.stop()
  }
}

export { main }
