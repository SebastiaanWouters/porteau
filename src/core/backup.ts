import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { createCredentialsDefaultsFile } from './credentials.js'
import type { ConnectionFactory } from './database.js'
import type { EngineEvent } from './events.js'
import { assertArtifactSafeIdentifiers, exactTableRegex, resolveObjectScopes } from './filters.js'
import { runMachineTool } from './mydumper.js'
import { runBackupPreflight } from './preflight.js'
import {
  defaultBackupOutputDirectory,
  mysqlDatabaseNames,
  type ConnectionCredentials,
  type ResolvedBackupSettings,
  type ResolvedRun,
} from './runtime-config.js'
import { assertMatchingToolVersions, inspectTool, resolveTool } from './tools.js'
import { verifyMydumperArtifact } from './artifact.js'

const MAX_THREADS_PER_TABLE = 4
const STARTUP_LOCK_TIMEOUT_SECONDS = 10
const FTWRL_TIMEOUT_RETRIES = 1

export interface BackupResult {
  readonly outputDirectory: string
  readonly warnings: number
}

export interface RunBackupOptions {
  readonly run: ResolvedRun
  readonly credentials: ConnectionCredentials
  readonly configDirectory?: string
  readonly outputDirectory?: string
  readonly signal?: AbortSignal
  readonly onEvent?: (event: EngineEvent) => void
  readonly connectionFactory?: ConnectionFactory
  readonly environment?: NodeJS.ProcessEnv
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const autoLifecycle = [
  ['lock', 'global_lock', 'started'],
  ['backup_consistency', 'startup', 'finished'],
  ['table_unlock', 'startup', 'finished'],
  ['dump_phase', 'wait_database_finish', 'progress'],
] as const

class AutoConsistencyLifecycle {
  #next = 0
  accept(event: EngineEvent): void {
    const transition = [event.sourceEvent, event.sourcePhase, event.sourceStatus]
    const recognized = autoLifecycle.some((item) =>
      item.every((value, index) => transition[index] === value),
    )
    if (!recognized) return
    const expected = autoLifecycle[this.#next]
    if (!expected || !expected.every((value, index) => transition[index] === value))
      throw new Error('Mydumper reported a reordered AUTO consistency lifecycle')
    this.#next += 1
  }
  assertComplete(): void {
    if (this.#next !== autoLifecycle.length)
      throw new Error('Mydumper did not complete the qualified AUTO consistency lifecycle')
  }
}

function outputPath(run: ResolvedRun, override: string | undefined, cwd: string): string {
  const utcDate = new Date().toISOString().slice(0, 10)
  if (override === undefined) return defaultBackupOutputDirectory(run, utcDate)
  const expanded = override.replaceAll('{{date}}', utcDate)
  return resolve(cwd, expanded)
}

function syncThreadLockMode(mode: ResolvedBackupSettings['consistency']['mode']): string {
  if (mode === 'auto') return 'AUTO'
  if (mode === 'safe-no-lock') return 'SAFE_NO_LOCK'
  return 'NO_LOCK'
}

function backupArguments(
  run: ResolvedRun,
  mysqlDatabases: readonly string[],
  defaultsFile: string,
  temporaryDirectory: string,
  selectedTables: readonly { database: string; table: string }[],
): string[] {
  const args = [
    `--defaults-file=${defaultsFile}`,
    '--machine-log-json',
    `--outputdir=${temporaryDirectory}`,
    `--database=${mysqlDatabases.join(',')}`,
    `--regex=${exactTableRegex(selectedTables)}`,
    `--threads=${run.backup.threads}`,
    `--max-threads-per-table=${MAX_THREADS_PER_TABLE}`,
    `--sync-thread-lock-mode=${syncThreadLockMode(run.backup.consistency.mode)}`,
    '--trx-tables',
    `--ftwrl-max-wait-time=${STARTUP_LOCK_TIMEOUT_SECONDS}`,
    `--ftwrl-timeout-retries=${FTWRL_TIMEOUT_RETRIES}`,
  ]
  if (run.backup.compression !== 'none') args.push(`--compress=${run.backup.compression}`)
  if (!run.backup.consistency.protectDdl) args.push('--skip-ddl-locks')
  if (run.objects.triggers) args.push('--triggers')
  if (!run.objects.views) args.push('--no-views')
  // SHOW GLOBAL STATUS for throttle needs PROCESS; no-lock targets users without it.
  if (run.backup.throttle.enabled && run.backup.consistency.mode !== 'no-lock') {
    const threshold = run.backup.throttle.threshold ?? Math.max(4, run.backup.threads)
    args.push(`--throttle=Threads_running=${threshold}`)
  }
  // NO_LOCK still probes binlog coordinates; tolerate missing REPLICATION CLIENT.
  if (run.backup.consistency.mode === 'no-lock') args.push('--ignore-errors=1227')
  return args
}

export async function runBackup(options: RunBackupOptions): Promise<BackupResult> {
  const { run, credentials } = options
  const mysqlDatabases = mysqlDatabaseNames(run)

  const cwd = options.configDirectory ?? process.cwd()
  const environment = options.environment ?? process.env
  const childEnvironment = { ...process.env, ...environment }
  delete childEnvironment.PORTEAU_PASSWORD
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
  const [mydumper, myloader] = await Promise.all([
    inspectTool('mydumper', mydumperPath, childEnvironment, options.signal),
    inspectTool('myloader', myloaderPath, childEnvironment, options.signal),
  ])
  options.signal?.throwIfAborted()
  assertMatchingToolVersions(mydumper, myloader)

  const patterns = mysqlDatabases.map((database) => `${database}.*`)
  const preflight = await runBackupPreflight({
    connection: {
      host: run.server.host,
      port: run.server.port,
      user: credentials.user,
      password: credentials.password,
      tls: run.server.tls,
    },
    databases: mysqlDatabases,
    tablePatterns: patterns,
    includeViews: run.objects.views,
    includeTriggers: run.objects.triggers,
    profile: run.backup.profile,
    consistencyMode: run.backup.consistency.mode,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.connectionFactory ? { connectionFactory: options.connectionFactory } : {}),
  })
  const selected = resolveObjectScopes(preflight.tables, run.exclude)
  if (selected.length === 0) throw new Error('Backup filters excluded every selected table')
  assertArtifactSafeIdentifiers(selected)

  const finalDirectory = outputPath(run, options.outputDirectory, cwd)
  if (await pathExists(finalDirectory))
    throw new Error(`Backup output already exists: ${finalDirectory}`)
  await mkdir(dirname(finalDirectory), { recursive: true })
  const temporaryDirectory = join(
    dirname(finalDirectory),
    `.${basename(finalDirectory)}.porteau-${randomUUID()}.partial`,
  )
  const credentialsFile = await createCredentialsDefaultsFile(
    {
      host: run.server.host,
      port: run.server.port,
      user: credentials.user,
      password: credentials.password,
      tls: run.server.tls,
    },
    selected,
  )
  const lockController = new AbortController()
  const forwardAbort = () => lockController.abort(options.signal?.reason)
  if (options.signal?.aborted) forwardAbort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })
  let lockTimer: NodeJS.Timeout | undefined
  let lockTimedOut = false
  let unlockReported = false
  let finalReserved = false
  let published = false
  const events: EngineEvent[] = []
  const lifecycle =
    run.backup.consistency.mode === 'auto' ? new AutoConsistencyLifecycle() : undefined
  let result: BackupResult | undefined
  let failure: unknown
  let cleanupFailure: AggregateError | undefined

  try {
    const outcome = await runMachineTool({
      executable: mydumperPath,
      args: backupArguments(
        run,
        mysqlDatabases,
        credentialsFile.path,
        temporaryDirectory,
        selected,
      ),
      tool: 'mydumper',
      signal: lockController.signal,
      env: childEnvironment,
      onEvent(event) {
        lifecycle?.accept(event)
        events.push(event)
        if (
          lockTimer === undefined &&
          event.sourceEvent === 'lock' &&
          event.sourcePhase === 'global_lock' &&
          event.sourceStatus === 'started'
        ) {
          lockTimer = setTimeout(() => {
            lockTimedOut = true
            lockController.abort()
          }, STARTUP_LOCK_TIMEOUT_SECONDS * 1_000)
        }
        if (lockTimer && event.sourceEvent === 'table_unlock' && event.sourceStatus === 'finished')
          unlockReported = true
        if (lockTimer && unlockReported && ['error', 'warning'].includes(event.type))
          lockController.abort()
        if (
          lockTimer &&
          event.sourceEvent === 'dump_phase' &&
          event.sourcePhase === 'wait_database_finish' &&
          event.sourceStatus === 'progress'
        ) {
          clearTimeout(lockTimer)
          lockTimer = undefined
          unlockReported = false
        }
        options.onEvent?.(event)
      },
    })
    if (lockTimedOut) throw new Error('Startup lock acquisition exceeded its safety budget')
    if (outcome.aborted || lockController.signal.aborted) throw new Error('Backup cancelled')
    if (outcome.exitCode !== 0)
      throw new Error(`Mydumper exited with code ${outcome.exitCode ?? -1}`)
    if (events.some((event) => event.type === 'error' && event.fatal))
      throw new Error('Mydumper reported a fatal event')
    lifecycle?.assertComplete()
    const completions = events.filter((event) => event.type === 'completion')
    if (completions.length !== 1)
      throw new Error('Mydumper did not report exactly one completion event')
    const completion = completions[0]!
    if (completion.exitCode !== 0 || completion.errors !== '0')
      throw new Error('Mydumper completion reported errors')
    const expectedFiles = Number(completion.files)
    if (!Number.isSafeInteger(expectedFiles))
      throw new Error('Mydumper reported an invalid file count')
    await verifyMydumperArtifact(temporaryDirectory, selected, {
      triggers: run.objects.triggers,
      signal: lockController.signal,
      expectedFiles,
    })
    if (lockController.signal.aborted) throw new Error('Backup cancelled')
    try {
      await mkdir(finalDirectory)
      finalReserved = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(`Backup output was created concurrently: ${finalDirectory}`)
      throw error
    }
    if (lockController.signal.aborted) throw new Error('Backup cancelled')
    await rename(temporaryDirectory, finalDirectory)
    published = true
    result = { outputDirectory: finalDirectory, warnings: Number(completion.warnings) }
  } catch (error) {
    failure = error
  } finally {
    if (lockTimer) clearTimeout(lockTimer)
    options.signal?.removeEventListener('abort', forwardAbort)
    const cleanup = await Promise.allSettled([
      credentialsFile.cleanup(),
      rm(temporaryDirectory, { recursive: true, force: true }),
      finalReserved && !published ? rmdir(finalDirectory) : Promise.resolve(),
    ])
    const failures = cleanup.filter((result) => result.status === 'rejected')
    if (failures.length > 0) cleanupFailure = new AggregateError(failures, 'Backup cleanup failed')
  }
  if (cleanupFailure) throw cleanupFailure
  if (failure) throw failure
  if (!result) throw new Error('Backup ended without a result')
  return result
}
