import { Client } from 'ssh2'
import { readFileSync } from 'node:fs'
import type { AdminConfig } from './config.js'

export interface SshConfig {
  host: string
  port: number
  username: string
  privateKey: string
  readyTimeout?: number | undefined
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

export function execCommandStreaming(
  conn: Client,
  cmd: string,
  onStdout: (data: string) => void,
  onStderr: (data: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      stream.on('data', (data: Buffer) => onStdout(data.toString()))
      stream.stderr.on('data', (data: Buffer) => onStderr(data.toString()))
      stream.on('close', (code: number) => resolve(code ?? 0))
      stream.on('error', (streamErr: Error) => reject(streamErr))
    })
  })
}

export function scpFile(conn: Client, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) {
        reject(err)
        return
      }
      const data = readFileSync(localPath)
      sftp.writeFile(remotePath, data, (writeErr) => {
        sftp.end()
        if (writeErr) {
          reject(writeErr)
          return
        }
        resolve()
      })
    })
  })
}

export function sshConfigFromAdmin(config: AdminConfig): SshConfig {
  const hetzner = config.hetzner
  if (!hetzner?.host || !hetzner.sshKeyPath) {
    throw new Error("Missing hetzner.host or hetzner.sshKeyPath in config. Run 'sandchest-admin init' first.")
  }
  return {
    host: hetzner.host,
    port: hetzner.sshPort ?? 22,
    username: hetzner.sshUser ?? 'root',
    privateKey: readFileSync(hetzner.sshKeyPath, 'utf-8'),
  }
}
