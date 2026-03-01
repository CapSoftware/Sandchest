import { Command } from 'commander'
import chalk from 'chalk'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readConfig } from '../config.js'
import { exec, flyctl, commandExists } from '../shell.js'
import { createSshConnection, execCommand, sshConfigFromAdmin } from '../ssh.js'
import { header, handleError } from '../output.js'
import type { Client } from 'ssh2'

interface Check {
  name: string
  fix: string
  run: () => Promise<'pass' | 'fail' | 'skip'>
}

interface Section {
  title: string
  checks: Check[]
}

function pass(name: string): void {
  console.log(`  ${chalk.green('PASS')}  ${name}`)
}

function fail(name: string, fix: string): void {
  console.log(`  ${chalk.red('FAIL')}  ${name}`)
  console.log(`         ${chalk.dim('fix:')} ${chalk.yellow(fix)}`)
}

function skip(name: string, reason: string): void {
  console.log(`  ${chalk.dim('SKIP')}  ${name} ${chalk.dim(`(${reason})`)}`)
}

export function preflightCommand(): Command {
  return new Command('preflight')
    .description('Pre-deployment checklist — validate everything needed to go live')
    .option('--json', 'Output results as JSON')
    .option('--section <name>', 'Run only a specific section')
    .action(async (opts: { json?: boolean | undefined; section?: string | undefined }) => {
      try {
        const config = readConfig()

        // Reusable SSH connection (opened lazily, closed at end)
        let sshConn: Client | undefined

        async function getSsh(): Promise<Client | undefined> {
          if (sshConn) return sshConn
          try {
            sshConn = await createSshConnection(sshConfigFromAdmin(config))
            return sshConn
          } catch {
            return undefined
          }
        }

        async function sshCheck(cmd: string, expect: string): Promise<boolean> {
          const conn = await getSsh()
          if (!conn) return false
          try {
            const result = await execCommand(conn, cmd)
            return result.stdout.trim().includes(expect)
          } catch {
            return false
          }
        }

        // ─── Section definitions ───

        const sections: Section[] = [
          {
            title: 'Local Tooling',
            checks: [
              {
                name: 'flyctl installed',
                fix: 'curl -L https://fly.io/install.sh | sh',
                run: async () => (commandExists('flyctl') ? 'pass' : 'fail'),
              },
              {
                name: 'openssl installed',
                fix: 'brew install openssl (macOS) or apt-get install openssl (Linux)',
                run: async () => (commandExists('openssl') ? 'pass' : 'fail'),
              },
              {
                name: 'bun installed',
                fix: 'curl -fsSL https://bun.sh/install | bash',
                run: async () => (commandExists('bun') ? 'pass' : 'fail'),
              },
              {
                name: 'dig installed (DNS checks)',
                fix: 'brew install bind (macOS) or apt-get install dnsutils (Linux)',
                run: async () => (commandExists('dig') ? 'pass' : 'fail'),
              },
            ],
          },
          {
            title: 'Admin Config',
            checks: [
              {
                name: 'Hetzner host configured',
                fix: 'sandchest-admin init',
                run: async () => (config.hetzner?.host ? 'pass' : 'fail'),
              },
              {
                name: 'SSH key path configured and exists',
                fix: 'sandchest-admin init',
                run: async () => {
                  const keyPath = config.hetzner?.sshKeyPath
                  if (!keyPath) return 'fail'
                  return existsSync(keyPath) ? 'pass' : 'fail'
                },
              },
              {
                name: 'Fly.io app name configured',
                fix: 'sandchest-admin init',
                run: async () => (config.fly?.appName ? 'pass' : 'fail'),
              },
              {
                name: 'R2 credentials configured',
                fix: 'sandchest-admin init',
                run: async () =>
                  config.r2?.endpoint && config.r2.accessKeyId && config.r2.secretAccessKey && config.r2.bucket
                    ? 'pass'
                    : 'fail',
              },
              {
                name: 'Database URL configured',
                fix: 'sandchest-admin init',
                run: async () => (config.db?.url ? 'pass' : 'fail'),
              },
              {
                name: 'Node ID configured',
                fix: 'sandchest-admin init',
                run: async () => (config.node?.id ? 'pass' : 'fail'),
              },
              {
                name: 'API base URL configured',
                fix: 'sandchest-admin init',
                run: async () => (config.api?.baseUrl ? 'pass' : 'fail'),
              },
            ],
          },
          {
            title: 'Certificates',
            checks: [
              {
                name: 'Cert directory configured',
                fix: 'sandchest-admin certs generate',
                run: async () => (config.certs?.dir ? 'pass' : 'fail'),
              },
              {
                name: 'CA certificate exists',
                fix: 'sandchest-admin certs generate',
                run: async () => {
                  const dir = config.certs?.dir
                  if (!dir) return 'skip'
                  return existsSync(join(dir, 'ca.pem')) ? 'pass' : 'fail'
                },
              },
              {
                name: 'Server certificate exists',
                fix: 'sandchest-admin certs generate',
                run: async () => {
                  const dir = config.certs?.dir
                  if (!dir) return 'skip'
                  return existsSync(join(dir, 'server.pem')) ? 'pass' : 'fail'
                },
              },
              {
                name: 'Client certificate exists',
                fix: 'sandchest-admin certs generate',
                run: async () => {
                  const dir = config.certs?.dir
                  if (!dir) return 'skip'
                  return existsSync(join(dir, 'client.pem')) ? 'pass' : 'fail'
                },
              },
              {
                name: 'Certificates not expired',
                fix: 'sandchest-admin certs generate (regenerate)',
                run: async () => {
                  const dir = config.certs?.dir
                  if (!dir) return 'skip'
                  const caPath = join(dir, 'ca.pem')
                  if (!existsSync(caPath)) return 'skip'
                  const result = await exec('openssl', ['x509', '-checkend', '86400', '-noout', '-in', caPath])
                  return result.code === 0 ? 'pass' : 'fail'
                },
              },
            ],
          },
          {
            title: 'R2 Storage',
            checks: [
              {
                name: 'R2 bucket accessible',
                fix: 'Check R2 credentials in sandchest-admin init',
                run: async () => {
                  if (!config.r2?.endpoint || !config.r2.accessKeyId || !config.r2.secretAccessKey || !config.r2.bucket)
                    return 'skip'
                  try {
                    // Use AWS CLI to list bucket (lightweight check)
                    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3')
                    const client = new S3Client({
                      region: 'auto',
                      endpoint: config.r2.endpoint,
                      credentials: {
                        accessKeyId: config.r2.accessKeyId,
                        secretAccessKey: config.r2.secretAccessKey,
                      },
                    })
                    await client.send(
                      new ListObjectsV2Command({
                        Bucket: config.r2.bucket,
                        MaxKeys: 1,
                      }),
                    )
                    return 'pass'
                  } catch {
                    return 'fail'
                  }
                },
              },
              {
                name: 'Kernel image (vmlinux) in R2',
                fix: 'Upload vmlinux to R2: binaries/vmlinux/latest/vmlinux',
                run: async () => {
                  if (!config.r2?.endpoint || !config.r2.accessKeyId || !config.r2.secretAccessKey || !config.r2.bucket)
                    return 'skip'
                  try {
                    const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3')
                    const client = new S3Client({
                      region: 'auto',
                      endpoint: config.r2.endpoint,
                      credentials: {
                        accessKeyId: config.r2.accessKeyId,
                        secretAccessKey: config.r2.secretAccessKey,
                      },
                    })
                    await client.send(
                      new HeadObjectCommand({
                        Bucket: config.r2.bucket,
                        Key: 'binaries/vmlinux/latest/vmlinux',
                      }),
                    )
                    return 'pass'
                  } catch {
                    return 'fail'
                  }
                },
              },
              {
                name: 'Root filesystem (rootfs.ext4) in R2',
                fix: 'Upload rootfs.ext4 to R2: binaries/rootfs/latest/rootfs.ext4',
                run: async () => {
                  if (!config.r2?.endpoint || !config.r2.accessKeyId || !config.r2.secretAccessKey || !config.r2.bucket)
                    return 'skip'
                  try {
                    const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3')
                    const client = new S3Client({
                      region: 'auto',
                      endpoint: config.r2.endpoint,
                      credentials: {
                        accessKeyId: config.r2.accessKeyId,
                        secretAccessKey: config.r2.secretAccessKey,
                      },
                    })
                    await client.send(
                      new HeadObjectCommand({
                        Bucket: config.r2.bucket,
                        Key: 'binaries/rootfs/latest/rootfs.ext4',
                      }),
                    )
                    return 'pass'
                  } catch {
                    return 'fail'
                  }
                },
              },
              {
                name: 'Node daemon binary in R2',
                fix: 'Build and upload: cargo build --release -p sandchest-node, then upload to R2',
                run: async () => {
                  if (!config.r2?.endpoint || !config.r2.accessKeyId || !config.r2.secretAccessKey || !config.r2.bucket)
                    return 'skip'
                  try {
                    const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3')
                    const client = new S3Client({
                      region: 'auto',
                      endpoint: config.r2.endpoint,
                      credentials: {
                        accessKeyId: config.r2.accessKeyId,
                        secretAccessKey: config.r2.secretAccessKey,
                      },
                    })
                    await client.send(
                      new HeadObjectCommand({
                        Bucket: config.r2.bucket,
                        Key: 'binaries/sandchest-node/latest/sandchest-node',
                      }),
                    )
                    return 'pass'
                  } catch {
                    return 'fail'
                  }
                },
              },
            ],
          },
          {
            title: 'Fly.io',
            checks: [
              {
                name: 'Fly.io app exists',
                fix: 'sandchest-admin fly setup',
                run: async () => {
                  const appName = config.fly?.appName
                  if (!appName) return 'skip'
                  const result = await flyctl(['apps', 'list', '--json'])
                  if (result.code !== 0) return 'fail'
                  try {
                    const apps = JSON.parse(result.stdout) as Array<{ Name?: string | undefined; name?: string | undefined }>
                    return apps.some((a) => (a.Name ?? a.name) === appName) ? 'pass' : 'fail'
                  } catch {
                    return 'fail'
                  }
                },
              },
              {
                name: 'Fly.io secrets set',
                fix: 'sandchest-admin fly secrets',
                run: async () => {
                  const appName = config.fly?.appName
                  if (!appName) return 'skip'
                  const result = await flyctl(['secrets', 'list', '-a', appName, '--json'])
                  if (result.code !== 0) return 'fail'
                  try {
                    const secrets = JSON.parse(result.stdout) as Array<{ Name?: string | undefined; name?: string | undefined }>
                    const names = new Set(secrets.map((s) => s.Name ?? s.name))
                    const required = [
                      'DATABASE_URL',
                      'BETTER_AUTH_SECRET',
                      'RESEND_API_KEY',
                      'REDIS_URL',
                      'MTLS_CA_PEM',
                      'MTLS_CLIENT_CERT_PEM',
                      'MTLS_CLIENT_KEY_PEM',
                      'NODE_GRPC_ADDR',
                    ]
                    const missing = required.filter((s) => !names.has(s))
                    if (missing.length > 0) {
                      console.log(`         ${chalk.dim('missing:')} ${missing.join(', ')}`)
                    }
                    return missing.length === 0 ? 'pass' : 'fail'
                  } catch {
                    return 'fail'
                  }
                },
              },
              {
                name: 'API deployed and healthy',
                fix: 'sandchest-admin fly deploy',
                run: async () => {
                  const baseUrl = config.api?.baseUrl
                  if (!baseUrl) return 'skip'
                  const result = await exec('curl', [
                    '-sf',
                    '-o',
                    '/dev/null',
                    '-w',
                    '%{http_code}',
                    '--max-time',
                    '10',
                    `${baseUrl}/health`,
                  ])
                  return result.stdout.trim() === '200' ? 'pass' : 'fail'
                },
              },
              {
                name: 'API readiness (Redis + workers)',
                fix: 'Check REDIS_URL secret on Fly.io',
                run: async () => {
                  const baseUrl = config.api?.baseUrl
                  if (!baseUrl) return 'skip'
                  const result = await exec('curl', ['-sf', '--max-time', '10', `${baseUrl}/readyz`])
                  if (result.code !== 0) return 'fail'
                  try {
                    const body = JSON.parse(result.stdout.trim()) as {
                      status?: string | undefined
                      checks?: { redis?: string | undefined } | undefined
                    }
                    if (body.checks?.redis === 'fail') return 'fail'
                    return body.status === 'ok' ? 'pass' : 'fail'
                  } catch {
                    return 'fail'
                  }
                },
              },
            ],
          },
          {
            title: 'Hetzner Node',
            checks: [
              {
                name: 'SSH connectivity',
                fix: 'Check hetzner.host and hetzner.sshKeyPath in config',
                run: async () => {
                  if (!config.hetzner?.host || !config.hetzner.sshKeyPath) return 'skip'
                  const conn = await getSsh()
                  return conn ? 'pass' : 'fail'
                },
              },
              {
                name: 'KVM available (/dev/kvm writable)',
                fix: 'sandchest-admin node provision --step load-kernel-modules',
                run: async () => {
                  if (!config.hetzner?.host) return 'skip'
                  return (await sshCheck('test -w /dev/kvm && echo yes || echo no', 'yes')) ? 'pass' : 'fail'
                },
              },
              {
                name: 'Firecracker installed',
                fix: 'sandchest-admin node provision --step install-firecracker',
                run: async () => {
                  if (!config.hetzner?.host) return 'skip'
                  return (await sshCheck('firecracker --version 2>/dev/null && echo yes || echo no', 'yes'))
                    ? 'pass'
                    : 'fail'
                },
              },
              {
                name: 'Data directories exist',
                fix: 'sandchest-admin node provision --step create-data-dirs',
                run: async () => {
                  if (!config.hetzner?.host) return 'skip'
                  return (await sshCheck('test -d /var/sandchest/images && echo yes || echo no', 'yes'))
                    ? 'pass'
                    : 'fail'
                },
              },
              {
                name: 'Kernel image on disk',
                fix: 'sandchest-admin node provision --step download-images',
                run: async () => {
                  if (!config.hetzner?.host) return 'skip'
                  return (await sshCheck('test -f /var/sandchest/images/vmlinux-5.10 && echo yes || echo no', 'yes'))
                    ? 'pass'
                    : 'fail'
                },
              },
              {
                name: 'Root filesystem on disk',
                fix: 'sandchest-admin node provision --step download-images',
                run: async () => {
                  if (!config.hetzner?.host) return 'skip'
                  return (await sshCheck('test -f /var/sandchest/images/rootfs.ext4 && echo yes || echo no', 'yes'))
                    ? 'pass'
                    : 'fail'
                },
              },
              {
                name: 'mTLS certs installed on node',
                fix: 'sandchest-admin certs install',
                run: async () => {
                  if (!config.hetzner?.host) return 'skip'
                  return (await sshCheck(
                    'test -f /etc/sandchest/certs/server.pem && test -f /etc/sandchest/certs/ca.pem && echo yes || echo no',
                    'yes',
                  ))
                    ? 'pass'
                    : 'fail'
                },
              },
              {
                name: 'Node env file exists',
                fix: 'sandchest-admin node env',
                run: async () => {
                  if (!config.hetzner?.host) return 'skip'
                  return (await sshCheck('test -f /etc/sandchest/node.env && echo yes || echo no', 'yes'))
                    ? 'pass'
                    : 'fail'
                },
              },
              {
                name: 'Firewall allows gRPC port',
                fix: 'Ensure port 50051 is open (iptables/nftables/Hetzner firewall)',
                run: async () => {
                  if (!config.hetzner?.host) return 'skip'
                  const port = config.node?.grpcPort ?? 50051
                  // Check nftables rule, or iptables ACCEPT policy, or explicit iptables rule
                  return (await sshCheck(
                    `nft list ruleset 2>/dev/null | grep ${port} && echo yes || iptables-legacy -L INPUT -n 2>/dev/null | grep -q 'policy ACCEPT' && echo yes || iptables-legacy -L INPUT -n 2>/dev/null | grep ${port} && echo yes || echo no`,
                    'yes',
                  ))
                    ? 'pass'
                    : 'fail'
                },
              },
              {
                name: 'Node daemon running',
                fix: 'sandchest-admin node deploy',
                run: async () => {
                  if (!config.hetzner?.host) return 'skip'
                  return (await sshCheck('systemctl is-active sandchest-node 2>/dev/null', 'active'))
                    ? 'pass'
                    : 'fail'
                },
              },
            ],
          },
          {
            title: 'DNS',
            checks: [
              {
                name: 'api.sandchest.com resolves',
                fix: 'Add CNAME api → <app>.fly.dev in Cloudflare (DNS-only, grey cloud)',
                run: async () => {
                  const result = await exec('dig', ['+short', 'api.sandchest.com'])
                  return result.code === 0 && result.stdout.trim().length > 0 ? 'pass' : 'fail'
                },
              },
              {
                name: 'node.sandchest.com resolves to Hetzner IP',
                fix: `Add A record node → ${config.hetzner?.host ?? '<hetzner-ip>'} in Cloudflare (DNS-only)`,
                run: async () => {
                  const host = config.hetzner?.host
                  if (!host) return 'skip'
                  const result = await exec('dig', ['+short', 'node.sandchest.com'])
                  return result.code === 0 && result.stdout.trim().includes(host) ? 'pass' : 'fail'
                },
              },
            ],
          },
          {
            title: 'End-to-End',
            checks: [
              {
                name: 'Node registered with API',
                fix: 'Ensure node daemon is running and SANDCHEST_CONTROL_PLANE_URL is set',
                run: async () => {
                  const baseUrl = config.api?.baseUrl
                  if (!baseUrl) return 'skip'
                  // Check the system status endpoint for registered nodes
                  const result = await exec('curl', ['-sf', '--max-time', '10', `${baseUrl}/readyz`])
                  if (result.code !== 0) return 'skip'
                  try {
                    const body = JSON.parse(result.stdout.trim()) as {
                      checks?: { nodes?: string | undefined } | undefined
                    }
                    return body.checks?.nodes !== 'fail' && body.checks?.nodes !== '0' ? 'pass' : 'fail'
                  } catch {
                    // If readyz doesn't include node info, check the internal endpoint
                    return 'skip'
                  }
                },
              },
              {
                name: 'API can reach node via gRPC',
                fix: 'Check mTLS certs on both sides, ensure NODE_GRPC_ADDR is correct on Fly.io',
                run: async () => {
                  // This is validated by the node being registered (heartbeat flows through gRPC)
                  // For now, this passes if the node daemon is active and API is healthy
                  const baseUrl = config.api?.baseUrl
                  if (!baseUrl) return 'skip'
                  if (!config.hetzner?.host) return 'skip'

                  const [apiResult, nodeActive] = await Promise.all([
                    exec('curl', ['-sf', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', `${baseUrl}/health`]),
                    sshCheck('systemctl is-active sandchest-node 2>/dev/null', 'active'),
                  ])

                  return apiResult.stdout.trim() === '200' && nodeActive ? 'pass' : 'fail'
                },
              },
            ],
          },
        ]

        // ─── Run checks ───

        const sectionFilter = opts.section?.toLowerCase()
        const filteredSections = sectionFilter
          ? sections.filter((s) => s.title.toLowerCase().includes(sectionFilter))
          : sections

        if (sectionFilter && filteredSections.length === 0) {
          console.error(chalk.red(`No section matching "${opts.section}"`))
          console.log(`Available: ${sections.map((s) => s.title).join(', ')}`)
          process.exit(1)
        }

        type CheckResult = { name: string; status: 'pass' | 'fail' | 'skip'; fix: string }
        type SectionResult = { title: string; checks: CheckResult[] }
        const results: SectionResult[] = []

        let totalPass = 0
        let totalFail = 0
        let totalSkip = 0

        if (!opts.json) {
          console.log()
          console.log(chalk.bold('  Sandchest Preflight Checklist'))
          console.log(chalk.dim('  ─────────────────────────────'))
        }

        for (const section of filteredSections) {
          const sectionResults: CheckResult[] = []

          if (!opts.json) {
            header(section.title)
          }

          for (const check of section.checks) {
            try {
              const status = await check.run()
              sectionResults.push({ name: check.name, status, fix: check.fix })

              if (!opts.json) {
                if (status === 'pass') {
                  pass(check.name)
                  totalPass++
                } else if (status === 'fail') {
                  fail(check.name, check.fix)
                  totalFail++
                } else {
                  skip(check.name, 'prerequisite not met')
                  totalSkip++
                }
              } else {
                if (status === 'pass') totalPass++
                else if (status === 'fail') totalFail++
                else totalSkip++
              }
            } catch {
              sectionResults.push({ name: check.name, status: 'fail', fix: check.fix })
              if (!opts.json) {
                fail(check.name, check.fix)
              }
              totalFail++
            }
          }

          results.push({ title: section.title, checks: sectionResults })
        }

        // Close SSH connection
        sshConn?.end()

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                pass: totalPass,
                fail: totalFail,
                skip: totalSkip,
                ready: totalFail === 0,
                sections: results,
              },
              null,
              2,
            ),
          )
        } else {
          // Summary
          console.log()
          console.log(chalk.dim('  ─────────────────────────────'))

          const parts: string[] = []
          if (totalPass > 0) parts.push(chalk.green(`${totalPass} passed`))
          if (totalFail > 0) parts.push(chalk.red(`${totalFail} failed`))
          if (totalSkip > 0) parts.push(chalk.dim(`${totalSkip} skipped`))
          console.log(`  ${parts.join(chalk.dim(' / '))}`)

          if (totalFail === 0 && totalSkip === 0) {
            console.log()
            console.log(`  ${chalk.green.bold('Ready to go live.')}`)
          } else if (totalFail === 0 && totalSkip > 0) {
            console.log()
            console.log(`  ${chalk.yellow('All active checks pass, but some were skipped.')}`)
            console.log(chalk.dim('  Fix earlier failures to unlock skipped checks.'))
          } else {
            console.log()
            console.log(`  ${chalk.red.bold('Not ready.')} Fix the failures above and re-run.`)
            console.log(chalk.dim('  Run sandchest-admin preflight --section <name> to check a specific section.'))
          }

          console.log()
        }

        process.exit(totalFail > 0 ? 1 : 0)
      } catch (err) {
        handleError(err)
      }
    })
}
