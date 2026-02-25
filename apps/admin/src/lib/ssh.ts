import { Client } from 'ssh2'
import { generateKeyPairSync, createPublicKey, createPrivateKey } from 'node:crypto'

export interface SshConfig {
  host: string
  port: number
  username: string
  privateKey: string
  readyTimeout?: number | undefined
}

export interface PasswordSshConfig {
  host: string
  port: number
  username: string
  password: string
}

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

export function createSshConnection(config: SshConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn
      .on('ready', () => resolve(conn))
      .on('error', (err) => reject(err))
      .connect({
        host: config.host,
        port: config.port,
        username: config.username,
        privateKey: config.privateKey,
        readyTimeout: config.readyTimeout ?? 15_000,
      })
  })
}

export function createPasswordSshConnection(config: PasswordSshConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn
      .on('ready', () => resolve(conn))
      .on('error', (err) => reject(err))
      .connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        readyTimeout: 15_000,
      })
  })
}

/**
 * Generates an ed25519 key pair, installs the public key on the remote server
 * via an existing SSH connection, and returns the private key PEM string.
 */
export async function generateAndInstallKey(conn: Client): Promise<string> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  // Convert PEM public key to OpenSSH format for authorized_keys
  const pubKeyObj = createPublicKey(publicKey)
  const sshPubKey = pubKeyObj.export({ type: 'spki', format: 'der' })
  // ed25519 DER SPKI: 12-byte header + 32-byte key
  const rawKey = (sshPubKey as Buffer).subarray(12)

  // Build OpenSSH public key format: "ssh-ed25519 <base64>"
  const keyType = Buffer.from('ssh-ed25519')
  const buf = Buffer.alloc(4 + keyType.length + 4 + rawKey.length)
  let offset = 0
  buf.writeUInt32BE(keyType.length, offset); offset += 4
  keyType.copy(buf, offset); offset += keyType.length
  buf.writeUInt32BE(rawKey.length, offset); offset += 4
  rawKey.copy(buf, offset)
  const authorizedKey = `ssh-ed25519 ${buf.toString('base64')} sandchest-admin`

  // Install the key on the remote host
  const installCmd = [
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    'chmod 600 ~/.ssh/authorized_keys',
    `echo '${authorizedKey}' >> ~/.ssh/authorized_keys`,
  ].join(' && ')

  const result = await execCommand(conn, installCmd)
  if (result.code !== 0) {
    throw new Error(`Failed to install SSH key: ${result.stderr}`)
  }

  // Re-export as OpenSSH wire format — ssh2 can't parse PKCS8 ed25519 reliably
  return pkcs8ToOpensshEd25519(privateKey)
}

export function execCommand(conn: Client, cmd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) {
        reject(err)
        return
      }

      let stdout = ''
      let stderr = ''

      stream.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      stream.on('close', (code: number) => {
        resolve({ stdout, stderr, code: code ?? 0 })
      })
      stream.on('error', (streamErr: Error) => {
        reject(streamErr)
      })
    })
  })
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function lengthPrefixed(data: Buffer): Buffer {
  return Buffer.concat([uint32(data.length), data])
}

/**
 * Convert a PKCS8 PEM ed25519 private key to OpenSSH format.
 * ssh2 reliably parses OpenSSH format but fails on PKCS8 ed25519.
 */
function pkcs8ToOpensshEd25519(pkcs8Pem: string): string {
  const privKeyObj = createPrivateKey(pkcs8Pem)
  const privDer = privKeyObj.export({ type: 'pkcs8', format: 'der' })
  // ed25519 PKCS8 DER: 16-byte header + 32-byte seed
  const seed = (privDer as Buffer).subarray(16, 48)

  const pubDer = createPublicKey(pkcs8Pem).export({ type: 'spki', format: 'der' })
  const pubRaw = (pubDer as Buffer).subarray(12) // 12-byte SPKI header + 32-byte pubkey

  const kt = Buffer.from('ssh-ed25519')
  const checkInt = Math.floor(Math.random() * 0xFFFFFFFF)
  const check = uint32(checkInt)

  const comment = Buffer.from('sandchest-admin')
  const privPayload = Buffer.concat([
    check, check,
    lengthPrefixed(kt),
    lengthPrefixed(pubRaw),
    lengthPrefixed(Buffer.concat([seed, pubRaw])),
    lengthPrefixed(comment),
  ])

  // Pad to 8-byte block
  const rem = privPayload.length % 8
  const padLen = rem === 0 ? 0 : 8 - rem
  const padding = Buffer.alloc(padLen)
  for (let i = 0; i < padLen; i++) padding[i] = i + 1
  const paddedPriv = Buffer.concat([privPayload, padding])

  const none = Buffer.from('none')
  const pubSection = Buffer.concat([lengthPrefixed(kt), lengthPrefixed(pubRaw)])

  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    lengthPrefixed(none),
    lengthPrefixed(none),
    lengthPrefixed(Buffer.alloc(0)),
    uint32(1),
    lengthPrefixed(pubSection),
    lengthPrefixed(paddedPriv),
  ])

  const b64 = blob.toString('base64')
  const lines = b64.match(/.{1,70}/g) ?? [b64]
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}
