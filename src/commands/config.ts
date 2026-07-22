import { resolve } from 'node:path'
import type { PorteauConfig } from '../core/config.js'
import { defineCommand, type CommandContext } from './types.js'

function publicConfig(config: PorteauConfig) {
  return {
    connection: {
      host: config.connection.host,
      port: config.connection.port,
      user: config.connection.user,
      tls: config.connection.tls,
      passwordConfigured: config.connection.password !== undefined,
    },
    tools: config.tools,
    backup: config.backup,
    restore: config.restore,
    include: config.include,
    exclude: config.exclude,
    objects: config.objects,
  }
}

export const configCommand = defineCommand({
  meta: {
    name: 'config',
    description: 'Inspect the effective configuration',
  },
  args: {
    config: { type: 'string', alias: 'c', description: 'Path to a YAML configuration file' },
  },
  async run(context: CommandContext<'loadConfig'>) {
    const { values, cwd, env, presentation, services, signal } = context
    const config = await services.loadConfig({
      cwd,
      env,
      ...(values.config ? { configFile: resolve(cwd, String(values.config)) } : {}),
    })
    presentation.registerSecret(config.connection.password)
    signal.throwIfAborted()
    await presentation.success('config', JSON.stringify(publicConfig(config), null, 2), {
      config: publicConfig(config),
    })
    return 0
  },
})
