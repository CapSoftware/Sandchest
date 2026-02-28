import { Command } from 'commander'
import { initCommand } from './commands/init.js'
import { certsGenerateCommand } from './commands/certs/generate.js'
import { certsInstallCommand } from './commands/certs/install.js'
import { certsShowCommand } from './commands/certs/show.js'
import { flySetupCommand } from './commands/fly/setup.js'
import { flyRedisCommand } from './commands/fly/redis.js'
import { flySecretsCommand } from './commands/fly/secrets.js'
import { flyDeployCommand } from './commands/fly/deploy.js'
import { flyStatusCommand } from './commands/fly/status.js'
import { nodeProvisionCommand } from './commands/node/provision.js'
import { nodeDeployCommand } from './commands/node/deploy.js'
import { nodeEnvCommand } from './commands/node/env.js'
import { nodeSshCommand } from './commands/node/ssh.js'
import { nodeMetricsCommand } from './commands/node/metrics.js'
import { nodeStatusCommand } from './commands/node/status.js'
import { dbMigrateCommand } from './commands/db/migrate.js'
import { dbSeedCommand } from './commands/db/seed.js'
import { dnsShowCommand } from './commands/dns/show.js'
import { verifyCommand } from './commands/verify.js'
import { setupCommand } from './commands/setup.js'

const program = new Command()
  .name('sandchest-admin')
  .description('Sandchest infrastructure deployment CLI')
  .version('0.0.1')

// Top-level commands
program.addCommand(initCommand())
program.addCommand(verifyCommand())
program.addCommand(setupCommand())

// certs subcommands
const certs = new Command('certs').description('Manage mTLS certificates')
certs.addCommand(certsGenerateCommand())
certs.addCommand(certsInstallCommand())
certs.addCommand(certsShowCommand())
program.addCommand(certs)

// fly subcommands
const fly = new Command('fly').description('Manage Fly.io deployment')
fly.addCommand(flySetupCommand())
fly.addCommand(flyRedisCommand())
fly.addCommand(flySecretsCommand())
fly.addCommand(flyDeployCommand())
fly.addCommand(flyStatusCommand())
program.addCommand(fly)

// node subcommands
const node = new Command('node').description('Manage Hetzner bare metal node')
node.addCommand(nodeProvisionCommand())
node.addCommand(nodeDeployCommand())
node.addCommand(nodeEnvCommand())
node.addCommand(nodeSshCommand())
node.addCommand(nodeMetricsCommand())
node.addCommand(nodeStatusCommand())
program.addCommand(node)

// db subcommands
const db = new Command('db').description('Database operations')
db.addCommand(dbMigrateCommand())
db.addCommand(dbSeedCommand())
program.addCommand(db)

// dns subcommands
const dns = new Command('dns').description('DNS management')
dns.addCommand(dnsShowCommand())
program.addCommand(dns)

program.parseAsync().catch(() => {
  process.exit(2)
})
