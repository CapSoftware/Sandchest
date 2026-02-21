import { describe, expect, test } from 'bun:test'
import { spec } from './openapi.js'

describe('OpenAPI spec', () => {
  test('has valid openapi version', () => {
    expect(spec.openapi).toBe('3.1.0')
  })

  test('has info with title and version', () => {
    expect(spec.info.title).toBe('Sandchest API')
    expect(spec.info.version).toBeTruthy()
  })

  test('defines bearer auth security scheme', () => {
    expect(spec.components.securitySchemes.bearerAuth.type).toBe('http')
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer')
  })

  test('health endpoints have no security requirement', () => {
    expect(spec.paths['/health'].get.security).toEqual([])
    expect(spec.paths['/healthz'].get.security).toEqual([])
    expect(spec.paths['/readyz'].get.security).toEqual([])
  })

  test('public replay endpoint has no security requirement', () => {
    expect(spec.paths['/v1/public/replay/{id}'].get.security).toEqual([])
  })

  test('authenticated endpoints inherit global security', () => {
    const createSandbox = spec.paths['/v1/sandboxes'].post
    expect(createSandbox.security).toBeUndefined()
  })

  test('every path has at least one operation', () => {
    for (const [_path, methods] of Object.entries(spec.paths)) {
      const ops = Object.keys(methods as Record<string, unknown>)
      expect(ops.length).toBeGreaterThan(0)
    }
  })

  test('every operation has an operationId', () => {
    for (const [_path, methods] of Object.entries(spec.paths)) {
      for (const [_method, op] of Object.entries(methods as Record<string, Record<string, unknown>>)) {
        expect(op.operationId).toBeTruthy()
      }
    }
  })

  test('every operation has at least one response', () => {
    for (const [_path, methods] of Object.entries(spec.paths)) {
      for (const [_method, op] of Object.entries(methods as Record<string, Record<string, unknown>>)) {
        const responses = op.responses as Record<string, unknown>
        expect(Object.keys(responses).length).toBeGreaterThan(0)
      }
    }
  })

  test('operationIds are unique', () => {
    const ids: string[] = []
    for (const methods of Object.values(spec.paths)) {
      for (const op of Object.values(methods as Record<string, Record<string, unknown>>)) {
        ids.push(op.operationId as string)
      }
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('all $ref targets resolve to existing schemas', () => {
    const refs: string[] = []
    const collect = (obj: unknown) => {
      if (typeof obj !== 'object' || obj === null) return
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (k === '$ref' && typeof v === 'string') refs.push(v)
        else collect(v)
      }
    }
    collect(spec.paths)
    collect(spec.components.responses)

    for (const ref of refs) {
      const parts = ref.replace('#/', '').split('/')
      let current: unknown = spec
      for (const part of parts) {
        current = (current as Record<string, unknown>)[part]
        expect(current).toBeDefined()
      }
    }
  })

  test('covers all expected API paths', () => {
    const paths = Object.keys(spec.paths)
    expect(paths).toContain('/health')
    expect(paths).toContain('/healthz')
    expect(paths).toContain('/readyz')
    expect(paths).toContain('/v1/sandboxes')
    expect(paths).toContain('/v1/sandboxes/{id}')
    expect(paths).toContain('/v1/sandboxes/{id}/fork')
    expect(paths).toContain('/v1/sandboxes/{id}/stop')
    expect(paths).toContain('/v1/sandboxes/{id}/forks')
    expect(paths).toContain('/v1/sandboxes/{id}/stream')
    expect(paths).toContain('/v1/sandboxes/{id}/replay')
    expect(paths).toContain('/v1/public/replay/{id}')
    expect(paths).toContain('/v1/sandboxes/{id}/exec')
    expect(paths).toContain('/v1/sandboxes/{id}/exec/{execId}')
    expect(paths).toContain('/v1/sandboxes/{id}/execs')
    expect(paths).toContain('/v1/sandboxes/{id}/exec/{execId}/stream')
    expect(paths).toContain('/v1/sandboxes/{id}/sessions')
    expect(paths).toContain('/v1/sandboxes/{id}/sessions/{sessionId}')
    expect(paths).toContain('/v1/sandboxes/{id}/sessions/{sessionId}/exec')
    expect(paths).toContain('/v1/sandboxes/{id}/sessions/{sessionId}/input')
    expect(paths).toContain('/v1/sandboxes/{id}/sessions/{sessionId}/stream')
    expect(paths).toContain('/v1/sandboxes/{id}/files')
    expect(paths).toContain('/v1/sandboxes/{id}/artifacts')
  })
})
