import { describe, test, expect, mock } from 'bun:test'
import type { Sandbox } from '@sandchest/sdk'
import { createSandboxTools } from './vercel-ai.js'

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
      ls: mock(() =>
        Promise.resolve([
          { name: 'test.txt', path: '/tmp/test.txt', type: 'file' as const, size: 12 },
        ]),
      ),
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

const toolCallOptions = { toolCallId: 'tc_1', messages: [] as never[] }

describe('Vercel AI SDK integration', () => {
  describe('executeCommand', () => {
    test('returns structured result on success', async () => {
      const sandbox = createMockSandbox()
      const tools = createSandboxTools(sandbox)

      const result = await tools.executeCommand.execute(
        { command: 'echo hello' },
        toolCallOptions,
      )

      expect(result).toEqual({
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        durationMs: 42,
      })
      expect(sandbox.exec).toHaveBeenCalledWith('echo hello', {
        cwd: undefined,
      })
    })

    test('returns error details on non-zero exit', async () => {
      const sandbox = createMockSandbox({
        exec: mock(() =>
          Promise.resolve({
            execId: 'ex_fail',
            exitCode: 127,
            stdout: '',
            stderr: 'bash: bad: command not found',
            durationMs: 3,
          }),
        ) as unknown as Sandbox['exec'],
      })
      const tools = createSandboxTools(sandbox)

      const result = await tools.executeCommand.execute(
        { command: 'bad' },
        toolCallOptions,
      )

      expect(result.exitCode).toBe(127)
      expect(result.stderr).toContain('command not found')
    })

    test('passes cwd option', async () => {
      const sandbox = createMockSandbox()
      const tools = createSandboxTools(sandbox)

      await tools.executeCommand.execute(
        { command: 'ls', cwd: '/home' },
        toolCallOptions,
      )

      expect(sandbox.exec).toHaveBeenCalledWith('ls', { cwd: '/home' })
    })
  })

  describe('readFile', () => {
    test('returns decoded file content', async () => {
      const sandbox = createMockSandbox()
      const tools = createSandboxTools(sandbox)

      const result = await tools.readFile.execute(
        { path: '/tmp/test.txt' },
        toolCallOptions,
      )

      expect(result).toEqual({ content: 'file content' })
      expect(sandbox.fs.download).toHaveBeenCalledWith('/tmp/test.txt')
    })
  })

  describe('writeFile', () => {
    test('uploads content and returns written path', async () => {
      const sandbox = createMockSandbox()
      const tools = createSandboxTools(sandbox)

      const result = await tools.writeFile.execute(
        { path: '/tmp/out.txt', content: 'data' },
        toolCallOptions,
      )

      expect(result).toEqual({ written: '/tmp/out.txt' })
      expect(sandbox.fs.upload).toHaveBeenCalledTimes(1)

      const [path, bytes] = (sandbox.fs.upload as ReturnType<typeof mock>).mock.calls[0]
      expect(path).toBe('/tmp/out.txt')
      expect(new TextDecoder().decode(bytes)).toBe('data')
    })
  })

  describe('listFiles', () => {
    test('returns directory entries', async () => {
      const sandbox = createMockSandbox()
      const tools = createSandboxTools(sandbox)

      const result = await tools.listFiles.execute(
        { path: '/tmp' },
        toolCallOptions,
      )

      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].name).toBe('test.txt')
      expect(sandbox.fs.ls).toHaveBeenCalledWith('/tmp')
    })
  })
})
