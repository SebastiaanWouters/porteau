import { dirname, resolve } from 'node:path'
import { applyConfigOverlay } from '../core/config.js'
import { abortError, normalizeList, normalizeRequired } from './shared.js'
import { defineCommand, type CommandContext } from './types.js'

export const backupCommand = defineCommand({
  meta: {
    name: 'backup',
    description: 'Create a consistent logical backup',
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
      flags: {
        ...(values.user ? { connection: { user: String(values.user) } } : {}),
        ...(values.database
          ? { include: { databases: normalizeList(values.database, '--database') } }
          : {}),
      },
    })
    signal.throwIfAborted()
    presentation.registerSecret(config.connection.password)
    let user = config.connection.user,
      password = config.connection.password,
      databases = config.include.databases
    if (user !== undefined) user = normalizeRequired(user, 'Database user')
    if (presentation.interactive) {
      if (!user) {
        user = await prompts.text('Database user', signal)
        signal.throwIfAborted()
        if (user === undefined) throw abortError()
        user = normalizeRequired(user, 'Database user')
      }
      if (password === undefined) {
        password = await prompts.password('Database password', signal)
        signal.throwIfAborted()
        if (password === undefined) throw abortError()
        presentation.registerSecret(password)
      }
      if (!databases.length) {
        const answer = await prompts.text('Included databases (comma-separated)', signal)
        signal.throwIfAborted()
        if (answer === undefined) throw abortError()
        databases = normalizeList(answer, 'Included databases')
      }
    }
    if (!user || password === undefined || !databases.length)
      throw new Error(
        'Backup requires a database user, password, and at least one included database',
      )
    config = applyConfigOverlay(config, {
      connection: { user, password },
      include: { databases },
    })
    signal.throwIfAborted()
    presentation.registerSecret(config.connection.password)
    const result = await services.runBackup({
      config,
      configDirectory: configFile ? dirname(configFile) : cwd,
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
