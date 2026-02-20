import { describe, expect, test } from 'bun:test'
import {
  sandboxCreated,
  sandboxReady,
  sandboxForked,
  sandboxStopping,
  sandboxStopped,
  sandboxFailed,
  execStarted,
  execOutput,
  execCompleted,
  execFailed,
  sessionCreated,
  sessionDestroyed,
  fileWritten,
  fileDeleted,
  artifactRegistered,
  artifactCollected,
} from './events.js'

describe('event builders', () => {
  test('sandboxCreated redacts env values', () => {
    const event = sandboxCreated({
      image: 'sandchest://ubuntu-22.04/node-22',
      profile: 'small',
      env: { API_KEY: 'secret-123', DB_URL: 'postgres://...' },
      forked_from: null,
    })

    expect(event.type).toBe('sandbox.created')
    expect(event.data.image).toBe('sandchest://ubuntu-22.04/node-22')
    expect(event.data.profile).toBe('small')
    expect(event.data.forked_from).toBeNull()

    const env = event.data.env as Record<string, string>
    expect(env.API_KEY).toBe('[REDACTED]')
    expect(env.DB_URL).toBe('[REDACTED]')
  })

  test('sandboxCreated handles null env', () => {
    const event = sandboxCreated({
      image: 'sandchest://ubuntu-22.04/base',
      profile: 'medium',
      env: null,
      forked_from: null,
    })

    expect(event.data.env).toEqual({})
  })

  test('sandboxCreated includes forked_from when set', () => {
    const event = sandboxCreated({
      image: 'sandchest://ubuntu-22.04/base',
      profile: 'small',
      env: null,
      forked_from: 'sb_parent123',
    })

    expect(event.data.forked_from).toBe('sb_parent123')
  })

  test('sandboxReady has boot_duration_ms', () => {
    const event = sandboxReady({ boot_duration_ms: 1200 })
    expect(event.type).toBe('sandbox.ready')
    expect(event.data.boot_duration_ms).toBe(1200)
  })

  test('sandboxForked has fork_sandbox_id', () => {
    const event = sandboxForked({ fork_sandbox_id: 'sb_fork456' })
    expect(event.type).toBe('sandbox.forked')
    expect(event.data.fork_sandbox_id).toBe('sb_fork456')
  })

  test('sandboxStopping has reason', () => {
    const event = sandboxStopping({ reason: 'user_requested' })
    expect(event.type).toBe('sandbox.stopping')
    expect(event.data.reason).toBe('user_requested')
  })

  test('sandboxStopped has total_duration_ms', () => {
    const event = sandboxStopped({ total_duration_ms: 600000 })
    expect(event.type).toBe('sandbox.stopped')
    expect(event.data.total_duration_ms).toBe(600000)
  })

  test('sandboxFailed has failure_reason', () => {
    const event = sandboxFailed({ failure_reason: 'provision_failed' })
    expect(event.type).toBe('sandbox.failed')
    expect(event.data.failure_reason).toBe('provision_failed')
  })

  test('execStarted has all fields', () => {
    const event = execStarted({
      exec_id: 'ex_test123',
      cmd: ['git', 'clone', 'https://github.com/org/repo'],
      cwd: '/root',
      session_id: null,
    })

    expect(event.type).toBe('exec.started')
    expect(event.data.exec_id).toBe('ex_test123')
    expect(event.data.cmd).toEqual(['git', 'clone', 'https://github.com/org/repo'])
    expect(event.data.cwd).toBe('/root')
    expect(event.data.session_id).toBeNull()
  })

  test('execStarted with session_id', () => {
    const event = execStarted({
      exec_id: 'ex_test123',
      cmd: 'npm install',
      cwd: '/work',
      session_id: 'sess_abc',
    })

    expect(event.data.session_id).toBe('sess_abc')
    expect(event.data.cmd).toBe('npm install')
  })

  test('execOutput has stream and data', () => {
    const event = execOutput({
      exec_id: 'ex_test123',
      stream: 'stdout',
      data: 'Cloning into /work...\n',
    })

    expect(event.type).toBe('exec.output')
    expect(event.data.exec_id).toBe('ex_test123')
    expect(event.data.stream).toBe('stdout')
    expect(event.data.data).toBe('Cloning into /work...\n')
  })

  test('execCompleted has exit_code, duration, and resource_usage', () => {
    const event = execCompleted({
      exec_id: 'ex_test123',
      exit_code: 0,
      duration_ms: 2100,
      resource_usage: { cpu_ms: 450, peak_memory_bytes: 33554432 },
    })

    expect(event.type).toBe('exec.completed')
    expect(event.data.exit_code).toBe(0)
    expect(event.data.duration_ms).toBe(2100)
    expect(event.data.resource_usage).toEqual({ cpu_ms: 450, peak_memory_bytes: 33554432 })
  })

  test('execCompleted handles null resource_usage', () => {
    const event = execCompleted({
      exec_id: 'ex_test123',
      exit_code: 1,
      duration_ms: 500,
      resource_usage: null,
    })

    expect(event.data.resource_usage).toBeNull()
  })

  test('execFailed has reason', () => {
    const event = execFailed({ exec_id: 'ex_test123', reason: 'command not found' })
    expect(event.type).toBe('exec.failed')
    expect(event.data.exec_id).toBe('ex_test123')
    expect(event.data.reason).toBe('command not found')
  })

  test('sessionCreated has session_id and shell', () => {
    const event = sessionCreated({ session_id: 'sess_abc', shell: '/bin/bash' })
    expect(event.type).toBe('session.created')
    expect(event.data.session_id).toBe('sess_abc')
    expect(event.data.shell).toBe('/bin/bash')
  })

  test('sessionDestroyed has session_id', () => {
    const event = sessionDestroyed({ session_id: 'sess_abc' })
    expect(event.type).toBe('session.destroyed')
    expect(event.data.session_id).toBe('sess_abc')
  })

  test('fileWritten has path and size_bytes', () => {
    const event = fileWritten({ path: '/work/.env', size_bytes: 256 })
    expect(event.type).toBe('file.written')
    expect(event.data.path).toBe('/work/.env')
    expect(event.data.size_bytes).toBe(256)
  })

  test('fileDeleted has path', () => {
    const event = fileDeleted({ path: '/tmp/temp.txt' })
    expect(event.type).toBe('file.deleted')
    expect(event.data.path).toBe('/tmp/temp.txt')
  })

  test('artifactRegistered has paths array', () => {
    const event = artifactRegistered({ paths: ['/work/coverage.lcov', '/work/test-results.xml'] })
    expect(event.type).toBe('artifact.registered')
    expect(event.data.paths).toEqual(['/work/coverage.lcov', '/work/test-results.xml'])
  })

  test('artifactCollected has all fields', () => {
    const event = artifactCollected({
      artifact_id: 'art_test123',
      name: 'test-results.xml',
      mime: 'application/xml',
      bytes: 12288,
      sha256: 'a1b2c3',
    })

    expect(event.type).toBe('artifact.collected')
    expect(event.data.artifact_id).toBe('art_test123')
    expect(event.data.name).toBe('test-results.xml')
    expect(event.data.mime).toBe('application/xml')
    expect(event.data.bytes).toBe(12288)
    expect(event.data.sha256).toBe('a1b2c3')
  })

  test('all 16 event types produce valid payloads', () => {
    const events = [
      sandboxCreated({ image: 'img', profile: 'small', env: null, forked_from: null }),
      sandboxReady({ boot_duration_ms: 100 }),
      sandboxForked({ fork_sandbox_id: 'sb_x' }),
      sandboxStopping({ reason: 'user' }),
      sandboxStopped({ total_duration_ms: 1000 }),
      sandboxFailed({ failure_reason: 'crash' }),
      execStarted({ exec_id: 'ex_1', cmd: ['ls'], cwd: '/', session_id: null }),
      execOutput({ exec_id: 'ex_1', stream: 'stdout', data: 'out' }),
      execCompleted({ exec_id: 'ex_1', exit_code: 0, duration_ms: 10, resource_usage: null }),
      execFailed({ exec_id: 'ex_2', reason: 'err' }),
      sessionCreated({ session_id: 'sess_1', shell: '/bin/sh' }),
      sessionDestroyed({ session_id: 'sess_1' }),
      fileWritten({ path: '/a', size_bytes: 1 }),
      fileDeleted({ path: '/a' }),
      artifactRegistered({ paths: ['/a'] }),
      artifactCollected({ artifact_id: 'art_1', name: 'a', mime: 'text/plain', bytes: 1, sha256: 'x' }),
    ]

    expect(events.length).toBe(16)
    for (const event of events) {
      expect(event.type).toBeDefined()
      expect(event.data).toBeDefined()
      expect(typeof event.type).toBe('string')
      expect(typeof event.data).toBe('object')
    }
  })
})
