import { spec } from './openapi.js'

const DOCS_BASE_URL = 'https://docs.sandchest.com'
const API_BASE_URL = 'https://api.sandchest.com'
const API_REFERENCE_URL = `${DOCS_BASE_URL}/docs/api-reference`
const API_SPEC_URL = `${API_BASE_URL}/openapi.json`
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'])

type OpenApiRecord = Record<string, unknown>

type Operation = {
  method: string
  path: string
  tag: string
  operationId: string
  summary: string
  description: string | undefined
  security?: unknown
  parameters: unknown[]
  requestBody?: unknown
  responses: OpenApiRecord
}

function isRecord(value: unknown): value is OpenApiRecord {
  return typeof value === 'object' && value !== null
}

function getRefTarget(ref: string): string {
  const parts = ref.split('/')
  return parts[parts.length - 1] ?? ref
}

function resolveRef<T>(value: unknown): T | undefined {
  if (!isRecord(value) || typeof value.$ref !== 'string') {
    return value as T | undefined
  }

  const parts = value.$ref.replace('#/', '').split('/')
  let current: unknown = spec

  for (const part of parts) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[part]
  }

  return current as T | undefined
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function describeSchema(schema: unknown): string {
  if (!isRecord(schema)) {
    return 'unknown'
  }

  if (typeof schema.$ref === 'string') {
    return getRefTarget(schema.$ref)
  }

  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((item) => describeSchema(item)).join(' | ')
  }

  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((item) => describeSchema(item)).join(' | ')
  }

  if (Array.isArray(schema.allOf)) {
    return schema.allOf.map((item) => describeSchema(item)).join(' & ')
  }

  if (schema.type === 'array') {
    return `array<${describeSchema(schema.items)}>`
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 5) {
    return `enum(${schema.enum.map((item) => String(item)).join(', ')})`
  }

  if (typeof schema.type === 'string') {
    if (typeof schema.format === 'string') {
      return `${schema.type} (${schema.format})`
    }
    return schema.type
  }

  if (isRecord(schema.additionalProperties)) {
    return 'object'
  }

  if (isRecord(schema.properties)) {
    return 'object'
  }

  return 'unknown'
}

function describeContent(content: unknown): string[] {
  if (!isRecord(content)) {
    return []
  }

  return Object.entries(content).map(([contentType, mediaType]) => {
    if (!isRecord(mediaType)) {
      return contentType
    }

    return `${contentType}: ${describeSchema(mediaType.schema)}`
  })
}

function describeParameter(parameter: unknown): string | undefined {
  const resolved = resolveRef<OpenApiRecord>(parameter)
  if (!isRecord(resolved) || typeof resolved.name !== 'string' || typeof resolved.in !== 'string') {
    return undefined
  }

  const required = resolved.required === true ? 'required' : 'optional'
  const schemaSummary = describeSchema(resolved.schema)
  const description = typeof resolved.description === 'string' ? ` ${resolved.description}` : ''
  return `\`${resolved.name}\` (${resolved.in}, ${required}) - ${schemaSummary}.${description}`.trim()
}

function describeSecurity(operation: Operation): string {
  if (Array.isArray(operation.security) && operation.security.length === 0) {
    return 'None'
  }

  const security = Array.isArray(operation.security) ? operation.security : spec.security
  if (!Array.isArray(security) || security.length === 0) {
    return 'Not specified'
  }

  if (security.some((item) => isRecord(item) && 'bearerAuth' in item)) {
    return 'Bearer token in `Authorization` header'
  }

  return 'Authentication required'
}

function getOperationsByTag(): Array<{ name: string; description: string | undefined; operations: Operation[] }> {
  const groups = new Map<string, Operation[]>()

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!isRecord(pathItem)) {
      continue
    }

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !isRecord(operation)) {
        continue
      }

      const tag = Array.isArray(operation.tags) && typeof operation.tags[0] === 'string' ? operation.tags[0] : 'General'
      const operations = groups.get(tag) ?? []
      operations.push({
        method: method.toUpperCase(),
        path,
        tag,
        operationId: typeof operation.operationId === 'string' ? operation.operationId : `${method}:${path}`,
        summary: typeof operation.summary === 'string' ? operation.summary : `${method.toUpperCase()} ${path}`,
        description: typeof operation.description === 'string' ? operation.description : undefined,
        security: operation.security,
        parameters: Array.isArray(operation.parameters) ? operation.parameters : [],
        requestBody: operation.requestBody,
        responses: isRecord(operation.responses) ? operation.responses : {},
      })
      groups.set(tag, operations)
    }
  }

  const orderedTags: Array<{ name: string; description: string | undefined; operations: Operation[] }> = spec.tags.map((tag) => ({
    name: tag.name,
    description: tag.description,
    operations: groups.get(tag.name) ?? [],
  }))

  for (const [name, operations] of groups.entries()) {
    if (orderedTags.some((tag) => tag.name === name)) {
      continue
    }
    orderedTags.push({ name, description: undefined, operations })
  }

  return orderedTags.filter((tag) => tag.operations.length > 0)
}

function renderRequestBody(operation: Operation): string[] {
  const requestBody = resolveRef<OpenApiRecord>(operation.requestBody)
  if (!isRecord(requestBody)) {
    return ['- Request body: none']
  }

  const parts = describeContent(requestBody.content)
  if (parts.length === 0) {
    return ['- Request body: present']
  }

  return ['- Request body:', ...parts.map((part) => `  - ${part}`)]
}

function renderResponses(operation: Operation): string[] {
  const lines = ['- Responses:']

  for (const [status, response] of Object.entries(operation.responses)) {
    const resolved = resolveRef<OpenApiRecord>(response)
    if (!isRecord(resolved)) {
      lines.push(`  - \`${status}\``)
      continue
    }

    const description = typeof resolved.description === 'string' ? resolved.description : 'No description'
    const content = describeContent(resolved.content)
    const suffix = content.length > 0 ? ` (${content.join('; ')})` : ''
    lines.push(`  - \`${status}\`: ${description}${suffix}`)
  }

  return lines
}

export function generateLlmsTxt(): string {
  const tags = getOperationsByTag()
  const totalOperations = tags.reduce((count, tag) => count + tag.operations.length, 0)
  const lines = [
    '# Sandchest API',
    '',
    '> Compact API index for language models. Generated from the live OpenAPI 3.1 specification.',
    '',
    `- Base URL: ${API_BASE_URL}`,
    `- OpenAPI: ${API_SPEC_URL}`,
    `- API reference: ${API_REFERENCE_URL}`,
    `- Full LLM reference: ${DOCS_BASE_URL}/llms-full.txt`,
    `- Operations: ${totalOperations}`,
    '',
    '## Authentication',
    '',
    'Use `Authorization: Bearer <api_key>` for authenticated endpoints. Health probes and the public replay endpoint do not require authentication.',
    '',
    '## Endpoint Groups',
    '',
    ...tags.map((tag) => {
      const description = tag.description ?? 'API operations'
      return `- [${tag.name}](${DOCS_BASE_URL}/llms-full.txt#${slugify(tag.name)}): ${description} (${tag.operations.length} operations)`
    }),
    '',
  ]

  return lines.join('\n')
}

export function generateLlmsFullTxt(): string {
  const tags = getOperationsByTag()
  const lines = [
    '# Sandchest API',
    '',
    '> Expanded API reference for language models. Generated from the live OpenAPI 3.1 specification.',
    '',
    `- Version: ${spec.info.version}`,
    `- Base URL: ${API_BASE_URL}`,
    `- OpenAPI: ${API_SPEC_URL}`,
    `- API reference: ${API_REFERENCE_URL}`,
    '',
    '## Authentication',
    '',
    'Use `Authorization: Bearer <api_key>` on authenticated endpoints. Operations that set `security: []` in the OpenAPI spec are public.',
    '',
  ]

  for (const tag of tags) {
    lines.push(`## ${tag.name}`, '')

    if (tag.description) {
      lines.push(tag.description, '')
    }

    for (const operation of tag.operations) {
      lines.push(`### ${operation.method} ${operation.path}`, '')
      lines.push(`- Summary: ${operation.summary}`)
      lines.push(`- Operation ID: ${operation.operationId}`)
      lines.push(`- Authentication: ${describeSecurity(operation)}`)

      if (operation.description) {
        lines.push(`- Description: ${operation.description}`)
      }

      const parameters = operation.parameters.map((parameter) => describeParameter(parameter)).filter(Boolean)
      if (parameters.length === 0) {
        lines.push('- Parameters: none')
      } else {
        lines.push('- Parameters:')
        lines.push(...parameters.map((parameter) => `  - ${parameter}`))
      }

      lines.push(...renderRequestBody(operation))
      lines.push(...renderResponses(operation))
      lines.push('')
    }
  }

  return lines.join('\n')
}

export function generateLlmsDocuments(): Record<string, string> {
  return {
    'llms.txt': generateLlmsTxt(),
    'llms-full.txt': generateLlmsFullTxt(),
  }
}
