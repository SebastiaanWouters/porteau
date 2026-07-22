import { dirname, resolve } from 'node:path'
import { applyConfigOverlay, overlayServerFromEnvironment } from '../core/config.js'
import { effectiveUser, resolveRun } from '../core/runtime-config.js'
import { normalizeRequired, promptOrAbort, resolveCatalogSelection } from './shared.js'
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
    server: {
      type: 'string',
      description: 'Server catalog key (defaults.server when omitted)',
    },
    database: {
      type: 'string',
      description: 'Comma-separated catalog database keys (defaults.database when omitted)',
    },
  },
  async run(context: CommandContext<'loadConfig' | 'runBackup'>) {
    const { values, cwd, env, presentation, prompts, services, signal } = context
    const configFile = values.config ? resolve(cwd, String(values.config)) : undefined
    const configDirectory = configFile ? dirname(configFile) : cwd
    let config = await services.loadConfig({
      cwd,
      env,
      ...(configFile ? { configFile } : {}),
    })
    signal.throwIfAborted()

    const { selection, serverKey } = await resolveCatalogSelection({
      config,
      ...(values.server !== undefined ? { serverFlag: String(values.server) } : {}),
      ...(values.database !== undefined ? { databaseFlag: String(values.database) } : {}),
      interactive: presentation.interactive,
      prompts,
      signal,
      databaseArity: 'many',
    })

    config = overlayServerFromEnvironment(config, serverKey, env)
    const selected = config.servers[serverKey]
    if (selected === undefined) {
      const known = Object.keys(config.servers).sort().join(', ')
      throw new Error(`Unknown server "${serverKey}". Known servers: ${known || '(none)'}`)
    }
    presentation.registerSecret(selected.password)
    let user = values.user !== undefined ? String(values.user) : selected.user
    let password = selected.password
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
    if (!user || password === undefined)
      throw new Error(
        'Backup requires a database user, password, and at least one included database',
      )
    config = applyConfigOverlay(config, {
      servers: { [serverKey]: { user, password } },
    })
    signal.throwIfAborted()
    presentation.registerSecret(config.servers[serverKey]?.password)

    const run = resolveRun(config, selection, { configDirectory })
    const loginUser = effectiveUser(run, run.databases[0])
    if (!loginUser)
      throw new Error(
        'Backup requires a database user, password, and at least one included database',
      )

    if (run.backup.consistency.mode === 'no-lock') {
      await presentation.disclose(
        'backup',
        'Warning: no-lock does not guarantee a consistent snapshot across concurrent writes.',
        { consistencyMode: 'no-lock' },
      )
      signal.throwIfAborted()
    }
    const result = await services.runBackup({
      run,
      credentials: { user: loginUser, password },
      configDirectory,
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
