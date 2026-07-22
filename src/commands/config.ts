import { resolve } from 'node:path'
import { defaultServer, type PorteauConfig } from '../core/config.js'
import { defineCommand, type CommandContext } from './types.js'

function publicConfig(config: PorteauConfig) {
  const server = defaultServer(config)
  return {
    artifacts: config.artifacts,
    defaults: config.defaults,
    servers: Object.fromEntries(
      Object.entries(config.servers).map(([id, entry]) => [
        id,
        {
          host: entry.host,
          port: entry.port,
          ...(entry.user !== undefined ? { user: entry.user } : {}),
          tls: entry.tls,
          passwordConfigured: entry.password !== undefined,
        },
      ]),
    ),
    databases: config.databases,
    tools: config.tools,
    backup: config.backup,
    restore: config.restore,
    exclude: config.exclude,
    objects: config.objects,
    passwordConfigured: server.password !== undefined,
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
    for (const entry of Object.values(config.servers)) {
      presentation.registerSecret(entry.password)
    }
    signal.throwIfAborted()
    const view = publicConfig(config)
    await presentation.success('config', JSON.stringify(view, null, 2), {
      config: view,
    })
    return 0
  },
})
