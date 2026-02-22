/**
 * Sandchest + LangChain Integration
 *
 * Use Sandchest sandboxes as tools for LangChain agents, giving AI models
 * the ability to execute code in isolated Firecracker microVMs.
 *
 * Install:
 *   bun add @sandchest/sdk @langchain/core zod
 */
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { Sandchest, type Sandbox } from '@sandchest/sdk'

/**
 * Execute a shell command inside the sandbox. Returns stdout on success
 * or a formatted error string on non-zero exit.
 */
export function createExecTool(sandbox: Sandbox) {
  return tool(
    async ({ command, cwd }) => {
      const result = await sandbox.exec(command, {
        cwd: cwd ?? undefined,
      })
      if (result.exitCode !== 0) {
        return `Command failed (exit ${result.exitCode}):\n${result.stderr}`
      }
      return result.stdout
    },
    {
      name: 'execute_command',
      description:
        'Execute a shell command in an isolated Linux sandbox. Returns stdout on success or stderr on failure.',
      schema: z.object({
        command: z.string().describe('The shell command to execute'),
        cwd: z.string().optional().describe('Working directory for the command'),
      }),
    },
  )
}

/**
 * Read a file from the sandbox filesystem.
 */
export function createReadFileTool(sandbox: Sandbox) {
  return tool(
    async ({ path }) => {
      const bytes = await sandbox.fs.download(path)
      return new TextDecoder().decode(bytes)
    },
    {
      name: 'read_file',
      description: 'Read a file from the sandbox filesystem. Returns file contents as text.',
      schema: z.object({
        path: z.string().describe('Absolute path to the file'),
      }),
    },
  )
}

/**
 * Write content to a file in the sandbox filesystem.
 */
export function createWriteFileTool(sandbox: Sandbox) {
  return tool(
    async ({ path, content }) => {
      await sandbox.fs.upload(path, new TextEncoder().encode(content))
      return `Written to ${path}`
    },
    {
      name: 'write_file',
      description: 'Write text content to a file in the sandbox filesystem.',
      schema: z.object({
        path: z.string().describe('Absolute path to the file'),
        content: z.string().describe('File content to write'),
      }),
    },
  )
}

// ---------------------------------------------------------------------------
// Usage with a LangChain agent
// ---------------------------------------------------------------------------

async function main() {
  const sandchest = new Sandchest()
  const sandbox = await sandchest.create({
    image: 'sandchest://ubuntu-22.04',
    ttlSeconds: 600,
  })

  try {
    const execTool = createExecTool(sandbox)
    const readFileTool = createReadFileTool(sandbox)
    const writeFileTool = createWriteFileTool(sandbox)

    // Bind to any LangChain agent:
    //
    //   import { ChatOpenAI } from '@langchain/openai'
    //   import { createReactAgent } from '@langchain/langgraph/prebuilt'
    //
    //   const agent = createReactAgent({
    //     llm: new ChatOpenAI({ model: 'gpt-4o' }),
    //     tools: [execTool, readFileTool, writeFileTool],
    //   })
    //
    //   const result = await agent.invoke({
    //     messages: [{ role: 'user', content: 'Run `uname -a` in the sandbox' }],
    //   })

    // Direct invocation:
    const result = await execTool.invoke({ command: 'echo "Hello from Sandchest!"' })
    console.log(result)
  } finally {
    await sandbox.stop()
  }
}

export { main }
