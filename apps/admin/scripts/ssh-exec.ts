#!/usr/bin/env bun
/**
 * Execute a command on the Sandchest node server via SSH.
 * Uses the admin app's DB + encrypted SSH key.
 *
 * Usage: bun run apps/admin/scripts/ssh-exec.ts "command here"
 *    or: bun run apps/admin/scripts/ssh-exec.ts --script path/to/script.sh
 */
import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { getDb } from '../src/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '../src/lib/encryption'
import { createSshConnection, execCommand } from '../src/lib/ssh'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('Usage: bun run apps/admin/scripts/ssh-exec.ts "command"')
  console.error('       bun run apps/admin/scripts/ssh-exec.ts --script path/to/script.sh')
  process.exit(1)
}

let command: string
if (args[0] === '--script') {
  const scriptPath = args[1]
  if (!scriptPath) {
    console.error('Missing script path')
    process.exit(1)
  }
  const script = await Bun.file(scriptPath).text()
  const scriptB64 = Buffer.from(script).toString('base64')
  command = `echo '${scriptB64}' | base64 -d > /tmp/_ssh_exec.sh && chmod +x /tmp/_ssh_exec.sh && /tmp/_ssh_exec.sh; EXIT=$?; rm -f /tmp/_ssh_exec.sh; exit $EXIT`
} else {
  command = args.join(' ')
}

const db = getDb()
const servers = await db.select().from(adminServers).limit(1)
if (servers.length === 0) {
  console.error('No servers found in admin DB')
  process.exit(1)
}
const server = servers[0]

const sshKey = decrypt(server.sshKeyEncrypted, server.sshKeyIv, server.sshKeyTag)
const conn = await createSshConnection({
  host: server.ip,
  port: server.sshPort,
  username: server.sshUser,
  privateKey: sshKey,
})

const timeoutMs = parseInt(process.env.SSH_TIMEOUT ?? '120000', 10)
const result = await execCommand(conn, command, timeoutMs)

process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)

conn.end()
process.exit(result.code)
