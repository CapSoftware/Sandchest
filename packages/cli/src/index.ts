import { Command } from 'commander'
import { authCommand } from './commands/auth.js'
import { createCommand } from './commands/create.js'
import { execCommand } from './commands/exec.js'
import { lsCommand } from './commands/ls.js'
import { stopCommand } from './commands/stop.js'
import { rmCommand } from './commands/rm.js'

const program = new Command()
  .name('sandchest')
  .description('Sandchest CLI — Linux sandboxes for AI agent code execution')
  .version('0.0.1')

program.addCommand(authCommand())
program.addCommand(createCommand())
program.addCommand(execCommand())
program.addCommand(lsCommand())
program.addCommand(stopCommand())
program.addCommand(rmCommand())

program.parseAsync().catch(() => {
  process.exit(2)
})
