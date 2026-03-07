import { describe, expect, test } from 'bun:test'
import { spec } from './openapi.js'
import { generateLlmsDocuments, generateLlmsFullTxt, generateLlmsTxt } from './llms.js'

describe('LLMS documents', () => {
  test('generates both llms documents', () => {
    expect(generateLlmsDocuments()).toEqual({
      'llms.txt': generateLlmsTxt(),
      'llms-full.txt': generateLlmsFullTxt(),
    })
  })

  test('llms.txt links to the full reference and lists every tag', () => {
    const document = generateLlmsTxt()

    expect(document).toContain('https://docs.sandchest.com/llms-full.txt')

    for (const tag of spec.tags) {
      expect(document).toContain(`[${tag.name}](https://docs.sandchest.com/llms-full.txt#`)
    }
  })

  test('llms-full.txt includes every operation id exactly once', () => {
    const document = generateLlmsFullTxt()

    for (const methods of Object.values(spec.paths)) {
      for (const operation of Object.values(methods as Record<string, Record<string, unknown>>)) {
        expect(document).toContain(`- Operation ID: ${operation.operationId}`)
      }
    }
  })

  test('llms-full.txt distinguishes public and authenticated endpoints', () => {
    const document = generateLlmsFullTxt()

    expect(document).toContain('### GET /health')
    expect(document).toContain('### GET /v1/public/replay/{id}')
    expect(document).toContain('- Authentication: None')
    expect(document).toContain('### POST /v1/sandboxes')
    expect(document).toContain('- Authentication: Bearer token in `Authorization` header')
  })
})
