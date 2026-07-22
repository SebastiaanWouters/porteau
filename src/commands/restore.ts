import { dirname, resolve } from 'node:path'
import { defaultServer, overlayDefaultServer } from '../core/config.js'
import { resolveRestoreArtifactPath, type RestoreConfirmation } from '../core/restore.js'
import { asDatabaseId, effectiveUser, resolveRun, type Selection } from '../core/runtime-config.js'
import { abortError, normalizeList, normalizeRequired, promptOrAbort } from './shared.js'
import { defineCommand, type CommandContext } from './types.js'

function restoreSummary(summary: RestoreConfirmation): string {
  return [
    `Restore ${summary.sourceDatabase} to ${summary.host}:${summary.port}/${summary.destinationDatabase}`,
    `Destination: ${summary.destinationExists ? 'exists' : 'will be created'} (${summary.destinationObjects} objects)`,
    `Destination policy: ${summary.destinationPolicy}`,
    `Overwrite policy: ${summary.overwritePolicy}`,
    `Binary log policy: ${summary.binlogPolicy}`,
  ].join('\n')
}

export const restoreCommand = defineCommand({
  meta: {
    name: 'restore',
    description: 'Restore a Porteau backup artifact',
  },
  args: {
    config: {
      type: 'string',
      alias: 'c',
      description: 'Path to a YAML configuration file',
    },
    artifact: {
      type: 'string',
      alias: 'a',
      description: 'Backup artifact directory (resolved against the config directory)',
    },
    user: { type: 'string', description: 'Destination database user' },
    database: {
      type: 'string',
      description: 'Catalog database key for the artifact source (defaults.database when omitted)',
    },
    'destination-database': {
      type: 'string',
      description: 'Destination MySQL database name',
    },
    'destination-policy': {
      type: 'string',
      description: 'Destination policy: require-empty or allow-existing',
    },
    'overwrite-policy': {
      type: 'string',
      description: 'Existing table policy: reject, drop, truncate, or delete',
    },
    'binlog-policy': {
      type: 'string',
      description: 'Destination binlog policy: disable or enable',
    },
  },
  async run(context: CommandContext<'loadConfig' | 'runRestore'>) {
    const { values, flags, cwd, env, presentation, prompts, services, signal } = context
    const configFile = values.config ? resolve(cwd, String(values.config)) : undefined
    const configDirectory = configFile ? dirname(configFile) : cwd
    const restoreFlags = {
      ...(values['destination-policy']
        ? { destinationPolicy: String(values['destination-policy']) }
        : {}),
      ...(values['overwrite-policy']
        ? { overwritePolicy: String(values['overwrite-policy']) }
        : {}),
      ...(values['binlog-policy'] ? { binlogPolicy: String(values['binlog-policy']) } : {}),
    }
    let config = await services.loadConfig({
      cwd,
      env,
      ...(configFile ? { configFile } : {}),
      ...(Object.keys(restoreFlags).length ? { flags: { restore: restoreFlags } } : {}),
    })
    if (values.user) config = overlayDefaultServer(config, { user: String(values.user) })
    signal.throwIfAborted()
    const server = defaultServer(config)
    presentation.registerSecret(server.password)
    let user = server.user
    let password = server.password
    let destinationDatabase = values['destination-database']
      ? String(values['destination-database'])
      : undefined
    if (user !== undefined) user = normalizeRequired(user, 'Destination database user')
    if (presentation.interactive) {
      if (!user)
        user = await promptOrAbort(
          (abortSignal) => prompts.text('Destination database user', abortSignal),
          signal,
          (value) => normalizeRequired(value, 'Destination database user'),
        )
      if (password === undefined) {
        password = await promptOrAbort(
          (abortSignal) => prompts.password('Destination database password', abortSignal),
          signal,
        )
        presentation.registerSecret(password)
      }
      if (!destinationDatabase)
        destinationDatabase = await promptOrAbort(
          (abortSignal) => prompts.text('Destination database', abortSignal),
          signal,
        )
    }
    if (!user || password === undefined || !destinationDatabase)
      throw new Error('Restore requires a destination database, database user, and password')
    destinationDatabase = normalizeRequired(destinationDatabase, 'Destination database')
    config = overlayDefaultServer(config, { user, password })
    signal.throwIfAborted()
    presentation.registerSecret(defaultServer(config).password)

    const databaseTokens = values.database
      ? normalizeList(values.database, '--database')
      : undefined
    if (databaseTokens !== undefined && databaseTokens.length !== 1)
      throw new Error('Restore accepts exactly one --database catalog key')
    const selection: Selection | undefined = databaseTokens
      ? { databases: [asDatabaseId(databaseTokens[0]!)] }
      : undefined
    const run = resolveRun(config, selection, { configDirectory })
    const loginUser = effectiveUser(run, run.databases[0])
    if (!loginUser)
      throw new Error('Restore requires a destination database, database user, and password')

    const artifactPath = await resolveRestoreArtifactPath({
      artifactsDirectory: run.artifacts.directory,
      databaseId: run.databases[0].id,
      ...(values.artifact ? { artifactOverride: String(values.artifact) } : {}),
      configDirectory,
    })
    signal.throwIfAborted()

    const result = await services.runRestore({
      run,
      credentials: { user: loginUser, password },
      artifactPath,
      destinationDatabase,
      configDirectory,
      signal,
      environment: env,
      onEvent: (event) => presentation.progress('restore', event),
      async confirm(summary) {
        const rendered = restoreSummary(summary)
        await presentation.disclose('restore', rendered, { summary })
        signal.throwIfAborted()
        if (flags.yes) return true
        if (!presentation.interactive)
          throw new Error('Restore requires --yes in non-interactive mode')
        const answer = await prompts.confirm('Apply this restore plan?', signal)
        signal.throwIfAborted()
        if (answer !== true) throw abortError('Restore cancelled before destination mutation')
        return true
      },
    })
    signal.throwIfAborted()
    await presentation.success('restore', `Restore completed: ${result.destinationDatabase}`, {
      destinationDatabase: result.destinationDatabase,
      warnings: result.warnings,
    })
    return 0
  },
})
