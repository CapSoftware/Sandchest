import { describe, test, expect } from 'bun:test'
import { Session } from './session.js'
import { HttpClient } from './http.js'

function createMockHttp(): HttpClient {
  return new HttpClient({
    apiKey: 'sk_test',
    baseUrl: 'https://api.sandchest.com',
    timeout: 30_000,
    retries: 0,
  })
}

describe('Session', () => {
  test('stores id, sandboxId, and http client', () => {
    const http = createMockHttp()
    const session = new Session('sess_abc', 'sb_xyz', http)

    expect(session.id).toBe('sess_abc')
    expect(session._sandboxId).toBe('sb_xyz')
    expect(session._http).toBe(http)
  })

  test('exec throws not implemented', async () => {
    const session = new Session('sess_abc', 'sb_xyz', createMockHttp())
    await expect(session.exec('ls -la')).rejects.toThrow('Not implemented')
  })

  test('destroy throws not implemented', async () => {
    const session = new Session('sess_abc', 'sb_xyz', createMockHttp())
    await expect(session.destroy()).rejects.toThrow('Not implemented')
  })
})
