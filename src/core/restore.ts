import type { PorteauConfig } from './config.js'
import { createCredentialsDefaultsFile } from './credentials.js'
import type { ConnectionFactory } from './database.js'
import type { EngineEvent } from './events.js'
import { runMachineTool } from './mydumper.js'
import { runRestorePreflight, type RestorePreflightReport } from './preflight.js'
import { assertMatchingToolVersions, inspectTool, resolveTool } from './tools.js'
import { verifyRestoreArtifact } from './artifact.js'

export interface RestoreRequest {
  readonly artifactPath: string
  readonly sourceDatabase: string
  readonly destinationDatabase: string
  readonly destinationPolicy: 'require-empty' | 'allow-existing'
  readonly overwritePolicy: 'reject' | 'drop' | 'truncate' | 'delete'
  readonly binlogPolicy: 'disable' | 'enable'
}

export interface RestoreConfirmation {
  readonly host: string
  readonly port: number
  readonly sourceDatabase: string
  readonly destinationDatabase: string
  readonly destinationExists: boolean
  readonly destinationObjects: number
  readonly destinationPolicy: RestoreRequest['destinationPolicy']
  readonly overwritePolicy: RestoreRequest['overwritePolicy']
  readonly binlogPolicy: RestoreRequest['binlogPolicy']
}

export interface RestoreResult {
  readonly destinationDatabase: string
  readonly warnings: number
}

export interface RunRestoreOptions {
  readonly config: PorteauConfig
  readonly request: RestoreRequest
  readonly configDirectory?: string
  readonly signal?: AbortSignal
  readonly onEvent?: (event: EngineEvent) => void
  readonly confirm: (
    summary: RestoreConfirmation,
    signal?: AbortSignal,
  ) => boolean | Promise<boolean>
  readonly connectionFactory?: ConnectionFactory
  readonly environment?: NodeJS.ProcessEnv
}

function restoreArguments(
  config: PorteauConfig,
  request: RestoreRequest,
  defaultsFile: string,
  artifactPath: string,
  preflight: RestorePreflightReport,
): string[] {
  const overwrite = {
    reject: 'FAIL',
    drop: 'DROP',
    truncate: 'TRUNCATE',
    delete: 'DELETE',
  } as const
  const checksum = { off: 'SKIP', warn: 'WARN', required: 'FAIL' } as const
  const indexes = {
    off: 'SKIP',
    'per-table': 'AFTER_IMPORT_PER_TABLE',
    all: 'AFTER_IMPORT_ALL_TABLES',
  } as const
  return [
    `--defaults-file=${defaultsFile}`,
    '--machine-log-json',
    `--directory=${artifactPath}`,
    `--source-db=${request.sourceDatabase}`,
    `--database=${request.destinationDatabase}`,
    `--threads=${config.restore.threads}`,
    `--drop-table=${overwrite[request.overwritePolicy]}`,
    `--checksum=${checksum[config.restore.verifyChecksums]}`,
    `--optimize-keys=${indexes[config.restore.deferIndexes]}`,
    ...(preflight.destination.exists ? ['--skip-create-database'] : []),
    ...(request.binlogPolicy === 'enable' ? ['--enable-binlog'] : []),
  ]
}

async function confirmRestore(
  options: RunRestoreOptions,
  summary: RestoreConfirmation,
): Promise<boolean> {
  if (!options.signal) return options.confirm(summary)
  options.signal.throwIfAborted()
  let abort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('Restore cancelled during confirmation'))
    options.signal!.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([options.confirm(summary, options.signal), cancelled])
  } finally {
    if (abort) options.signal.removeEventListener('abort', abort)
  }
}

export async function runRestore(options: RunRestoreOptions): Promise<RestoreResult> {
  const { config, request } = options
  if (!config.connection.user || config.connection.password === undefined)
    throw new Error('Non-interactive restore requires a database user and password')
  if (request.sourceDatabase === '' || request.destinationDatabase === '')
    throw new Error('Restore requires explicit source and destination databases')

  const cwd = options.configDirectory ?? process.cwd()
  const environment = options.environment ?? process.env
  const childEnvironment = { ...process.env, ...environment }
  delete childEnvironment.PORTEAU_PASSWORD

  // Establish structural artifact safety before any destination connection or mutation.
  const artifact = await verifyRestoreArtifact(
    request.artifactPath,
    request.sourceDatabase,
    options.signal,
  )
  const mydumperPath = await resolveTool('mydumper', {
    env: environment,
    ...(config.tools.mydumper ? { configPath: config.tools.mydumper } : {}),
    cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const myloaderPath = await resolveTool('myloader', {
    env: environment,
    ...(config.tools.myloader ? { configPath: config.tools.myloader } : {}),
    cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const preflight = await runRestorePreflight({
    config,
    destinationDatabase: request.destinationDatabase,
    destinationPolicy: request.destinationPolicy,
    overwritePolicy: request.overwritePolicy,
    binlogPolicy: request.binlogPolicy,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.connectionFactory ? { connectionFactory: options.connectionFactory } : {}),
  })
  const approved = await confirmRestore(options, {
    host: config.connection.host,
    port: config.connection.port,
    sourceDatabase: request.sourceDatabase,
    destinationDatabase: request.destinationDatabase,
    destinationExists: preflight.destination.exists,
    destinationObjects: preflight.destination.objects,
    destinationPolicy: request.destinationPolicy,
    overwritePolicy: request.overwritePolicy,
    binlogPolicy: request.binlogPolicy,
  })
  if (!approved) throw new Error('Restore cancelled before destination mutation')
  options.signal?.throwIfAborted()

  const [mydumper, myloader] = await Promise.all([
    inspectTool('mydumper', mydumperPath, childEnvironment, options.signal),
    inspectTool('myloader', myloaderPath, childEnvironment, options.signal),
  ])
  options.signal?.throwIfAborted()
  assertMatchingToolVersions(mydumper, myloader)

  const credentials = await createCredentialsDefaultsFile({
    host: config.connection.host,
    port: config.connection.port,
    user: config.connection.user,
    password: config.connection.password,
    tls: config.connection.tls,
  })
  const events: EngineEvent[] = []
  let result: RestoreResult | undefined
  let failure: unknown
  let cleanupFailure: unknown
  try {
    options.signal?.throwIfAborted()
    const outcome = await runMachineTool({
      executable: myloaderPath,
      args: restoreArguments(config, request, credentials.path, artifact.rootPath, preflight),
      tool: 'myloader',
      env: childEnvironment,
      ...(options.signal ? { signal: options.signal } : {}),
      onEvent(event) {
        events.push(event)
        options.onEvent?.(event)
      },
    })
    if (outcome.aborted || options.signal?.aborted) throw new Error('Restore cancelled')
    if (outcome.exitCode !== 0)
      throw new Error(`Myloader exited with code ${outcome.exitCode ?? -1}`)
    if (events.some((event) => event.type === 'cancelled'))
      throw new Error('Myloader reported cancellation')
    if (events.some((event) => event.type === 'error' && event.fatal))
      throw new Error('Myloader reported a fatal event')
    const completions = events.filter((event) => event.type === 'completion')
    if (completions.length !== 1)
      throw new Error('Myloader did not report exactly one completion event')
    const completion = completions[0]!
    if (completion.exitCode !== outcome.exitCode || completion.errors !== '0')
      throw new Error('Myloader process and completion event disagree')
    if (!Number.isSafeInteger(Number(completion.files)))
      throw new Error('Myloader reported an invalid file count')
    result = {
      destinationDatabase: request.destinationDatabase,
      warnings: Number(completion.warnings),
    }
  } catch (error) {
    failure = error
  } finally {
    try {
      await credentials.cleanup()
    } catch (error) {
      cleanupFailure = error
    }
  }
  if (cleanupFailure)
    throw new AggregateError(
      failure ? [failure, cleanupFailure] : [cleanupFailure],
      failure ? 'Restore and cleanup failed' : 'Restore cleanup failed',
    )
  if (failure) throw failure
  if (!result) throw new Error('Restore ended without a result')
  return result
}
