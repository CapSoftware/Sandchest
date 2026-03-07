import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Sandchest } from '@sandchest/sdk'
import { ExecFailedError, SandchestError, Session } from '@sandchest/sdk'

function jsonContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

const EXEC_OUTPUT_CAP_BYTES = 1_048_576
const ALLOWED_PATHS_ENV = 'SANDCHEST_MCP_ALLOWED_PATHS'
const TEXT_ENCODER = new TextEncoder()

type ArchiveEntryType = 'file' | 'directory'

type ArchiveEntry = {
  path: string
  type: ArchiveEntryType
  content?: Uint8Array
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}

function encodeBase64(value: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''

  for (let index = 0; index < value.length; index += chunkSize) {
    binary += String.fromCharCode(...value.subarray(index, index + chunkSize))
  }

  return btoa(binary)
}

function parseAllowedRoots(): string[] {
  return (process.env[ALLOWED_PATHS_ENV] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return realpathSync(resolve(value))
      } catch {
        return resolve(value)
      }
    })
}

function isWithinAllowedRoots(targetPath: string, allowedRoots: string[]): boolean {
  return allowedRoots.some((root) => {
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`
    return targetPath === root || targetPath.startsWith(prefix)
  })
}

function resolveExistingPath(rawPath: string): string {
  return realpathSync(resolve(rawPath))
}

function resolveFuturePath(rawPath: string): string {
  const resolved = resolve(rawPath)
  if (existsSync(resolved)) {
    return realpathSync(resolved)
  }

  return join(realpathSync(dirname(resolved)), basename(resolved))
}

function readTarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  const slice = end === -1 ? bytes : bytes.subarray(0, end)
  return Buffer.from(slice).toString('utf-8')
}

function readTarOctal(bytes: Uint8Array): number {
  const value = readTarString(bytes).replace(/\0/g, '').trim()
  if (value === '') {
    return 0
  }

  return Number.parseInt(value, 8)
}

function parsePaxPath(bytes: Uint8Array): string | undefined {
  const text = Buffer.from(bytes).toString('utf-8')
  for (const line of text.split('\n')) {
    if (line === '') {
      continue
    }
    const space = line.indexOf(' ')
    const record = space === -1 ? line : line.slice(space + 1)
    const equals = record.indexOf('=')
    if (equals === -1) {
      continue
    }
    if (record.slice(0, equals) === 'path') {
      return record.slice(equals + 1)
    }
  }

  return undefined
}

function normalizeArchivePath(rawPath: string): string | null {
  const normalized = rawPath.replace(/\\/g, '/')
  if (normalized.startsWith('/')) {
    return null
  }

  const parts: string[] = []
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') {
      continue
    }

    if (part === '..') {
      if (parts.length === 0) {
        return null
      }
      parts.pop()
      continue
    }

    parts.push(part)
  }

  return parts.join('/')
}

function listArchiveEntries(bytes: Uint8Array, operation: string): ArchiveEntry[] {
  const archive = gunzipSync(bytes)
  const entries: ArchiveEntry[] = []
  let offset = 0
  let nextPaxPath: string | undefined
  let nextLongPath: string | undefined

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) {
      break
    }

    const size = readTarOctal(header.subarray(124, 136))
    const typeFlag = String.fromCharCode(header[156] ?? 0)
    const name = readTarString(header.subarray(0, 100))
    const prefix = readTarString(header.subarray(345, 500))
    const headerPath = nextLongPath ?? nextPaxPath ?? [prefix, name].filter(Boolean).join('/')
    nextLongPath = undefined
    nextPaxPath = undefined

    const bodyStart = offset + 512
    const bodyEnd = bodyStart + size
    const body = archive.subarray(bodyStart, bodyEnd)
    const paddedSize = Math.ceil(size / 512) * 512
    offset = bodyStart + paddedSize

    if (typeFlag === 'x') {
      nextPaxPath = parsePaxPath(body)
      continue
    }

    if (typeFlag === 'L') {
      nextLongPath = Buffer.from(body).toString('utf-8').replace(/\0+$/, '')
      continue
    }

    const normalizedPath = normalizeArchivePath(headerPath)
    if (normalizedPath === null) {
      throw new Error(`${operation} archive contains unsafe path '${headerPath}'`)
    }

    const kind =
      typeFlag === '' || typeFlag === '\0' || typeFlag === '0'
        ? 'file'
        : typeFlag === '5'
          ? 'directory'
          : null

    if (kind === null) {
      throw new Error(`${operation} archive contains unsupported entry type '${typeFlag}' at '${headerPath}'`)
    }

    if (normalizedPath === '') {
      if (kind !== 'directory') {
        throw new Error(`${operation} archive contains unsafe path '${headerPath}'`)
      }
      continue
    }

    if (kind === 'file') {
      entries.push({
        path: normalizedPath,
        type: kind,
        content: new Uint8Array(body),
      })
    } else {
      entries.push({
        path: normalizedPath,
        type: kind,
      })
    }
  }

  return entries
}

function validateArchiveFile(archivePath: string, operation: string): ArchiveEntry[] {
  return listArchiveEntries(readFileSync(archivePath), operation)
}

function validateArchiveBytes(bytes: Uint8Array, operation: string): ArchiveEntry[] {
  return listArchiveEntries(bytes, operation)
}

function extractArchiveToNewDirectory(tarball: Uint8Array, destinationPath: string, operation: string): void {
  if (existsSync(destinationPath)) {
    throw new Error(`Destination already exists: ${destinationPath}. ${operation} requires a new directory to avoid overwriting local files.`)
  }

  const entries = validateArchiveBytes(tarball, operation)

  const parentDir = dirname(destinationPath)
  const stagingRoot = mkdtempSync(join(parentDir, '.sandchest-stage-'))
  const extractPath = join(stagingRoot, 'payload')
  mkdirSync(extractPath, { recursive: true })

  try {
    for (const entry of entries) {
      const targetPath = join(extractPath, entry.path)
      if (entry.type === 'directory') {
        mkdirSync(targetPath, { recursive: true })
        continue
      }

      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, entry.content ?? new Uint8Array())
    }

    renameSync(extractPath, destinationPath)
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

type GitCloneUrlValidationResult =
  | { ok: true; url: string }
  | { ok: false; code: 'invalid_url' | 'non_https' | 'embedded_credentials'; error: string }

function isScpStyleGitUrl(value: string): boolean {
  return /^[^@\s]+@[^:\s]+:.+$/.test(value)
}

function validateGitCloneUrl(
  rawUrl: string,
  options?: { allowNonHttps?: boolean | undefined },
): GitCloneUrlValidationResult {
  const url = rawUrl.trim()
  if (url === '') {
    return { ok: false, code: 'invalid_url', error: 'Git URL must not be empty.' }
  }

  if (isScpStyleGitUrl(url)) {
    if (options?.allowNonHttps) {
      return { ok: true, url }
    }
    return {
      ok: false,
      code: 'non_https',
      error: 'Only HTTPS URLs are allowed by default. Got: ssh-style URL. Set allow_non_https: true for SSH or git:// URLs.',
    }
  }

  if (!url.includes('://')) {
    return {
      ok: false,
      code: 'invalid_url',
      error: `Invalid git URL: ${url}. Use an HTTPS URL or an SSH-style URL such as git@github.com:org/repo.git.`,
    }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {
      ok: false,
      code: 'invalid_url',
      error: `Invalid git URL: ${url}.`,
    }
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      code: 'embedded_credentials',
      error:
        'URLs with embedded credentials (user:pass@host) are not allowed. Private-repo auth is intentionally deferred until Sandchest can inject credentials outside the guest boundary.',
    }
  }

  if (!options?.allowNonHttps && parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'non_https',
      error: `Only HTTPS URLs are allowed by default. Got: ${parsed.protocol.replace(/:$/, '')}://... Set allow_non_https: true for SSH or git:// URLs.`,
    }
  }

  return { ok: true, url }
}

function createGitArchive(localPath: string, archivePath: string): 'git-ls-files' {
  const repoRoot = execFileSync('git', ['-C', localPath, 'rev-parse', '--show-toplevel'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString('utf-8').trim()
  const repoPrefix = execFileSync('git', ['-C', localPath, 'rev-parse', '--show-prefix'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString('utf-8').trim()
  const scopePathspec = repoPrefix || '.'

  const stagedEntries = execFileSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '--stage', '-z', '--', scopePathspec],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const gitlinks = stagedEntries
    .toString('utf-8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const repoRelative = line.match(/^160000 [0-9a-f]+ \d\t(.+)$/)?.[1] ?? null
      if (repoRelative === null) {
        return null
      }
      return repoPrefix ? repoRelative.slice(repoPrefix.length) : repoRelative
    })
    .filter((value): value is string => value !== null)

  if (gitlinks.length > 0) {
    throw new Error(
      `Git submodules are not supported by sandbox_upload_dir yet. Refusing to archive gitlink paths: ${gitlinks.slice(0, 5).join(', ')}`,
    )
  }

  const filesOutput = execFileSync(
    'git',
    [
      '-C',
      repoRoot,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      scopePathspec,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const selectedFiles = filesOutput
    .toString('utf-8')
    .split('\0')
    .filter(Boolean)
    .map((repoRelativePath) => (repoPrefix ? repoRelativePath.slice(repoPrefix.length) : repoRelativePath))
  const existingFiles = selectedFiles.filter((selectedRelPath) => {
    try {
      const entry = lstatSync(join(localPath, selectedRelPath))
      if (entry.isSymbolicLink()) {
        throw new Error(
          `sandbox_upload_dir does not support symbolic links yet. Refusing to archive '${selectedRelPath}' because sandbox upload validation rejects link entries.`,
        )
      }
      if (!entry.isFile()) {
        throw new Error(
          `sandbox_upload_dir only supports regular files in git-aware uploads. Refusing to archive '${selectedRelPath}'.`,
        )
      }
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw error
    }
  })

  const fileListPath = join(tmpdir(), `.sandchest-filelist-${crypto.randomUUID()}`)
  try {
    writeFileSync(
      fileListPath,
      Buffer.from(existingFiles.length === 0 ? '' : `${existingFiles.join('\0')}\0`, 'utf-8'),
    )
    execFileSync('tar', ['czf', archivePath, '-C', localPath, '--null', '-T', fileListPath], {
      stdio: 'pipe',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
  } finally {
    rmSync(fileListPath, { force: true })
  }

  return 'git-ls-files'
}

function createTarArchive(localPath: string, archivePath: string, exclude: string[] = []): 'tar' {
  const tarArgs = ['czf', archivePath]
  for (const pattern of ['.git', 'node_modules', '__pycache__', '.venv', '.tox']) {
    tarArgs.push('--exclude', pattern)
  }
  for (const pattern of exclude) {
    tarArgs.push('--exclude', pattern)
  }
  tarArgs.push('-C', localPath, '.')
  execFileSync('tar', tarArgs, {
    stdio: 'pipe',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  return 'tar'
}

function createLocalArchive(
  localPath: string,
  archivePath: string,
  options?: { exclude?: string[] | undefined },
): 'git-ls-files' | 'tar' {
  try {
    execFileSync('git', ['-C', localPath, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' })
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: Buffer }).stderr ?? '')
        : ''
    if (stderr.includes('not a git repository')) {
      return createTarArchive(localPath, archivePath, options?.exclude)
    }
    throw error
  }

  return createGitArchive(localPath, archivePath)
}

function normalizeScopePrefix(prefix: string): string {
  return prefix.replace(/\/+$/, '')
}

function isWithinScope(repoPath: string, scopePrefix: string): boolean {
  return scopePrefix === '' || repoPath === scopePrefix || repoPath.startsWith(`${scopePrefix}/`)
}

function tokenizePatchFields(value: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let inQuotes = false
  let escaping = false

  for (const char of value) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }

    if (char === '\\') {
      escaping = true
      continue
    }

    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }

    if (!inQuotes && /\s/.test(char)) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (escaping || inQuotes) {
    return null
  }

  if (current !== '') {
    tokens.push(current)
  }

  return tokens
}

function formatPatchField(value: string): string {
  if (!/[\s"\\]/.test(value)) {
    return value
  }

  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function normalizeAbsolutePosixPath(value: string): string {
  const parts: string[] = []

  for (const part of value.split('/')) {
    if (part === '' || part === '.') {
      continue
    }

    if (part === '..') {
      parts.pop()
      continue
    }

    parts.push(part)
  }

  return `/${parts.join('/')}`
}

function normalizeRelativePosixPath(value: string): string | null {
  const parts: string[] = []

  for (const part of value.split('/')) {
    if (part === '' || part === '.') {
      continue
    }

    if (part === '..') {
      if (parts.length === 0) {
        return null
      }

      parts.pop()
      continue
    }

    parts.push(part)
  }

  return parts.join('/') || null
}

function normalizeRepoPath(rawPath: string, repoRoot: string): string | null {
  if (rawPath === '' || rawPath === '.' || rawPath === '/') {
    return null
  }

  let candidate = rawPath
  if (candidate.startsWith('./')) {
    candidate = candidate.slice(2)
  }

  if (candidate.startsWith('/')) {
    const normalizedRoot = normalizeAbsolutePosixPath(repoRoot)
    const normalizedCandidate = normalizeAbsolutePosixPath(candidate)

    if (
      normalizedCandidate === normalizedRoot ||
      !normalizedCandidate.startsWith(`${normalizedRoot}/`)
    ) {
      return null
    }

    return normalizedCandidate.slice(normalizedRoot.length + 1)
  }

  return normalizeRelativePosixPath(candidate)
}

function normalizePlainPatchPath(
  rawPath: string,
  repoRoot: string,
  scopePrefix: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (rawPath === '/dev/null') {
    return { ok: true, value: rawPath }
  }

  const normalized = normalizeRepoPath(rawPath, repoRoot)
  if (!normalized) {
    return { ok: false, error: `Patch references an unsafe path: ${rawPath}` }
  }

  if (!isWithinScope(normalized, scopePrefix)) {
    return { ok: false, error: `Patch references a path outside the requested scope: ${normalized}` }
  }

  return { ok: true, value: normalized }
}

function normalizePrefixedPatchPath(
  rawPath: string,
  prefix: 'a/' | 'b/',
  repoRoot: string,
  scopePrefix: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (rawPath === '/dev/null') {
    return { ok: true, value: rawPath }
  }

  const candidate = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath
  const normalized = normalizePlainPatchPath(candidate, repoRoot, scopePrefix)
  if (!normalized.ok) {
    return normalized
  }

  return { ok: true, value: `${prefix}${normalized.value}` }
}

function normalizeBinaryPatchPath(
  rawPath: string,
  fallbackPrefix: 'a/' | 'b/',
  repoRoot: string,
  scopePrefix: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (rawPath === '/dev/null') {
    return { ok: true, value: rawPath }
  }

  const prefix = rawPath.startsWith('a/')
    ? 'a/'
    : rawPath.startsWith('b/')
      ? 'b/'
      : fallbackPrefix
  return normalizePrefixedPatchPath(rawPath, prefix, repoRoot, scopePrefix)
}

function normalizePatchAgainstRepoRoot(
  patch: string,
  repoRoot: string,
  scopePrefix: string,
): { ok: true; patch: string } | { ok: false; error: string } {
  const lines = patch.split('\n')
  const normalizedLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const fields = tokenizePatchFields(line.slice('diff --git '.length))
      if (!fields || fields.length !== 2) {
        return { ok: false, error: 'Patch contains an unsupported diff header' }
      }

      const left = normalizePrefixedPatchPath(fields[0]!, 'a/', repoRoot, scopePrefix)
      if (!left.ok) return left
      const right = normalizePrefixedPatchPath(fields[1]!, 'b/', repoRoot, scopePrefix)
      if (!right.ok) return right

      normalizedLines.push(`diff --git ${formatPatchField(left.value)} ${formatPatchField(right.value)}`)
      continue
    }

    if (line.startsWith('--- ')) {
      const fields = tokenizePatchFields(line.slice(4))
      if (!fields || fields.length !== 1) {
        return { ok: false, error: 'Patch contains an unsupported --- header' }
      }

      const normalized = normalizePrefixedPatchPath(fields[0]!, 'a/', repoRoot, scopePrefix)
      if (!normalized.ok) return normalized
      normalizedLines.push(`--- ${formatPatchField(normalized.value)}`)
      continue
    }

    if (line.startsWith('+++ ')) {
      const fields = tokenizePatchFields(line.slice(4))
      if (!fields || fields.length !== 1) {
        return { ok: false, error: 'Patch contains an unsupported +++ header' }
      }

      const normalized = normalizePrefixedPatchPath(fields[0]!, 'b/', repoRoot, scopePrefix)
      if (!normalized.ok) return normalized
      normalizedLines.push(`+++ ${formatPatchField(normalized.value)}`)
      continue
    }

    if (line.startsWith('rename from ')) {
      const fields = tokenizePatchFields(line.slice('rename from '.length))
      if (!fields || fields.length !== 1) {
        return { ok: false, error: 'Patch contains an unsupported rename header' }
      }

      const normalized = normalizePlainPatchPath(fields[0]!, repoRoot, scopePrefix)
      if (!normalized.ok) return normalized
      normalizedLines.push(`rename from ${formatPatchField(normalized.value)}`)
      continue
    }

    if (line.startsWith('rename to ')) {
      const fields = tokenizePatchFields(line.slice('rename to '.length))
      if (!fields || fields.length !== 1) {
        return { ok: false, error: 'Patch contains an unsupported rename header' }
      }

      const normalized = normalizePlainPatchPath(fields[0]!, repoRoot, scopePrefix)
      if (!normalized.ok) return normalized
      normalizedLines.push(`rename to ${formatPatchField(normalized.value)}`)
      continue
    }

    if (line.startsWith('copy from ')) {
      const fields = tokenizePatchFields(line.slice('copy from '.length))
      if (!fields || fields.length !== 1) {
        return { ok: false, error: 'Patch contains an unsupported copy header' }
      }

      const normalized = normalizePlainPatchPath(fields[0]!, repoRoot, scopePrefix)
      if (!normalized.ok) return normalized
      normalizedLines.push(`copy from ${formatPatchField(normalized.value)}`)
      continue
    }

    if (line.startsWith('copy to ')) {
      const fields = tokenizePatchFields(line.slice('copy to '.length))
      if (!fields || fields.length !== 1) {
        return { ok: false, error: 'Patch contains an unsupported copy header' }
      }

      const normalized = normalizePlainPatchPath(fields[0]!, repoRoot, scopePrefix)
      if (!normalized.ok) return normalized
      normalizedLines.push(`copy to ${formatPatchField(normalized.value)}`)
      continue
    }

    if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      const fields = tokenizePatchFields(line.slice('Binary files '.length, -' differ'.length))
      if (!fields || fields.length !== 3 || fields[1] !== 'and') {
        return { ok: false, error: 'Patch contains an unsupported binary diff header' }
      }

      const left = normalizeBinaryPatchPath(fields[0]!, 'a/', repoRoot, scopePrefix)
      if (!left.ok) return left
      const right = normalizeBinaryPatchPath(fields[2]!, 'b/', repoRoot, scopePrefix)
      if (!right.ok) return right

      normalizedLines.push(`Binary files ${formatPatchField(left.value)} and ${formatPatchField(right.value)} differ`)
      continue
    }

    normalizedLines.push(line)
  }

  return { ok: true, patch: normalizedLines.join('\n') }
}

export function registerTools(server: McpServer, sandchest: Sandchest): void {
  server.registerTool('sandbox_create', {
    description:
      "Create a new isolated Linux sandbox (Firecracker microVM). Use this when you need a clean environment to run commands, install packages, clone repos, run tests, or execute any code safely. The sandbox is fully isolated — nothing you do affects the host. Returns a sandbox_id for use with other tools. The sandbox is ready to use immediately.",
    inputSchema: {
      image: z
        .string()
        .optional()
        .describe(
          "Image URI. Default: 'sandchest://ubuntu-22.04/base'. Options: 'sandchest://ubuntu-22.04/node-22', 'sandchest://ubuntu-22.04/python-3.12', 'sandchest://ubuntu-24.04/base'.",
        ),
      profile: z
        .enum(['small', 'medium', 'large'])
        .optional()
        .describe('Resource profile. small=2vCPU/4GB, medium=4vCPU/8GB, large=8vCPU/16GB. Default: small.'),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe('Environment variables to set in the sandbox.'),
    },
  }, async (args) => {
    const sb = await sandchest.create({
      image: args.image,
      profile: args.profile,
      env: args.env,
    })
    return jsonContent({ sandbox_id: sb.id, replay_url: sb.replayUrl })
  })

  server.registerTool('sandbox_exec', {
    description:
      'Execute a command in a sandbox. Returns exit code, stdout, and stderr. Use this for running build commands, tests, scripts, or any shell command. Commands run as root with full access to the sandbox filesystem. For multi-step workflows where commands depend on each other (cd, exports), use sandbox_session_create + sandbox_session_exec instead.',
    inputSchema: {
      sandbox_id: z.string().describe('The sandbox to execute in.'),
      cmd: z.string().describe('The command to run. Interpreted by /bin/sh.'),
      cwd: z.string().optional().describe('Working directory. Default: /root'),
      timeout: z.number().optional().describe('Timeout in seconds. Default: 300'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const result = await sb.exec(args.cmd, {
      cwd: args.cwd,
      timeout: args.timeout,
    })
    return jsonContent({
      exec_id: result.execId,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.durationMs,
    })
  })

  server.registerTool('sandbox_session_create', {
    description:
      'Create a persistent shell session where commands share state. Use this when you need multiple commands that depend on each other — like cd into a directory, then npm install, then npm test. Each command inherits the working directory, environment variables, and other shell state from previous commands. Prefer this over sandbox_exec for multi-step workflows.',
    inputSchema: {
      sandbox_id: z.string(),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const session = await sb.session.create()
    return jsonContent({ session_id: session.id })
  })

  server.registerTool('sandbox_session_exec', {
    description:
      'Run a command in a persistent session. The command inherits all prior state (working directory, environment variables, aliases) from previous commands in this session. Returns exit code, stdout, and stderr.',
    inputSchema: {
      sandbox_id: z.string(),
      session_id: z.string(),
      cmd: z.string().describe('The command to run in the session shell.'),
      timeout: z.number().optional().describe('Timeout in seconds. Default: 300'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const session = new Session(args.session_id, args.sandbox_id, sb._http)
    const result = await session.exec(args.cmd, {
      timeout: args.timeout,
    })
    return jsonContent({
      exec_id: result.execId,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.durationMs,
    })
  })

  server.registerTool('sandbox_fork', {
    description:
      "Create an instant copy of a running sandbox (memory + filesystem + all state). The original sandbox is untouched. The fork is a new, independent sandbox.\n\nUSE THIS WHEN:\n- You want to try something risky or experimental (the original stays safe)\n- You want to compare two approaches side by side\n- You're about to run a destructive command (rm, overwrite files, drop tables)\n- You've completed expensive setup (git clone + npm install) and want a checkpoint\n- You're less than 80% confident in your next approach\n\nFork is cheap and fast (<1 second). When in doubt, fork first.",
    inputSchema: {
      sandbox_id: z.string().describe('The sandbox to fork.'),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe('Additional environment variables for the fork.'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const fork = await sb.fork({ env: args.env })
    return jsonContent({
      sandbox_id: fork.id,
      forked_from: sb.id,
      replay_url: fork.replayUrl,
    })
  })

  server.registerTool('sandbox_upload', {
    description:
      'Upload a file to a sandbox. Use this to place source code, configuration files, or test data into the sandbox filesystem.',
    inputSchema: {
      sandbox_id: z.string(),
      path: z.string().describe('Destination path in the sandbox (e.g., /work/config.json)'),
      content: z.string().describe('File content (text). For binary files, use base64 encoding.'),
      encoding: z
        .enum(['utf-8', 'base64'])
        .optional()
        .describe('Content encoding. Default: utf-8'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const encoding = args.encoding ?? 'utf-8'
    let bytes: Uint8Array
    if (encoding === 'base64') {
      bytes = decodeBase64(args.content)
    } else {
      bytes = TEXT_ENCODER.encode(args.content)
    }
    await sb.fs.upload(args.path, bytes)
    return jsonContent({ ok: true })
  })

  server.registerTool('sandbox_upload_dir', {
    description:
      'Upload a local directory to a sandbox. Reads files from your local machine, respects .gitignore for git repos, validates the final archive, and extracts it in the sandbox. Disabled unless SANDCHEST_MCP_ALLOWED_PATHS allow-lists the local root.',
    inputSchema: {
      sandbox_id: z.string(),
      local_path: z.string().describe('Local directory to upload'),
      remote_path: z.string().optional().describe('Destination directory in the sandbox. Default: /work'),
      exclude: z
        .array(z.string())
        .optional()
        .describe('Extra exclude globs for non-git directories. Git repos use .gitignore instead.'),
      baseline: z
        .boolean()
        .optional()
        .describe('Initialize and commit a baseline git repo in the sandbox after upload. Default: false.'),
    },
  }, async (args) => {
    try {
      const sb = await sandchest.get(args.sandbox_id)
      const allowedRoots = parseAllowedRoots()
      if (allowedRoots.length === 0) {
        return jsonContent({
          ok: false,
          error: `sandbox_upload_dir is disabled until ${ALLOWED_PATHS_ENV} is set to one or more approved local roots.`,
        })
      }

      let localPath: string
      try {
        localPath = resolveExistingPath(args.local_path)
      } catch {
        return jsonContent({ ok: false, error: `Path does not exist or is not accessible: ${args.local_path}` })
      }

      if (!isWithinAllowedRoots(localPath, allowedRoots)) {
        return jsonContent({
          ok: false,
          error: `Path '${localPath}' is outside the allowed directories. Allowed: ${allowedRoots.join(', ')}.`,
        })
      }

      if (!statSync(localPath).isDirectory()) {
        return jsonContent({ ok: false, error: `Not a directory: ${localPath}` })
      }

      const remotePath = args.remote_path ?? '/work'
      const archivePath = join(tmpdir(), `.sandchest-upload-${crypto.randomUUID()}.tar.gz`)
      try {
        const method = createLocalArchive(localPath, archivePath, { exclude: args.exclude })
        validateArchiveFile(archivePath, 'sandbox_upload_dir')

        const tarball = new Uint8Array(readFileSync(archivePath))
        await sb.fs.uploadDir(remotePath, tarball)

        let baselineCreated: boolean | undefined
        if (args.baseline) {
          baselineCreated = false
          const init = await sb.exec(['git', '-C', remotePath, 'init'], { timeout: 10 })
          if (init.exitCode === 0) {
            const add = await sb.exec(['git', '-C', remotePath, 'add', '-A'], { timeout: 10 })
            if (add.exitCode === 0) {
              const commit = await sb.exec(
                [
                  'git',
                  '-C',
                  remotePath,
                  '-c',
                  'user.name=Sandchest',
                  '-c',
                  'user.email=sandchest@local',
                  'commit',
                  '-m',
                  'baseline',
                  '--allow-empty',
                ],
                { timeout: 10 },
              )
              baselineCreated = commit.exitCode === 0
            }
          }
        }

        return jsonContent({
          ok: true,
          local_path: localPath,
          remote_path: remotePath,
          method,
          bytes: tarball.byteLength,
          baseline_created: baselineCreated,
        })
      } finally {
        rmSync(archivePath, { force: true })
      }
    } catch (err) {
      if (err instanceof ExecFailedError) {
        return jsonContent({
          ok: false,
          error: err.message,
          stderr: err.stderr,
          exit_code: err.exitCode,
        })
      }
      if (err instanceof SandchestError) {
        return jsonContent({ ok: false, error: err.message, code: err.code })
      }
      return jsonContent({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  server.registerTool('sandbox_download', {
    description:
      'Download a file from a sandbox. Use this to retrieve output files, build artifacts, or read generated content.',
    inputSchema: {
      sandbox_id: z.string(),
      path: z.string().describe('File path in the sandbox'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const bytes = await sb.fs.download(args.path)
    let content: string
    let encoding: string
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      content = text
      encoding = 'utf-8'
    } catch {
      content = encodeBase64(bytes)
      encoding = 'base64'
    }
    return jsonContent({ content, encoding })
  })

  server.registerTool('sandbox_download_dir', {
    description:
      'Download a sandbox directory to a new local path. Validates the archive, extracts it into a staging directory, and atomically renames it into place. Disabled unless SANDCHEST_MCP_ALLOWED_PATHS allow-lists the destination root.',
    inputSchema: {
      sandbox_id: z.string(),
      remote_path: z.string().describe('Directory path in the sandbox'),
      local_path: z.string().describe('Destination directory on the local machine'),
    },
  }, async (args) => {
    try {
      const sb = await sandchest.get(args.sandbox_id)
      const allowedRoots = parseAllowedRoots()
      if (allowedRoots.length === 0) {
        return jsonContent({
          ok: false,
          error: `sandbox_download_dir is disabled until ${ALLOWED_PATHS_ENV} is set to one or more approved local roots.`,
        })
      }

      let localPath: string
      try {
        localPath = resolveFuturePath(args.local_path)
      } catch {
        return jsonContent({
          ok: false,
          error: `Parent directory does not exist or is not accessible: ${dirname(resolve(args.local_path))}`,
        })
      }

      if (!isWithinAllowedRoots(localPath, allowedRoots)) {
        return jsonContent({
          ok: false,
          error: `Path '${localPath}' is outside the allowed directories. Allowed: ${allowedRoots.join(', ')}.`,
        })
      }

      const tarball = await sb.fs.downloadDir(args.remote_path)
      extractArchiveToNewDirectory(tarball, localPath, 'sandbox_download_dir')

      return jsonContent({
        ok: true,
        remote_path: args.remote_path,
        local_path: localPath,
        bytes: tarball.byteLength,
      })
    } catch (err) {
      if (err instanceof ExecFailedError) {
        return jsonContent({
          ok: false,
          error: err.message,
          stderr: err.stderr,
          exit_code: err.exitCode,
        })
      }
      if (err instanceof SandchestError) {
        return jsonContent({ ok: false, error: err.message, code: err.code })
      }
      return jsonContent({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  server.registerTool('sandbox_git_clone', {
    description:
      'Clone a git repository into a sandbox. Public HTTPS URLs are allowed by default. Set allow_non_https to true for SSH or git:// URLs.',
    inputSchema: {
      sandbox_id: z.string(),
      url: z.string().describe('Repository URL to clone. Embedded credentials are rejected.'),
      dest: z.string().optional().describe('Destination path. Default: /work'),
      branch: z.string().optional().describe('Branch or tag to check out during clone.'),
      depth: z.number().int().positive().optional().describe('Shallow clone depth.'),
      single_branch: z
        .boolean()
        .optional()
        .describe('Default: true. Set to false to clone all branches.'),
      allow_non_https: z.boolean().optional().describe('Allow non-HTTPS clone URLs. Default: false.'),
    },
  }, async (args) => {
    const validated = validateGitCloneUrl(args.url, { allowNonHttps: args.allow_non_https })
    if (!validated.ok) {
      return jsonContent({
        ok: false,
        error: validated.error,
        code: validated.code,
      })
    }

    try {
      const sb = await sandchest.get(args.sandbox_id)
      const result = await sb.git.clone(validated.url, {
        dest: args.dest,
        branch: args.branch,
        depth: args.depth,
        singleBranch: args.single_branch,
      })
      return jsonContent({
        ok: true,
        exec_id: result.execId,
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: result.durationMs,
      })
    } catch (err) {
      if (err instanceof ExecFailedError) {
        return jsonContent({
          ok: false,
          error: err.message,
          stderr: err.stderr,
          exit_code: err.exitCode,
        })
      }
      if (err instanceof SandchestError) {
        return jsonContent({ ok: false, error: err.message, code: err.code })
      }
      return jsonContent({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  server.registerTool('sandbox_stop', {
    description:
      "Gracefully stop a sandbox. Collects any registered artifacts and flushes logs before shutdown. The sandbox's replay URL remains accessible after stopping.",
    inputSchema: {
      sandbox_id: z.string(),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    await sb.stop()
    return jsonContent({ ok: true, replay_url: sb.replayUrl })
  })

  server.registerTool('sandbox_list', {
    description: 'List your active sandboxes. Returns sandbox IDs, status, and replay URLs.',
    inputSchema: {
      status: z
        .enum(['running', 'stopped', 'failed'])
        .optional()
        .describe('Filter by status. Default: all.'),
    },
  }, async (args) => {
    const sandboxes = await sandchest.list({
      status: args.status,
    })
    return jsonContent({
      sandboxes: sandboxes.map((sb) => ({
        sandbox_id: sb.id,
        status: sb.status,
        replay_url: sb.replayUrl,
      })),
    })
  })

  server.registerTool('sandbox_destroy', {
    description:
      'Permanently destroy a sandbox and all its data. Unlike sandbox_stop (graceful shutdown), this is an immediate hard delete. The sandbox cannot be recovered. The replay URL will still be accessible. Use this to clean up sandboxes you no longer need.',
    inputSchema: {
      sandbox_id: z.string().describe('The sandbox to destroy.'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    await sb.destroy()
    return jsonContent({ ok: true, sandbox_id: sb.id })
  })

  server.registerTool('sandbox_artifacts_list', {
    description:
      'List all registered artifacts for a sandbox. Artifacts are files explicitly marked for collection (e.g., build outputs, test reports, coverage data). They persist after the sandbox is stopped and include download URLs.',
    inputSchema: {
      sandbox_id: z.string().describe('The sandbox to list artifacts for.'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const artifacts = await sb.artifacts.list()
    return jsonContent({
      artifacts: artifacts.map((a) => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        bytes: a.bytes,
        sha256: a.sha256,
        download_url: a.download_url,
        exec_id: a.exec_id,
        created_at: a.created_at,
      })),
    })
  })

  server.registerTool('sandbox_file_list', {
    description:
      'List files and directories at a path inside a sandbox. Returns names, types (file/directory), and sizes. Use this to explore the sandbox filesystem before downloading or modifying files.',
    inputSchema: {
      sandbox_id: z.string().describe('The sandbox to list files in.'),
      path: z.string().describe('Directory path to list (e.g., /root, /work).'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const entries = await sb.fs.ls(args.path)
    return jsonContent({
      entries: entries.map((e) => ({
        name: e.name,
        path: e.path,
        type: e.type,
        size_bytes: e.size_bytes,
      })),
    })
  })

  server.registerTool('sandbox_session_destroy', {
    description:
      'Destroy a persistent shell session. Use this to clean up sessions you no longer need. The sandbox itself is not affected.',
    inputSchema: {
      sandbox_id: z.string(),
      session_id: z.string().describe('The session to destroy.'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    const session = new Session(args.session_id, args.sandbox_id, sb._http)
    await session.destroy()
    return jsonContent({ ok: true })
  })

  server.registerTool('sandbox_replay', {
    description:
      'Get the replay URL for a sandbox. The replay URL is a permanent link showing everything that happened in the sandbox — every command, output, and file change. Share it for debugging, code review, or documentation. Works for both running and stopped sandboxes.',
    inputSchema: {
      sandbox_id: z.string().describe('The sandbox to get the replay URL for.'),
    },
  }, async (args) => {
    const sb = await sandchest.get(args.sandbox_id)
    return jsonContent({ sandbox_id: sb.id, replay_url: sb.replayUrl })
  })

  server.registerTool('sandbox_diff', {
    description:
      'Review or export changes from a sandbox git work tree. Requires the directory to be a git repo. `mode: "review"` returns tracked diff output and reports untracked files separately; it may truncate. `mode: "patch"` produces a git-apply-safe patch including untracked files and binary changes.',
    inputSchema: {
      sandbox_id: z.string(),
      path: z.string().optional().describe('Directory to diff. Default: /work'),
      staged: z.boolean().optional().describe('Show only staged changes. Default: false.'),
      mode: z.enum(['review', 'patch']).optional().describe('Default: review.'),
      max_lines: z.number().optional().describe('Maximum lines returned in review mode. Default: 5000.'),
      max_patch_bytes: z.number().optional().describe('Maximum patch size in bytes. Default: 10485760.'),
    },
  }, async (args) => {
    try {
      const sb = await sandchest.get(args.sandbox_id)
      const cwd = args.path ?? '/work'
      const mode = args.mode ?? 'review'

      const repoCheck = await sb.exec(['git', '-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
        timeout: 10,
      })
      if (repoCheck.exitCode !== 0) {
        return jsonContent({
          ok: false,
          diff: '',
          exit_code: repoCheck.exitCode,
          error:
            'Not a git repository. Initialize one first: `git init && git add -A && git -c user.name=Sandchest -c user.email=sandchest@local commit -m "baseline"`.',
        })
      }

      const repoRootRes = await sb.exec(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], {
        timeout: 10,
      })
      if (repoRootRes.exitCode !== 0) {
        return jsonContent({
          ok: false,
          diff: '',
          exit_code: repoRootRes.exitCode,
          error: 'Failed to resolve git repo root for sandbox_diff',
          stderr: repoRootRes.stderr,
        })
      }
      const repoRoot = repoRootRes.stdout.trim()

      const prefixRes = await sb.exec(['git', '-C', cwd, 'rev-parse', '--show-prefix'], {
        timeout: 10,
      })
      if (prefixRes.exitCode !== 0) {
        return jsonContent({
          ok: false,
          diff: '',
          exit_code: prefixRes.exitCode,
          error: 'Failed to resolve git path prefix for sandbox_diff',
          stderr: prefixRes.stderr,
        })
      }
      const scopePrefix = normalizeScopePrefix(prefixRes.stdout.trim())
      const scopePath = scopePrefix || '.'

      const headCheck = await sb.exec(['git', '-C', repoRoot, 'rev-parse', '--verify', 'HEAD'], {
        timeout: 10,
      })
      const hasHead = headCheck.exitCode === 0

      if (mode === 'patch') {
        const patchPath = `/tmp/.sandchest-diff-${crypto.randomUUID()}.patch`
        const untrackedPath = `/tmp/.sandchest-untracked-${crypto.randomUUID()}.txt`
        try {
          const trackedScript = !hasHead && !args.staged
            ? `set -eu
: > "$PATCH_PATH"
git -C "$REPO_ROOT" diff --cached --binary --full-index -- "$SCOPE_PATH" >> "$PATCH_PATH"
git -C "$REPO_ROOT" diff --binary --full-index -- "$SCOPE_PATH" >> "$PATCH_PATH"`
            : args.staged
              ? `set -eu
git -C "$REPO_ROOT" diff --cached --binary --full-index -- "$SCOPE_PATH" > "$PATCH_PATH"`
              : `set -eu
git -C "$REPO_ROOT" diff HEAD --binary --full-index -- "$SCOPE_PATH" > "$PATCH_PATH"`

          const trackedWrite = await sb.exec(['/bin/sh', '-lc', trackedScript], {
            timeout: 30,
            env: {
              PATCH_PATH: patchPath,
              REPO_ROOT: repoRoot,
              SCOPE_PATH: scopePath,
            },
          })
          if (trackedWrite.exitCode !== 0) {
            return jsonContent({
              ok: false,
              diff: '',
              exit_code: trackedWrite.exitCode,
              error: 'Failed to write tracked diff for sandbox_diff patch mode',
              stderr: trackedWrite.stderr,
            })
          }

          if (!args.staged) {
            const untrackedList = await sb.exec(
              [
                '/bin/sh',
                '-lc',
                'set -eu\ngit -C "$REPO_ROOT" ls-files --others --exclude-standard -z -- "$SCOPE_PATH" > "$UNTRACKED_PATH"',
              ],
              {
                timeout: 10,
                env: {
                  REPO_ROOT: repoRoot,
                  SCOPE_PATH: scopePath,
                  UNTRACKED_PATH: untrackedPath,
                },
              },
            )
            if (untrackedList.exitCode !== 0) {
              return jsonContent({
                ok: false,
                diff: '',
                exit_code: untrackedList.exitCode,
                error: 'Failed to collect untracked files for sandbox_diff patch mode',
                stderr: untrackedList.stderr,
              })
            }

            const appendUntracked = await sb.exec(
              [
                '/bin/sh',
                '-lc',
                `set -eu
if [ -s "$UNTRACKED_PATH" ]; then
  xargs -0 -I{} sh -c '
    git -C "$1" diff --no-index --binary --full-index -- /dev/null "$2" >> "$3"
    code=$?
    if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then
      exit "$code"
    fi
  ' sh "$REPO_ROOT" "{}" "$PATCH_PATH" < "$UNTRACKED_PATH"
fi`,
              ],
              {
                timeout: 30,
                env: {
                  PATCH_PATH: patchPath,
                  REPO_ROOT: repoRoot,
                  UNTRACKED_PATH: untrackedPath,
                },
              },
            )
            if (appendUntracked.exitCode !== 0) {
              return jsonContent({
                ok: false,
                diff: '',
                exit_code: appendUntracked.exitCode,
                error: 'Failed to build synthetic patch for untracked file',
                stderr: appendUntracked.stderr,
              })
            }
          }

          const sizeCheck = await sb.exec(['/bin/sh', '-lc', 'set -eu\nwc -c < "$PATCH_PATH"'], {
            timeout: 10,
            env: { PATCH_PATH: patchPath },
          })
          if (sizeCheck.exitCode !== 0) {
            return jsonContent({
              ok: false,
              diff: '',
              exit_code: sizeCheck.exitCode,
              error: 'Failed to measure patch size for sandbox_diff',
              stderr: sizeCheck.stderr,
            })
          }

          const totalBytes = Number(sizeCheck.stdout.trim())
          if (!Number.isFinite(totalBytes)) {
            return jsonContent({
              ok: false,
              diff: '',
              error: 'Failed to parse patch size for sandbox_diff',
            })
          }

          const maxPatchBytes = args.max_patch_bytes ?? 10_485_760
          if (totalBytes > maxPatchBytes) {
            return jsonContent({
              ok: false,
              diff: '',
              error: `Patch export exceeds max_patch_bytes (${maxPatchBytes}). Use sandbox_download_dir or narrow the diff scope.`,
              total_bytes: totalBytes,
              patch_safe: false,
            })
          }

          const patchBytes = await sb.fs.download(patchPath)
          const diffOutput = new TextDecoder('utf-8', { fatal: true }).decode(patchBytes)
          return jsonContent({
            ok: true,
            diff: diffOutput,
            exit_code: 0,
            mode,
            patch_safe: true,
            total_bytes: totalBytes,
            truncated: false,
            total_lines: diffOutput === '' ? 0 : diffOutput.split('\n').length,
            untracked_files: [],
          })
        } finally {
          await sb.exec(['rm', '-f', patchPath, untrackedPath], { timeout: 10 }).catch(() => {})
        }
      }

      const trackedResults = [] as Array<{ stdout: string; stderr: string; exitCode: number }>
      if (!hasHead && !args.staged) {
        trackedResults.push(
          await sb.exec(['git', '-C', repoRoot, 'diff', '--cached', '--', scopePath], {
            timeout: 30,
          }),
          await sb.exec(['git', '-C', repoRoot, 'diff', '--', scopePath], { timeout: 30 }),
        )
      } else {
        trackedResults.push(
          await sb.exec(
            args.staged
              ? ['git', '-C', repoRoot, 'diff', '--cached', '--', scopePath]
              : ['git', '-C', repoRoot, 'diff', 'HEAD', '--', scopePath],
            { timeout: 30 },
          ),
        )
      }

      const trackedFailure = trackedResults.find((result) => result.exitCode !== 0)
      if (trackedFailure) {
        return jsonContent({
          ok: false,
          diff: '',
          exit_code: trackedFailure.exitCode,
          error: 'git diff failed for sandbox_diff review mode',
          stderr: trackedFailure.stderr,
        })
      }

      const untracked = args.staged
        ? { stdout: '', stderr: '', exitCode: 0 }
        : await sb.exec(
          ['git', '-C', repoRoot, 'ls-files', '--others', '--exclude-standard', '-z', '--', scopePath],
          { timeout: 10 },
        )
      if (untracked.exitCode !== 0) {
        return jsonContent({
          ok: false,
          diff: '',
          exit_code: untracked.exitCode,
          error: 'Failed to collect untracked files for sandbox_diff review mode',
          stderr: untracked.stderr,
        })
      }

      const diffOutput = trackedResults.map((result) => result.stdout).join('')
      const lines = diffOutput === '' ? [] : diffOutput.split('\n')
      const maxLines = args.max_lines ?? 5000
      const transportTruncated = trackedResults.some(
        (result) =>
          result.stdout.length >= EXEC_OUTPUT_CAP_BYTES ||
          result.stderr.length >= EXEC_OUTPUT_CAP_BYTES,
      )
      const lineTruncated = lines.length > maxLines

      return jsonContent({
        ok: true,
        diff: lineTruncated ? lines.slice(0, maxLines).join('\n') : diffOutput,
        exit_code: 0,
        mode,
        patch_safe: false,
        truncated: lineTruncated || transportTruncated,
        transport_truncated: transportTruncated,
        total_lines: transportTruncated ? null : lines.length,
        untracked_files: untracked.stdout.split('\0').filter(Boolean),
      })
    } catch (err) {
      if (err instanceof ExecFailedError) {
        return jsonContent({
          ok: false,
          diff: '',
          error: err.message,
          stderr: err.stderr,
          exit_code: err.exitCode,
        })
      }
      if (err instanceof SandchestError) {
        return jsonContent({ ok: false, diff: '', error: err.message, code: err.code })
      }
      return jsonContent({
        ok: false,
        diff: '',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  server.registerTool('sandbox_apply_patch', {
    description:
      'Apply a unified diff to files in a sandbox. Uses `git apply --check` followed by `git apply` inside a git work tree. Non-git directories are rejected.',
    inputSchema: {
      sandbox_id: z.string(),
      patch: z
        .string()
        .max(10_485_760, 'Patch content exceeds 10 MB limit. Split it into smaller patches.'),
      path: z.string().optional().describe('Working directory for applying the patch. Default: /work'),
    },
  }, async (args) => {
    try {
      const sb = await sandchest.get(args.sandbox_id)
      const cwd = args.path ?? '/work'
      const patchPath = `/tmp/.sandchest-patch-${crypto.randomUUID()}.patch`

      try {
        const repoCheck = await sb.exec(['git', '-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
          timeout: 10,
        })
        if (repoCheck.exitCode !== 0) {
          return jsonContent({
            ok: false,
            error: 'sandbox_apply_patch currently requires a git work tree',
            stdout: repoCheck.stdout,
            stderr: repoCheck.stderr,
            exit_code: repoCheck.exitCode,
          })
        }

        const repoRootRes = await sb.exec(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], {
          timeout: 10,
        })
        if (repoRootRes.exitCode !== 0) {
          return jsonContent({
            ok: false,
            error: 'Failed to resolve git repo root for sandbox_apply_patch',
            stdout: repoRootRes.stdout,
            stderr: repoRootRes.stderr,
            exit_code: repoRootRes.exitCode,
          })
        }
        const repoRoot = repoRootRes.stdout.trim()
        const prefixRes = await sb.exec(['git', '-C', cwd, 'rev-parse', '--show-prefix'], {
          timeout: 10,
        })
        if (prefixRes.exitCode !== 0) {
          return jsonContent({
            ok: false,
            error: 'Failed to resolve git path prefix for sandbox_apply_patch',
            stdout: prefixRes.stdout,
            stderr: prefixRes.stderr,
            exit_code: prefixRes.exitCode,
          })
        }
        const scopePrefix = normalizeScopePrefix(prefixRes.stdout.trim())

        const normalizedPatch = normalizePatchAgainstRepoRoot(args.patch, repoRoot, scopePrefix)
        if (!normalizedPatch.ok) {
          return jsonContent({
            ok: false,
            error: normalizedPatch.error,
            method: 'git-apply',
          })
        }

        await sb.fs.upload(patchPath, new TextEncoder().encode(normalizedPatch.patch))

        const check = await sb.exec(['git', '-C', repoRoot, 'apply', '--check', patchPath], {
          timeout: 30,
        })
        if (check.exitCode !== 0) {
          return jsonContent({
            ok: false,
            error: 'git apply --check failed',
            stdout: check.stdout,
            stderr: check.stderr,
            exit_code: check.exitCode,
            method: 'git-apply',
          })
        }

        const applyResult = await sb.exec(
          ['git', '-C', repoRoot, 'apply', '--verbose', patchPath],
          { timeout: 30 },
        )
        if (applyResult.exitCode !== 0) {
          return jsonContent({
            ok: false,
            error: 'git apply failed',
            stdout: applyResult.stdout,
            stderr: applyResult.stderr,
            exit_code: applyResult.exitCode,
            method: 'git-apply',
          })
        }

        return jsonContent({
          ok: true,
          stdout: applyResult.stdout,
          stderr: applyResult.stderr,
          exit_code: applyResult.exitCode,
          method: 'git-apply',
        })
      } finally {
        await sb.exec(['rm', '-f', patchPath], { timeout: 10 }).catch(() => {})
      }
    } catch (err) {
      if (err instanceof ExecFailedError) {
        return jsonContent({
          ok: false,
          error: err.message,
          stderr: err.stderr,
          exit_code: err.exitCode,
        })
      }
      if (err instanceof SandchestError) {
        return jsonContent({ ok: false, error: err.message, code: err.code })
      }
      return jsonContent({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
