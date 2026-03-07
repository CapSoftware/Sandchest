import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const contentDir = join(import.meta.dirname, '../../content/docs')
const apiReferenceDir = join(contentDir, 'api-reference')
const repoRoot = join(import.meta.dirname, '../../../..')

describe('docs content', () => {
  test('content directory exists', () => {
    expect(existsSync(contentDir)).toBe(true)
  })

  test('root meta.json exists and has correct structure', async () => {
    const meta = await import('../../content/docs/meta.json')
    expect(meta.default.root).toBe(true)
    expect(Array.isArray(meta.default.pages)).toBe(true)
    expect(meta.default.pages.length).toBeGreaterThan(0)
  })

  test('root index.mdx exists', () => {
    expect(existsSync(join(contentDir, 'index.mdx'))).toBe(true)
  })

  const sections = ['getting-started', 'api-reference', 'sdk', 'cli', 'mcp', 'guides']

  for (const section of sections) {
    test(`${section}/meta.json exists`, () => {
      expect(existsSync(join(contentDir, section, 'meta.json'))).toBe(true)
    })
  }

  test('getting-started has required pages', () => {
    expect(existsSync(join(contentDir, 'getting-started/index.mdx'))).toBe(true)
    expect(existsSync(join(contentDir, 'getting-started/authentication.mdx'))).toBe(true)
    expect(existsSync(join(contentDir, 'getting-started/first-sandbox.mdx'))).toBe(true)
  })

  test('sdk has required pages', () => {
    const sdkPages = [
      'index.mdx', 'quickstart.mdx', 'client.mdx', 'sandbox.mdx',
      'sessions.mdx', 'files.mdx', 'artifacts.mdx', 'streaming.mdx', 'error-handling.mdx',
    ]
    for (const page of sdkPages) {
      expect(existsSync(join(contentDir, 'sdk', page))).toBe(true)
    }
  })

  test('cli has required pages', () => {
    expect(existsSync(join(contentDir, 'cli/index.mdx'))).toBe(true)
    expect(existsSync(join(contentDir, 'cli/commands.mdx'))).toBe(true)
  })

  test('mcp has required pages', () => {
    expect(existsSync(join(contentDir, 'mcp/index.mdx'))).toBe(true)
    expect(existsSync(join(contentDir, 'mcp/tools.mdx'))).toBe(true)
  })

  test('guides has required pages', () => {
    const guidePages = [
      'sandbox-lifecycle.mdx', 'forking-snapshots.mdx',
      'session-replay.mdx', 'security-isolation.mdx',
    ]
    for (const page of guidePages) {
      expect(existsSync(join(contentDir, 'guides', page))).toBe(true)
    }
  })
})

describe('openapi spec generation', () => {
  test('api spec can be imported and serialized', async () => {
    const { spec } = await import('../../../api/src/openapi.js')
    expect(spec).toBeDefined()
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBe('Sandchest API')

    const json = JSON.stringify(spec)
    expect(json.length).toBeGreaterThan(0)

    const parsed = JSON.parse(json)
    expect(parsed.openapi).toBe('3.1.0')
  })

  test('api spec has all expected tags', async () => {
    const { spec } = await import('../../../api/src/openapi.js')
    const tagNames = spec.tags.map((t: { name: string }) => t.name)
    expect(tagNames).toContain('Health')
    expect(tagNames).toContain('Sandboxes')
    expect(tagNames).toContain('Exec')
    expect(tagNames).toContain('Sessions')
    expect(tagNames).toContain('Files')
    expect(tagNames).toContain('Artifacts')
    expect(tagNames).toContain('Replay')
  })

  test('openapi.json artifact is generated from the live openapi spec', async () => {
    const { spec } = await import('../../../api/src/openapi.js')
    const specPath = join(apiReferenceDir, 'openapi.json')

    expect(existsSync(specPath)).toBe(true)
    expect(JSON.parse(readFileSync(specPath, 'utf8'))).toEqual(spec)
  })

  test('generated api pages live under the canonical docs tree without absolute path leakage', () => {
    const generatedPagePath = join(apiReferenceDir, 'health/get-health.mdx')
    const leakedOutputRoot = join(import.meta.dirname, '../../Users')

    expect(existsSync(generatedPagePath)).toBe(true)
    expect(existsSync(leakedOutputRoot)).toBe(false)

    const content = readFileSync(generatedPagePath, 'utf8')
    expect(content).toContain('<APIPage document={"content/docs/api-reference/openapi.json"}')
    expect(content.includes(repoRoot)).toBe(false)
  })

  test('llms artifacts are generated from the live openapi spec', async () => {
    const { generateLlmsDocuments } = await import('../../../api/src/llms.js')
    const publicDir = join(import.meta.dirname, '../../public')

    for (const [filename, content] of Object.entries(generateLlmsDocuments())) {
      const filePath = join(publicDir, filename)
      expect(existsSync(filePath)).toBe(true)
      expect(readFileSync(filePath, 'utf8')).toBe(content)
    }
  })
})
