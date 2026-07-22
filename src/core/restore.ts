import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createCredentialsDefaultsFile } from './credentials.js'
import type { ConnectionFactory } from './database.js'
import type { EngineEvent } from './events.js'
import { runMachineTool } from './mydumper.js'
import { runRestorePreflight, type RestorePreflightReport } from './preflight.js'
import { type ConnectionCredentials, type DatabaseId, type ResolvedRun } from './runtime-config.js'
import { assertMatchingToolVersions, inspectTool, resolveTool } from './tools.js'
import { verifyRestoreArtifact } from './artifact.js'

export interface RestoreConfirmation {
  readonly host: string
  readonly port: number
  readonly sourceDatabase: string
  readonly destinationDatabase: string
  readonly destinationExists: boolean
  readonly destinationObjects: number
  readonly destinationPolicy: ResolvedRun['restore']['destinationPolicy']
  readonly overwritePolicy: ResolvedRun['restore']['overwritePolicy']
  readonly binlogPolicy: ResolvedRun['restore']['binlogPolicy']
}

export interface RestoreResult {
  readonly destinationDatabase: string
  readonly warnings: number
}

export interface RunRestoreOptions {
  readonly run: ResolvedRun
  readonly credentials: ConnectionCredentials
  /** Absolute artifact directory. */
  readonly artifactPath: string
  /** Explicit MySQL destination name (rename path). */
  readonly destinationDatabase: string
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

const CANDIDATE_LIST_LIMIT = 10

/**
 * Resolve the restore artifact directory.
 * `--artifact` wins and is resolved against configDirectory when relative.
 * Otherwise auto-pick under artifacts root when exactly one `{databaseId}-*` match exists.
 */
export async function resolveRestoreArtifactPath(options: {
  readonly artifactsDirectory: string
  readonly databaseId: DatabaseId | string
  readonly artifactOverride?: string
  readonly configDirectory: string
}): Promise<string> {
  if (options.artifactOverride !== undefined) {
    const trimmed = options.artifactOverride.trim()
    if (trimmed === '') throw new Error('Backup artifact directory must not be empty')
    return resolve(options.configDirectory, trimmed)
  }

  let names: string[]
  try {
    const entries = await readdir(options.artifactsDirectory, { withFileTypes: true })
    const prefix = `${options.databaseId}-`
    names = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    names = []
  }

  if (names.length === 1) return join(options.artifactsDirectory, names[0]!)

  const root = options.artifactsDirectory
  if (names.length === 0) {
    throw new Error(
      `No restore artifact matched "${options.databaseId}-*" under ${root}. Pass --artifact explicitly.`,
    )
  }
  const listed =
    names.length <= CANDIDATE_LIST_LIMIT
      ? names.map((name) => join(root, name)).join(', ')
      : `${names.length} matches`
  throw new Error(
    `Ambiguous restore artifact for "${options.databaseId}" under ${root}: ${listed}. Pass --artifact explicitly.`,
  )
}

function restoreArguments(
  run: ResolvedRun,
  sourceDatabase: string,
  destinationDatabase: string,
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
  return [
    `--defaults-file=${defaultsFile}`,
    '--machine-log-json',
    `--directory=${artifactPath}`,
    `--source-db=${sourceDatabase}`,
    `--database=${destinationDatabase}`,
    `--threads=${run.restore.threads}`,
    `--drop-table=${overwrite[run.restore.overwritePolicy]}`,
    '--checksum=WARN',
    '--optimize-keys=AFTER_IMPORT_PER_TABLE',
    ...(preflight.destination.exists ? ['--skip-create-database'] : []),
    ...(run.restore.binlogPolicy === 'enable' ? ['--enable-binlog'] : []),
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
  const { run, credentials } = options
  const sourceDatabase = run.databases[0].name
  if (options.destinationDatabase === '')
    throw new Error('Restore requires an explicit destination database')

  const cwd = options.configDirectory ?? process.cwd()
  const environment = options.environment ?? process.env
  const childEnvironment = { ...process.env, ...environment }
  delete childEnvironment.PORTEAU_PASSWORD

  // Establish structural artifact safety before any destination connection or mutation.
  const artifact = await verifyRestoreArtifact(options.artifactPath, sourceDatabase, options.signal)
  const mydumperPath = await resolveTool('mydumper', {
    env: environment,
    ...(run.tools.mydumper ? { configPath: run.tools.mydumper } : {}),
    cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const myloaderPath = await resolveTool('myloader', {
    env: environment,
    ...(run.tools.myloader ? { configPath: run.tools.myloader } : {}),
    cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const preflight = await runRestorePreflight({
    connection: {
      host: run.server.host,
      port: run.server.port,
      user: credentials.user,
      password: credentials.password,
      tls: run.server.tls,
    },
    destinationDatabase: options.destinationDatabase,
    destinationPolicy: run.restore.destinationPolicy,
    overwritePolicy: run.restore.overwritePolicy,
    binlogPolicy: run.restore.binlogPolicy,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.connectionFactory ? { connectionFactory: options.connectionFactory } : {}),
  })
  const approved = await confirmRestore(options, {
    host: run.server.host,
    port: run.server.port,
    sourceDatabase,
    destinationDatabase: options.destinationDatabase,
    destinationExists: preflight.destination.exists,
    destinationObjects: preflight.destination.objects,
    destinationPolicy: run.restore.destinationPolicy,
    overwritePolicy: run.restore.overwritePolicy,
    binlogPolicy: run.restore.binlogPolicy,
  })
  if (!approved) throw new Error('Restore cancelled before destination mutation')
  options.signal?.throwIfAborted()

  const [mydumper, myloader] = await Promise.all([
    inspectTool('mydumper', mydumperPath, childEnvironment, options.signal),
    inspectTool('myloader', myloaderPath, childEnvironment, options.signal),
  ])
  options.signal?.throwIfAborted()
  assertMatchingToolVersions(mydumper, myloader)

  const credentialsFile = await createCredentialsDefaultsFile({
    host: run.server.host,
    port: run.server.port,
    user: credentials.user,
    password: credentials.password,
    tls: run.server.tls,
  })
  const events: EngineEvent[] = []
  let result: RestoreResult | undefined
  let failure: unknown
  let cleanupFailure: unknown
  try {
    options.signal?.throwIfAborted()
    const outcome = await runMachineTool({
      executable: myloaderPath,
      args: restoreArguments(
        run,
        sourceDatabase,
        options.destinationDatabase,
        credentialsFile.path,
        artifact.rootPath,
        preflight,
      ),
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
      destinationDatabase: options.destinationDatabase,
      warnings: Number(completion.warnings),
    }
  } catch (error) {
    failure = error
  } finally {
    try {
      await credentialsFile.cleanup()
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
