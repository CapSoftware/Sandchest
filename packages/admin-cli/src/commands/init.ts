import { Command } from 'commander'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { readConfig, writeConfig, getConfigPath, type AdminConfig } from '../config.js'
import { success, info, warn, error } from '../output.js'

function prompt(rl: ReturnType<typeof createInterface>, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : ''
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

export function initCommand(): Command {
  return new Command('init')
    .description('Interactive config setup')
    .action(async () => {
      const existing = readConfig()
      info(`Config path: ${getConfigPath()}`)

      const rl = createInterface({ input: process.stdin, output: process.stdout })

      try {
        console.log('\nHetzner bare metal server:')
        const host = await prompt(rl, 'Host (IP or hostname)', existing.hetzner?.host)
        const sshKeyPath = await prompt(rl, 'SSH private key path', existing.hetzner?.sshKeyPath ?? '~/.ssh/id_ed25519')
        const sshUser = await prompt(rl, 'SSH user', existing.hetzner?.sshUser ?? 'root')
        const sshPort = await prompt(rl, 'SSH port', String(existing.hetzner?.sshPort ?? 22))

        if (sshKeyPath && !existsSync(sshKeyPath.replace(/^~/, process.env['HOME'] ?? ''))) {
          warn(`SSH key not found at ${sshKeyPath}`)
        }

        console.log('\nFly.io:')
        const flyAppName = await prompt(rl, 'App name', existing.fly?.appName ?? 'sandchest-api')
        const flyRegion = await prompt(rl, 'Region', existing.fly?.region ?? 'fra')
        const flyOrg = await prompt(rl, 'Organization', existing.fly?.org ?? 'personal')

        console.log('\nCloudflare R2:')
        const r2Endpoint = await prompt(rl, 'Endpoint URL', existing.r2?.endpoint)
        const r2AccessKeyId = await prompt(rl, 'Access Key ID', existing.r2?.accessKeyId)
        const r2SecretAccessKey = await prompt(rl, 'Secret Access Key', existing.r2?.secretAccessKey ? '••••••••' : undefined)
        const r2Bucket = await prompt(rl, 'Bucket name', existing.r2?.bucket ?? 'sandchest')

        console.log('\nDatabase:')
        const dbUrl = await prompt(rl, 'DATABASE_URL', existing.db?.url ? '••••••••' : undefined)

        console.log('\nNode daemon:')
        const nodeId = await prompt(rl, 'Node ID', existing.node?.id ?? 'node-hel1-01')
        const grpcPort = await prompt(rl, 'gRPC port', String(existing.node?.grpcPort ?? 50051))
        const outboundIface = await prompt(rl, 'Outbound network interface', existing.node?.outboundIface ?? 'eth0')

        console.log('\nAPI:')
        const apiBaseUrl = await prompt(rl, 'API base URL', existing.api?.baseUrl ?? 'https://api.sandchest.com')

        const config: AdminConfig = {
          hetzner: {
            host: host || undefined,
            sshKeyPath: sshKeyPath || undefined,
            sshUser: sshUser || undefined,
            sshPort: parseInt(sshPort, 10) || undefined,
          },
          fly: {
            appName: flyAppName || undefined,
            region: flyRegion || undefined,
            org: flyOrg || undefined,
          },
          r2: {
            endpoint: r2Endpoint || existing.r2?.endpoint,
            accessKeyId: r2AccessKeyId || existing.r2?.accessKeyId,
            secretAccessKey: r2SecretAccessKey === '••••••••' ? existing.r2?.secretAccessKey : (r2SecretAccessKey || undefined),
            bucket: r2Bucket || undefined,
          },
          db: {
            url: dbUrl === '••••••••' ? existing.db?.url : (dbUrl || undefined),
          },
          certs: existing.certs,
          node: {
            id: nodeId || undefined,
            grpcPort: parseInt(grpcPort, 10) || undefined,
            outboundIface: outboundIface || undefined,
          },
          api: {
            baseUrl: apiBaseUrl || undefined,
          },
        }

        writeConfig(config)
        success(`Config written to ${getConfigPath()} (mode 0600)`)
      } catch (err) {
        if (err instanceof Error && err.message.includes('readline was closed')) {
          error('Setup cancelled.')
          process.exit(1)
        }
        throw err
      } finally {
        rl.close()
      }
    })
}
