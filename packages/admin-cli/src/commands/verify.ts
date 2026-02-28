import { Command } from 'commander'
import chalk from 'chalk'
import { readConfig } from '../config.js'
import { exec } from '../shell.js'
import { createSshConnection, execCommand, sshConfigFromAdmin } from '../ssh.js'
import { header, success, error, warn, handleError } from '../output.js'

interface Check {
  name: string
  run: () => Promise<boolean>
}

export function verifyCommand(): Command {
  return new Command('verify')
    .description('Run end-to-end deployment verification checks')
    .action(async () => {
      try {
        const config = readConfig()
        let passed = 0
        let failed = 0

        const checks: Check[] = [
          {
            name: 'API health',
            run: async () => {
              const baseUrl = config.api?.baseUrl
              if (!baseUrl) { warn('api.baseUrl not configured'); return false }
              const result = await exec('curl', ['-sf', '-o', '/dev/null', '-w', '%{http_code}', `${baseUrl}/health`])
              return result.stdout.trim() === '200'
            },
          },
          {
            name: 'API readiness (Redis + dependencies)',
            run: async () => {
              const baseUrl = config.api?.baseUrl
              if (!baseUrl) return false
              const result = await exec('curl', ['-sf', `${baseUrl}/readyz`])
              if (result.code !== 0) return false
              try {
                const body = JSON.parse(result.stdout.trim())
                if (body.checks?.redis === 'fail') {
                  warn('Redis health check failed')
                  return false
                }
                if (body.checks?.shutdown === 'draining') {
                  warn('API is draining (shutting down)')
                  return false
                }
                return body.status === 'ok'
              } catch {
                return false
              }
            },
          },
          {
            name: 'SSH connectivity',
            run: async () => {
              if (!config.hetzner?.host || !config.hetzner.sshKeyPath) return false
              try {
                const conn = await createSshConnection(sshConfigFromAdmin(config))
                const result = await execCommand(conn, 'echo ok')
                conn.end()
                return result.stdout.trim() === 'ok'
              } catch {
                return false
              }
            },
          },
          {
            name: 'Node daemon active',
            run: async () => {
              if (!config.hetzner?.host || !config.hetzner.sshKeyPath) return false
              try {
                const conn = await createSshConnection(sshConfigFromAdmin(config))
                const result = await execCommand(conn, 'systemctl is-active sandchest-node')
                conn.end()
                return result.stdout.trim() === 'active'
              } catch {
                return false
              }
            },
          },
          {
            name: 'KVM available',
            run: async () => {
              if (!config.hetzner?.host || !config.hetzner.sshKeyPath) return false
              try {
                const conn = await createSshConnection(sshConfigFromAdmin(config))
                const result = await execCommand(conn, 'test -w /dev/kvm && echo yes || echo no')
                conn.end()
                return result.stdout.trim() === 'yes'
              } catch {
                return false
              }
            },
          },
          {
            name: 'DNS api.sandchest.com',
            run: async () => {
              const result = await exec('dig', ['+short', 'api.sandchest.com'])
              return result.code === 0 && result.stdout.trim().length > 0
            },
          },
          {
            name: 'DNS node.sandchest.com',
            run: async () => {
              const hetznerHost = config.hetzner?.host
              if (!hetznerHost) return false
              const result = await exec('dig', ['+short', 'node.sandchest.com'])
              return result.code === 0 && result.stdout.trim().includes(hetznerHost)
            },
          },
        ]

        header('Deployment Verification')
        console.log()

        for (const check of checks) {
          try {
            const ok = await check.run()
            if (ok) {
              console.log(`  ${chalk.green('PASS')}  ${check.name}`)
              passed++
            } else {
              console.log(`  ${chalk.red('FAIL')}  ${check.name}`)
              failed++
            }
          } catch {
            console.log(`  ${chalk.red('FAIL')}  ${check.name}`)
            failed++
          }
        }

        console.log()
        if (failed === 0) {
          success(`All ${passed} checks passed`)
        } else {
          error(`${failed} of ${passed + failed} checks failed`)
          process.exit(1)
        }
      } catch (err) {
        handleError(err)
      }
    })
}
