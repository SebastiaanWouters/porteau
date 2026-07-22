import { dirname, resolve } from 'node:path'
import { defaultServer, overlayDefaultServer, selectedMysqlDatabases } from '../core/config.js'
import { normalizeList, normalizeRequired, promptOrAbort } from './shared.js'
import { defineCommand, type CommandContext } from './types.js'

export const backupCommand = defineCommand({
  meta: {
    name: 'backup',
    description: 'Create a logical backup',
  },
  args: {
    config: {
      type: 'string',
      alias: 'c',
      description: 'Path to a YAML configuration file',
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Final backup directory (must not already exist)',
    },
    user: { type: 'string', description: 'Database user' },
    database: { type: 'string', description: 'Comma-separated included databases' },
  },
  async run(context: CommandContext<'loadConfig' | 'runBackup'>) {
    const { values, cwd, env, presentation, prompts, services, signal } = context
    const configFile = values.config ? resolve(cwd, String(values.config)) : undefined
    let config = await services.loadConfig({
      cwd,
      env,
      ...(configFile ? { configFile } : {}),
    })
    if (values.user) config = overlayDefaultServer(config, { user: String(values.user) })
    signal.throwIfAborted()
    const server = defaultServer(config)
    presentation.registerSecret(server.password)
    let user = server.user
    let password = server.password
    let databases = values.database
      ? normalizeList(values.database, '--database')
      : selectedMysqlDatabases(config)
    if (user !== undefined) user = normalizeRequired(user, 'Database user')
    if (presentation.interactive) {
      if (!user)
        user = await promptOrAbort(
          (abortSignal) => prompts.text('Database user', abortSignal),
          signal,
          (value) => normalizeRequired(value, 'Database user'),
        )
      if (password === undefined) {
        password = await promptOrAbort(
          (abortSignal) => prompts.password('Database password', abortSignal),
          signal,
        )
        presentation.registerSecret(password)
      }
    }
    if (!user || password === undefined || !databases.length)
      throw new Error(
        'Backup requires a database user, password, and at least one included database',
      )
    config = overlayDefaultServer(config, { user, password })
    signal.throwIfAborted()
    presentation.registerSecret(defaultServer(config).password)
    if (config.backup.consistency.mode === 'no-lock') {
      await presentation.disclose(
        'backup',
        'Warning: no-lock does not guarantee a consistent snapshot across concurrent writes.',
        { consistencyMode: 'no-lock' },
      )
      signal.throwIfAborted()
    }
    const result = await services.runBackup({
      config,
      configDirectory: configFile ? dirname(configFile) : cwd,
      databases,
      ...(values.output ? { outputDirectory: String(values.output) } : {}),
      signal,
      environment: env,
      onEvent: (event) => presentation.progress('backup', event),
    })
    signal.throwIfAborted()
    await presentation.success('backup', `Backup completed: ${result.outputDirectory}`, {
      outputDirectory: result.outputDirectory,
      warnings: result.warnings,
    })
    return 0
  },
})
