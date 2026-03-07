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
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Command } from 'commander'
import { getClient } from '../config.js'
import { handleError, printJson, success } from '../output.js'

type ArchiveEntryType = 'file' | 'directory'

type ArchiveEntry = {
  path: string
  type: ArchiveEntryType
  content?: Uint8Array
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

function listArchiveEntries(bytes: Uint8Array, operation: 'copy up' | 'copy down'): ArchiveEntry[] {
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
      throw new Error(`Tarball contains unsafe path during ${operation}: ${headerPath}`)
    }

    const kind =
      typeFlag === '' || typeFlag === '\0' || typeFlag === '0'
        ? 'file'
        : typeFlag === '5'
          ? 'directory'
          : null

    if (kind === null) {
      throw new Error(`Tarball contains unsupported entry type '${typeFlag}' during ${operation}: ${headerPath}`)
    }

    if (normalizedPath === '') {
      if (kind !== 'directory') {
        throw new Error(`Tarball contains unsafe path during ${operation}: ${headerPath}`)
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

function validateArchiveFile(archivePath: string, operation: 'copy up' | 'copy down'): ArchiveEntry[] {
  return listArchiveEntries(new Uint8Array(readFileSync(archivePath)), operation)
}

function validateArchiveBytes(tarball: Uint8Array, operation: 'copy up' | 'copy down'): ArchiveEntry[] {
  return listArchiveEntries(tarball, operation)
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
      `Git submodules are not supported by sandchest copy up yet. Refusing to archive gitlink paths: ${gitlinks.slice(0, 5).join(', ')}`,
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
          `sandchest copy up does not support symbolic links yet. Refusing to archive '${selectedRelPath}' because sandbox upload validation rejects link entries.`,
        )
      }
      if (!entry.isFile()) {
        throw new Error(
          `sandchest copy up only supports regular files in git-aware uploads. Refusing to archive '${selectedRelPath}'.`,
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
  options: { gitignore?: boolean | undefined; exclude?: string[] | undefined },
): 'git-ls-files' | 'tar' {
  if (options.gitignore !== false) {
    try {
      execFileSync('git', ['-C', localPath, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' })
      return createGitArchive(localPath, archivePath)
    } catch (error) {
      const stderr =
        error instanceof Error && 'stderr' in error
          ? String((error as { stderr?: Buffer }).stderr ?? '')
          : ''
      if (!stderr.includes('not a git repository')) {
        throw error
      }
    }
  }

  return createTarArchive(localPath, archivePath, options.exclude)
}

export function extractSandboxTarballToNewDirectory(
  tarball: Uint8Array,
  destinationPath: string,
): void {
  if (existsSync(destinationPath)) {
    throw new Error(`Destination already exists: ${destinationPath}. copy down requires a new directory to avoid overwriting local files.`)
  }

  const entries = validateArchiveBytes(tarball, 'copy down')

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

export function copyCommand(): Command {
  const copy = new Command('copy').description('Copy directories to and from a sandbox')

  copy
    .command('up')
    .description('Copy a local directory into a sandbox')
    .argument('<sandbox_id>', 'Sandbox ID')
    .argument('<local_path>', 'Local directory path')
    .argument('[remote_path]', 'Destination directory in the sandbox', '/work')
    .option('--no-gitignore', 'Do not respect .gitignore for git repos')
    .option('--exclude <pattern>', 'Exclude pattern for non-git directories', (value, previous: string[]) => {
      return [...previous, value]
    }, [])
    .option('--json', 'Output as JSON')
    .action(
      async (
        sandboxId: string,
        localPathArg: string,
        remotePath: string,
        options: { gitignore?: boolean; exclude: string[]; json?: boolean },
      ) => {
        try {
          const localPath = realpathSync(resolve(localPathArg))
          if (!statSync(localPath).isDirectory()) {
            throw new Error(`Not a directory: ${localPath}`)
          }

          const archivePath = join(tmpdir(), `.sandchest-copy-${crypto.randomUUID()}.tar.gz`)
          try {
            const method = createLocalArchive(localPath, archivePath, {
              gitignore: options.gitignore,
              exclude: options.exclude,
            })
            validateArchiveFile(archivePath, 'copy up')

            const tarball = new Uint8Array(readFileSync(archivePath))
            const client = getClient()
            const sandbox = await client.get(sandboxId)
            await sandbox.fs.uploadDir(remotePath, tarball)

            if (options.json) {
              printJson({
                ok: true,
                local_path: localPath,
                remote_path: remotePath,
                bytes: tarball.byteLength,
                method,
              })
            } else {
              success(`Copied ${localPath} → ${remotePath} (${tarball.byteLength} bytes, ${method})`)
            }
          } finally {
            rmSync(archivePath, { force: true })
          }
        } catch (err) {
          handleError(err)
        }
      },
    )

  copy
    .command('down')
    .description('Copy a sandbox directory to a new local directory')
    .argument('<sandbox_id>', 'Sandbox ID')
    .argument('<remote_path>', 'Directory path in the sandbox')
    .argument('<local_path>', 'Local destination directory (must not exist)')
    .option('--json', 'Output as JSON')
    .action(
      async (
        sandboxId: string,
        remotePath: string,
        localPathArg: string,
        options: { json?: boolean },
      ) => {
        try {
          const client = getClient()
          const sandbox = await client.get(sandboxId)
          const localPath = resolve(localPathArg)
          const tarball = await sandbox.fs.downloadDir(remotePath)
          extractSandboxTarballToNewDirectory(tarball, localPath)

          if (options.json) {
            printJson({
              ok: true,
              remote_path: remotePath,
              local_path: localPath,
              bytes: tarball.byteLength,
            })
          } else {
            success(`Copied ${remotePath} → ${localPath} (${tarball.byteLength} bytes)`)
          }
        } catch (err) {
          handleError(err)
        }
      },
    )

  return copy
}
