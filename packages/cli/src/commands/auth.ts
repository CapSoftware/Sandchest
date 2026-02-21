import { Command } from 'commander'
import { readConfig, writeConfig, getConfigPath } from '../config.js'
import { success, error, info } from '../output.js'

export function authCommand(): Command {
  const auth = new Command('auth').description('Manage authentication')

  auth
    .command('login')
    .description('Save an API key')
    .requiredOption('--key <api-key>', 'Sandchest API key')
    .action((options: { key: string }) => {
      const config = readConfig()
      config.apiKey = options.key
      writeConfig(config)
      success('API key saved.')
      info(`Config: ${getConfigPath()}`)
    })

  auth
    .command('logout')
    .description('Remove saved API key')
    .action(() => {
      const config = readConfig()
      delete config.apiKey
      writeConfig(config)
      success('API key removed.')
    })

  auth
    .command('status')
    .description('Show current authentication status')
    .action(() => {
      const envKey = process.env['SANDCHEST_API_KEY']
      const configKey = readConfig().apiKey

      if (envKey) {
        success('Authenticated via SANDCHEST_API_KEY environment variable')
        info(`Key: ${envKey.slice(0, 8)}...${envKey.slice(-4)}`)
      } else if (configKey) {
        success('Authenticated via config file')
        info(`Key: ${configKey.slice(0, 8)}...${configKey.slice(-4)}`)
      } else {
        error('Not authenticated. Run `sandchest auth login --key <api-key>` to get started.')
      }
    })

  return auth
}
