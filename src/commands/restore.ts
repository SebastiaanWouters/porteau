import { dirname, resolve } from 'node:path'
import type { RestoreConfirmation } from '../core/restore.js'
import { abortError, normalizeRequired } from './shared.js'
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
      description: 'Backup artifact directory',
    },
    user: { type: 'string', description: 'Destination database user' },
    'source-database': {
      type: 'string',
      description: 'Database name stored in the artifact',
    },
    'destination-database': {
      type: 'string',
      description: 'Destination database name',
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
      flags: {
        ...(values.user ? { connection: { user: String(values.user) } } : {}),
        ...(Object.keys(restoreFlags).length ? { restore: restoreFlags } : {}),
      },
    })
    signal.throwIfAborted()
    presentation.registerSecret(config.connection.password)
    let user = config.connection.user,
      password = config.connection.password,
      artifact = values.artifact ? String(values.artifact) : undefined,
      sourceDatabase = values['source-database'] ? String(values['source-database']) : undefined,
      destinationDatabase = values['destination-database']
        ? String(values['destination-database'])
        : undefined
    if (user !== undefined) user = normalizeRequired(user, 'Destination database user')
    if (presentation.interactive) {
      if (!user) {
        user = await prompts.text('Destination database user', signal)
        signal.throwIfAborted()
        if (user === undefined) throw abortError()
        user = normalizeRequired(user, 'Destination database user')
      }
      if (password === undefined) {
        password = await prompts.password('Destination database password', signal)
        signal.throwIfAborted()
        if (password === undefined) throw abortError()
        presentation.registerSecret(password)
      }
      if (!artifact) {
        artifact = await prompts.text('Backup artifact directory', signal)
        signal.throwIfAborted()
        if (artifact === undefined) throw abortError()
      }
      if (!sourceDatabase) {
        sourceDatabase = await prompts.text('Source database in artifact', signal)
        signal.throwIfAborted()
        if (sourceDatabase === undefined) throw abortError()
      }
      if (!destinationDatabase) {
        destinationDatabase = await prompts.text('Destination database', signal)
        signal.throwIfAborted()
        if (destinationDatabase === undefined) throw abortError()
      }
    }
    if (!user || password === undefined || !artifact || !sourceDatabase || !destinationDatabase)
      throw new Error(
        'Restore requires an artifact, source database, destination database, database user, and password',
      )
    artifact = normalizeRequired(artifact, 'Backup artifact directory')
    sourceDatabase = normalizeRequired(sourceDatabase, 'Source database')
    destinationDatabase = normalizeRequired(destinationDatabase, 'Destination database')
    config = await services.loadConfig({
      cwd,
      env,
      ...(configFile ? { configFile } : {}),
      flags: {
        connection: { user, password },
        ...(Object.keys(restoreFlags).length ? { restore: restoreFlags } : {}),
      },
    })
    signal.throwIfAborted()
    presentation.registerSecret(config.connection.password)
    const result = await services.runRestore({
      config,
      request: {
        artifactPath: resolve(cwd, artifact),
        sourceDatabase,
        destinationDatabase,
        destinationPolicy: config.restore.destinationPolicy,
        overwritePolicy: config.restore.overwritePolicy,
        binlogPolicy: config.restore.binlogPolicy,
      },
      configDirectory: configFile ? dirname(configFile) : cwd,
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
