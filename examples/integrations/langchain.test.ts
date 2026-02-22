import { describe, test, expect, mock } from 'bun:test'
import type { Sandbox } from '@sandchest/sdk'
import { createExecTool, createReadFileTool, createWriteFileTool } from './langchain.js'

function createMockSandbox(overrides?: Partial<Sandbox>): Sandbox {
  return {
    id: 'sb_test123',
    status: 'running',
    replayUrl: 'https://replay.sandchest.com/sb_test123',
    exec: mock(() =>
      Promise.resolve({
        execId: 'ex_abc',
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        durationMs: 42,
      }),
    ),
    fs: {
      upload: mock(() => Promise.resolve()),
      uploadDir: mock(() => Promise.resolve()),
      download: mock(() => Promise.resolve(new TextEncoder().encode('file content'))),
      ls: mock(() => Promise.resolve([])),
      rm: mock(() => Promise.resolve()),
    },
    artifacts: {
      register: mock(() => Promise.resolve({ registered: 0, total: 0 })),
      list: mock(() => Promise.resolve([])),
    },
    session: {
      create: mock(() =>
        Promise.resolve({ id: 'sess_123', exec: mock(), destroy: mock() }),
      ),
    },
    ...overrides,
  } as unknown as Sandbox
}

describe('LangChain integration', () => {
  describe('createExecTool', () => {
    test('returns stdout on successful command', async () => {
      const sandbox = createMockSandbox()
      const execTool = createExecTool(sandbox)

      const result = await execTool.invoke({ command: 'echo hello' })

      expect(result).toBe('hello\n')
      expect(sandbox.exec).toHaveBeenCalledWith('echo hello', {
        cwd: undefined,
      })
    })

    test('returns error string on non-zero exit code', async () => {
      const sandbox = createMockSandbox({
        exec: mock(() =>
          Promise.resolve({
            execId: 'ex_fail',
            exitCode: 1,
            stdout: '',
            stderr: 'command not found',
            durationMs: 5,
          }),
        ) as unknown as Sandbox['exec'],
      })
      const execTool = createExecTool(sandbox)

      const result = await execTool.invoke({ command: 'bad-cmd' })

      expect(result).toBe('Command failed (exit 1):\ncommand not found')
    })

    test('passes cwd option to sandbox.exec', async () => {
      const sandbox = createMockSandbox()
      const execTool = createExecTool(sandbox)

      await execTool.invoke({ command: 'ls', cwd: '/tmp' })

      expect(sandbox.exec).toHaveBeenCalledWith('ls', { cwd: '/tmp' })
    })

    test('has correct tool name and description', () => {
      const sandbox = createMockSandbox()
      const execTool = createExecTool(sandbox)

      expect(execTool.name).toBe('execute_command')
      expect(execTool.description).toContain('Execute a shell command')
    })
  })

  describe('createReadFileTool', () => {
    test('returns decoded file contents', async () => {
      const sandbox = createMockSandbox()
      const readTool = createReadFileTool(sandbox)

      const result = await readTool.invoke({ path: '/tmp/test.txt' })

      expect(result).toBe('file content')
      expect(sandbox.fs.download).toHaveBeenCalledWith('/tmp/test.txt')
    })

    test('has correct tool name', () => {
      const sandbox = createMockSandbox()
      const readTool = createReadFileTool(sandbox)

      expect(readTool.name).toBe('read_file')
    })
  })

  describe('createWriteFileTool', () => {
    test('uploads encoded content and returns confirmation', async () => {
      const sandbox = createMockSandbox()
      const writeTool = createWriteFileTool(sandbox)

      const result = await writeTool.invoke({
        path: '/tmp/out.txt',
        content: 'hello world',
      })

      expect(result).toBe('Written to /tmp/out.txt')
      expect(sandbox.fs.upload).toHaveBeenCalledTimes(1)

      const [path, bytes] = (sandbox.fs.upload as ReturnType<typeof mock>).mock.calls[0]
      expect(path).toBe('/tmp/out.txt')
      expect(new TextDecoder().decode(bytes)).toBe('hello world')
    })

    test('has correct tool name', () => {
      const sandbox = createMockSandbox()
      const writeTool = createWriteFileTool(sandbox)

      expect(writeTool.name).toBe('write_file')
    })
  })
})
