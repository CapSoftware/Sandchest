import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Effect } from 'effect'
import { createServer, createChannel, type Server } from 'nice-grpc'
import { nodeRpc } from '@sandchest/contract'
import { bytesToHex, createLiveNodeClient } from './node-client.live.js'
import type { NodeClientApi } from './node-client.js'

describe('bytesToHex', () => {
  test('converts 16-byte array to 32-char hex string', () => {
    const bytes = new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef])
    expect(bytesToHex(bytes)).toBe('0123456789abcdef0123456789abcdef')
  })

  test('handles all-zero bytes', () => {
    const bytes = new Uint8Array(16)
    expect(bytesToHex(bytes)).toBe('00000000000000000000000000000000')
  })

  test('handles all-max bytes', () => {
    const bytes = new Uint8Array(16).fill(0xff)
    expect(bytesToHex(bytes)).toBe('ffffffffffffffffffffffffffffffff')
  })
})

describe('createLiveNodeClient (integration)', () => {
  let server: Server
  let nodeClient: NodeClientApi
  let receivedSandboxIds: string[] = []

  const testSandboxId = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10])
  const expectedHex = '0102030405060708090a0b0c0d0e0f10'

  beforeAll(async () => {
    receivedSandboxIds = []

    server = createServer()
    server.add(nodeRpc.NodeDefinition, {
      createSandbox: async (req) => ({ sandboxId: req.sandboxId }),
      createSandboxFromSnapshot: async (req) => ({ sandboxId: req.sandboxId }),

      forkSandbox: async (req) => {
        receivedSandboxIds.push(req.sourceSandboxId, req.newSandboxId)
        return { sandboxId: req.newSandboxId }
      },

      exec: async function* (req) {
        receivedSandboxIds.push(req.sandboxId)
        yield { seq: 1, stdout: Buffer.from('hello '), stderr: undefined, exit: undefined }
        yield { seq: 2, stdout: undefined, stderr: Buffer.from('warn'), exit: undefined }
        yield { seq: 3, stdout: Buffer.from('world'), stderr: undefined, exit: undefined }
        yield {
          seq: 4,
          stdout: undefined,
          stderr: undefined,
          exit: { exitCode: 0, cpuMs: 10, peakMemoryBytes: 2048, durationMs: 50 },
        }
      },

      createSession: async (req) => {
        receivedSandboxIds.push(req.sandboxId)
        return { sessionId: req.sessionId }
      },

      sessionExec: async function* (req) {
        receivedSandboxIds.push(req.sandboxId)
        yield { seq: 1, stdout: Buffer.from('session output'), stderr: undefined, exit: undefined }
        yield {
          seq: 2,
          stdout: undefined,
          stderr: undefined,
          exit: { exitCode: 42, cpuMs: 0, peakMemoryBytes: 0, durationMs: 15 },
        }
      },

      sessionInput: async (req) => {
        receivedSandboxIds.push(req.sandboxId)
        return {}
      },

      destroySession: async (req) => {
        receivedSandboxIds.push(req.sandboxId)
        return {}
      },

      putFile: async (request) => {
        let totalBytes = 0
        for await (const chunk of request) {
          receivedSandboxIds.push(chunk.sandboxId)
          totalBytes += chunk.data.length
        }
        return { bytesWritten: totalBytes }
      },

      getFile: async function* (req) {
        receivedSandboxIds.push(req.sandboxId)
        yield { sandboxId: req.sandboxId, path: req.path, data: Buffer.from('file '), offset: 0, done: false }
        yield { sandboxId: req.sandboxId, path: req.path, data: Buffer.from('content'), offset: 5, done: true }
      },

      listFiles: async (req) => {
        receivedSandboxIds.push(req.sandboxId)
        return {
          files: [
            { path: '/home/user/test.txt', size: 100, isDir: false, modifiedAt: 1234567890 },
            { path: '/home/user/dir', size: 0, isDir: true, modifiedAt: 1234567890 },
          ],
        }
      },

      collectArtifacts: async (req) => {
        receivedSandboxIds.push(req.sandboxId)
        return {
          artifacts: [
            { name: 'output.txt', mime: 'text/plain', bytes: 42, sha256: 'abc123', ref: 's3://bucket/output.txt' },
          ],
        }
      },

      stopSandbox: async (req) => ({ sandboxId: req.sandboxId }),
      destroySandbox: async () => ({}),
    })

    const port = await server.listen('localhost:0')
    const channel = createChannel(`localhost:${port}`)
    nodeClient = createLiveNodeClient(channel)
  })

  afterAll(async () => {
    await server.shutdown()
  })

  test('exec collects streaming output into final result', async () => {
    const result = await Effect.runPromise(
      nodeClient.exec({
        sandboxId: testSandboxId,
        execId: 'ex_1',
        cmd: ['echo', 'hello'],
        cwd: '/home',
        env: {},
        timeoutSeconds: 30,
      }),
    )

    expect(result.stdout).toBe('hello world')
    expect(result.stderr).toBe('warn')
    expect(result.exitCode).toBe(0)
    expect(result.cpuMs).toBe(10)
    expect(result.peakMemoryBytes).toBe(2048)
    expect(result.durationMs).toBe(50)
    expect(receivedSandboxIds).toContain(expectedHex)
  })

  test('createSession sends correct sandbox ID', async () => {
    await Effect.runPromise(
      nodeClient.createSession({
        sandboxId: testSandboxId,
        sessionId: 'sess_1',
        shell: '/bin/bash',
        env: { HOME: '/root' },
      }),
    )

    expect(receivedSandboxIds).toContain(expectedHex)
  })

  test('sessionExec collects streaming output', async () => {
    const result = await Effect.runPromise(
      nodeClient.sessionExec({
        sandboxId: testSandboxId,
        sessionId: 'sess_1',
        cmd: 'ls -la',
        timeoutSeconds: 10,
      }),
    )

    expect(result.stdout).toBe('session output')
    expect(result.exitCode).toBe(42)
    expect(result.durationMs).toBe(15)
  })

  test('sessionInput sends data as buffer', async () => {
    await Effect.runPromise(
      nodeClient.sessionInput({
        sandboxId: testSandboxId,
        sessionId: 'sess_1',
        data: 'hello\n',
      }),
    )

    expect(receivedSandboxIds).toContain(expectedHex)
  })

  test('destroySession sends correct IDs', async () => {
    await Effect.runPromise(
      nodeClient.destroySession({
        sandboxId: testSandboxId,
        sessionId: 'sess_1',
      }),
    )

    expect(receivedSandboxIds).toContain(expectedHex)
  })

  test('putFile streams chunked data and returns bytes written', async () => {
    const data = new Uint8Array(Buffer.from('test file content'))
    const result = await Effect.runPromise(
      nodeClient.putFile({
        sandboxId: testSandboxId,
        path: '/home/test.txt',
        data,
      }),
    )

    expect(result.bytesWritten).toBe(data.length)
  })

  test('putFile handles empty files', async () => {
    const result = await Effect.runPromise(
      nodeClient.putFile({
        sandboxId: testSandboxId,
        path: '/home/empty.txt',
        data: new Uint8Array(0),
      }),
    )

    expect(result.bytesWritten).toBe(0)
  })

  test('getFile collects chunked stream into single buffer', async () => {
    const result = await Effect.runPromise(
      nodeClient.getFile({
        sandboxId: testSandboxId,
        path: '/home/test.txt',
      }),
    )

    expect(Buffer.from(result).toString('utf-8')).toBe('file content')
  })

  test('listFiles maps proto response to NodeFileEntry[]', async () => {
    const files = await Effect.runPromise(
      nodeClient.listFiles({
        sandboxId: testSandboxId,
        path: '/home/user',
      }),
    )

    expect(files).toHaveLength(2)
    expect(files[0]).toEqual({
      name: 'test.txt',
      path: '/home/user/test.txt',
      type: 'file',
      sizeBytes: 100,
    })
    expect(files[1]).toEqual({
      name: 'dir',
      path: '/home/user/dir',
      type: 'directory',
      sizeBytes: null,
    })
  })

  test('forkSandbox sends both sandbox IDs as hex', async () => {
    const newId = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0, 0xf0, 0x01])

    await Effect.runPromise(
      nodeClient.forkSandbox({
        sourceSandboxId: testSandboxId,
        newSandboxId: newId,
      }),
    )

    expect(receivedSandboxIds).toContain(expectedHex)
    expect(receivedSandboxIds).toContain('102030405060708090a0b0c0d0e0f001')
  })

  test('collectArtifacts maps proto response to CollectedArtifact[]', async () => {
    const artifacts = await Effect.runPromise(
      nodeClient.collectArtifacts({
        sandboxId: testSandboxId,
        paths: ['/output'],
      }),
    )

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toEqual({
      name: 'output.txt',
      mime: 'text/plain',
      bytes: 42,
      sha256: 'abc123',
      ref: 's3://bucket/output.txt',
    })
  })

  test('deleteFile dies with unimplemented error', async () => {
    await expect(
      Effect.runPromise(
        nodeClient.deleteFile({
          sandboxId: testSandboxId,
          path: '/tmp/file',
        }),
      ),
    ).rejects.toThrow('deleteFile is not implemented')
  })
})
