import { describe, test, expect } from 'bun:test'
import { Sandbox } from './sandbox.js'
import { HttpClient } from './http.js'

function createMockHttp(): HttpClient {
  return new HttpClient({
    apiKey: 'sk_test',
    baseUrl: 'https://api.sandchest.com',
    timeout: 30_000,
    retries: 0,
  })
}

describe('Sandbox', () => {
  test('stores id, status, replayUrl, and http client', () => {
    const http = createMockHttp()
    const sandbox = new Sandbox('sb_abc123', 'running', 'https://replay.sandchest.com/sb_abc123', http)

    expect(sandbox.id).toBe('sb_abc123')
    expect(sandbox.status).toBe('running')
    expect(sandbox.replayUrl).toBe('https://replay.sandchest.com/sb_abc123')
    expect(sandbox._http).toBe(http)
  })

  test('status is mutable', () => {
    const sandbox = new Sandbox('sb_x', 'queued', 'https://replay.sandchest.com/sb_x', createMockHttp())
    sandbox.status = 'running'
    expect(sandbox.status).toBe('running')
  })

  test('fs operations are initialized', () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    expect(sandbox.fs).toBeDefined()
    expect(typeof sandbox.fs.upload).toBe('function')
    expect(typeof sandbox.fs.uploadDir).toBe('function')
    expect(typeof sandbox.fs.download).toBe('function')
    expect(typeof sandbox.fs.ls).toBe('function')
    expect(typeof sandbox.fs.rm).toBe('function')
  })

  test('artifacts operations are initialized', () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    expect(sandbox.artifacts).toBeDefined()
    expect(typeof sandbox.artifacts.register).toBe('function')
    expect(typeof sandbox.artifacts.list).toBe('function')
  })

  test('session manager is initialized', () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    expect(sandbox.session).toBeDefined()
    expect(typeof sandbox.session.create).toBe('function')
  })

  test('exec throws not implemented', () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    expect(() => sandbox.exec('ls')).toThrow('Not implemented')
  })

  test('fork throws not implemented', async () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    await expect(sandbox.fork()).rejects.toThrow('Not implemented')
  })

  test('forks throws not implemented', async () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    await expect(sandbox.forks()).rejects.toThrow('Not implemented')
  })

  test('stop throws not implemented', async () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    await expect(sandbox.stop()).rejects.toThrow('Not implemented')
  })

  test('destroy throws not implemented', async () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    await expect(sandbox.destroy()).rejects.toThrow('Not implemented')
  })

  test('waitReady throws not implemented', async () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    await expect(sandbox.waitReady()).rejects.toThrow('Not implemented')
  })

  test('Symbol.asyncDispose calls stop', async () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    // stop() is not implemented, so asyncDispose should propagate the error
    await expect(sandbox[Symbol.asyncDispose]()).rejects.toThrow('Not implemented')
  })

  test('fs.upload throws not implemented', () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    expect(() => sandbox.fs.upload('/tmp/f', new Uint8Array())).toThrow('Not implemented')
  })

  test('artifacts.register throws not implemented', () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    expect(() => sandbox.artifacts.register(['/tmp/f'])).toThrow('Not implemented')
  })

  test('session.create throws not implemented', () => {
    const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
    expect(() => sandbox.session.create()).toThrow('Not implemented')
  })
})
