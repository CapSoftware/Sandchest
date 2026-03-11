import { Command } from 'commander'
import { authCommand } from './commands/auth.js'
import { createCommand } from './commands/create.js'
import { execCommand } from './commands/exec.js'
import { lsCommand } from './commands/ls.js'
import { stopCommand } from './commands/stop.js'
import { rmCommand } from './commands/rm.js'
import { sshCommand } from './commands/ssh.js'
import { forkCommand } from './commands/fork.js'
import { replayCommand } from './commands/replay.js'
import { watchCommand } from './commands/watch.js'
import { uploadCommand } from './commands/upload.js'
import { downloadCommand } from './commands/download.js'
import { logsCommand } from './commands/logs.js'
import { copyCommand } from './commands/copy.js'
import { gitCommand } from './commands/git.js'
import { mcpInitCommand } from './commands/mcp-init.js'
import { mcpTestCommand } from './commands/mcp-test.js'
import { skillInstallCommand } from './commands/skill-install.js'
import { runCommand } from './commands/run.js'
import { imagesCommand } from './commands/images.js'

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
program.addCommand(sshCommand())
program.addCommand(forkCommand())
program.addCommand(replayCommand())
program.addCommand(watchCommand())
program.addCommand(uploadCommand())
program.addCommand(downloadCommand())
program.addCommand(logsCommand())
program.addCommand(copyCommand())
program.addCommand(gitCommand())
program.addCommand(runCommand())
program.addCommand(imagesCommand())

const mcpGroup = new Command('mcp').description('MCP server management')
mcpGroup.addCommand(mcpInitCommand())
mcpGroup.addCommand(mcpTestCommand())
program.addCommand(mcpGroup)

const skillGroup = new Command('skill').description('Skill installation and management')
skillGroup.addCommand(skillInstallCommand())
program.addCommand(skillGroup)

program.parseAsync().catch(() => {
  process.exit(2)
})
