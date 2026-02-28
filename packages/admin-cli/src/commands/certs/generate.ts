import { Command } from 'commander'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { readConfig, writeConfig } from '../../config.js'
import { exec } from '../../shell.js'
import { success, step, error, handleError } from '../../output.js'

export function certsGenerateCommand(): Command {
  return new Command('generate')
    .description('Generate CA + server + client mTLS certificates')
    .option('--output-dir <dir>', 'Output directory for certificates', './certs')
    .option('--server-cn <cn>', 'Server Common Name', 'sandchest-node')
    .option('--client-cn <cn>', 'Client Common Name', 'sandchest-api')
    .option('--days <n>', 'Certificate validity in days', '365')
    .option('--san <san>', 'Subject Alternative Names (comma-separated IPs/DNSes)')
    .action(async (opts: { outputDir: string; serverCn: string; clientCn: string; days: string; san?: string }) => {
      try {
        const outDir = resolve(opts.outputDir)
        mkdirSync(outDir, { recursive: true })

        const days = opts.days
        const config = readConfig()
        const hetznerHost = config.hetzner?.host

        // Build SAN extension
        const sanEntries: string[] = []
        if (opts.san) {
          for (const entry of opts.san.split(',')) {
            const trimmed = entry.trim()
            if (/^\d+\.\d+\.\d+\.\d+$/.test(trimmed)) {
              sanEntries.push(`IP:${trimmed}`)
            } else {
              sanEntries.push(`DNS:${trimmed}`)
            }
          }
        }
        if (hetznerHost && !sanEntries.some((s) => s.includes(hetznerHost))) {
          if (/^\d+\.\d+\.\d+\.\d+$/.test(hetznerHost)) {
            sanEntries.push(`IP:${hetznerHost}`)
          } else {
            sanEntries.push(`DNS:${hetznerHost}`)
          }
        }
        if (sanEntries.length === 0) {
          sanEntries.push(`DNS:${opts.serverCn}`)
        }
        const sanExt = `-addext "subjectAltName=${sanEntries.join(',')}"`

        // 1. CA key + cert
        step('[1/6]', 'Generating CA private key...')
        let result = await exec('openssl', ['genrsa', '-out', `${outDir}/ca.key`, '4096'])
        if (result.code !== 0) { error(result.stderr); process.exit(1) }

        step('[2/6]', 'Generating CA certificate...')
        result = await exec('openssl', [
          'req', '-new', '-x509', '-days', days, '-key', `${outDir}/ca.key`,
          '-out', `${outDir}/ca.pem`, '-subj', '/CN=sandchest-ca',
        ])
        if (result.code !== 0) { error(result.stderr); process.exit(1) }

        // 2. Server key + CSR + cert
        step('[3/6]', 'Generating server private key...')
        result = await exec('openssl', ['genrsa', '-out', `${outDir}/server.key`, '2048'])
        if (result.code !== 0) { error(result.stderr); process.exit(1) }

        step('[4/6]', 'Generating server certificate...')
        // Use a shell command for SAN extension which requires -addext
        result = await exec('sh', [
          '-c',
          `openssl req -new -key "${outDir}/server.key" -subj "/CN=${opts.serverCn}" ${sanExt} | openssl x509 -req -days ${days} -CA "${outDir}/ca.pem" -CAkey "${outDir}/ca.key" -CAcreateserial -out "${outDir}/server.pem" -copy_extensions copy`,
        ])
        if (result.code !== 0) { error(result.stderr); process.exit(1) }

        // 3. Client key + CSR + cert
        step('[5/6]', 'Generating client private key...')
        result = await exec('openssl', ['genrsa', '-out', `${outDir}/client.key`, '2048'])
        if (result.code !== 0) { error(result.stderr); process.exit(1) }

        step('[6/6]', 'Generating client certificate...')
        result = await exec('sh', [
          '-c',
          `openssl req -new -key "${outDir}/client.key" -subj "/CN=${opts.clientCn}" | openssl x509 -req -days ${days} -CA "${outDir}/ca.pem" -CAkey "${outDir}/ca.key" -CAcreateserial -out "${outDir}/client.pem"`,
        ])
        if (result.code !== 0) { error(result.stderr); process.exit(1) }

        // Update config with certs dir
        const updatedConfig = readConfig()
        updatedConfig.certs = { dir: outDir }
        writeConfig(updatedConfig)

        success(`6 certificate files written to ${outDir}`)
        console.log(`  ca.key, ca.pem, server.key, server.pem, client.key, client.pem`)
      } catch (err) {
        handleError(err)
      }
    })
}
