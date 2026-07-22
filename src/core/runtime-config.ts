import { isAbsolute, join } from 'node:path'

declare const serverIdBrand: unique symbol
declare const databaseIdBrand: unique symbol
declare const absoluteDirectoryBrand: unique symbol

/** Catalog key under authored `servers`. */
export type ServerId = string & { readonly [serverIdBrand]: typeof serverIdBrand }

/** Catalog key under authored `databases` (artifact naming uses this, not MySQL name). */
export type DatabaseId = string & { readonly [databaseIdBrand]: typeof databaseIdBrand }

/** Filesystem directory known to be absolute (resolution happens at the resolve boundary). */
export type AbsoluteDirectory = string & {
  readonly [absoluteDirectoryBrand]: typeof absoluteDirectoryBrand
}

/** At least one selected database; empty selection is unrepresentable. */
export type NonEmptyDatabases = readonly [ResolvedDatabase, ...ResolvedDatabase[]]

export type ResolvedTlsMode = 'disabled' | 'preferred' | 'required'

export interface ResolvedServer {
  readonly id: ServerId
  readonly host: string
  readonly port: number
  readonly user?: string
  readonly tls: ResolvedTlsMode
}

export interface ResolvedDatabase {
  readonly id: DatabaseId
  /** MySQL database / schema name passed to mydumper/myloader. */
  readonly name: string
  /** Optional per-database user override; falls back to server.user. */
  readonly user?: string
}

export interface ResolvedArtifacts {
  /** Absolute artifacts root. Backup publishes under it; restore looks up under it. */
  readonly directory: AbsoluteDirectory
}

/** Operation knobs after selection. No directory — artifacts owns the root. */
export interface ResolvedBackupSettings {
  readonly profile: 'production' | 'replica' | 'expert'
  readonly threads: number
  readonly compression: 'none' | 'gzip' | 'zstd'
  readonly consistency: {
    readonly mode: 'auto' | 'safe-no-lock' | 'no-lock'
    readonly protectDdl: boolean
  }
  readonly throttle: {
    readonly enabled: boolean
    readonly threshold: number | null
  }
}

export interface ResolvedRestoreSettings {
  readonly threads: number
  readonly destinationPolicy: 'require-empty' | 'allow-existing'
  readonly overwritePolicy: 'reject' | 'drop' | 'truncate' | 'delete'
  readonly binlogPolicy: 'disable' | 'enable'
}

export interface ResolvedExclude {
  readonly tables: readonly string[]
  readonly data: readonly string[]
}

export interface ResolvedObjects {
  readonly triggers: boolean
  readonly views: boolean
}

export interface ResolvedTools {
  readonly mydumper?: string
  readonly myloader?: string
}

/**
 * Fully selected runtime config for one CLI invocation.
 * Core backup/restore trust this; they do not re-read authored registries.
 */
export interface ResolvedRun {
  readonly server: ResolvedServer
  readonly databases: NonEmptyDatabases
  readonly artifacts: ResolvedArtifacts
  readonly backup: ResolvedBackupSettings
  readonly restore: ResolvedRestoreSettings
  readonly exclude: ResolvedExclude
  readonly objects: ResolvedObjects
  readonly tools: ResolvedTools
}

/** Login pair at the command boundary; password never appears on ResolvedServer. */
export interface ConnectionCredentials {
  readonly user: string
  readonly password: string
}

/** Phase-4 selection stub; optional fields only until resolve wires catalogs. */
export interface Selection {
  readonly server?: ServerId
  readonly databases?: readonly DatabaseId[]
}

export interface ResolvedServerInput {
  readonly id: string
  readonly host: string
  readonly port: number
  readonly user?: string
  readonly tls: ResolvedTlsMode
}

export interface ResolvedDatabaseInput {
  readonly id: string
  readonly name: string
  readonly user?: string
}

export interface ResolvedRunInput {
  readonly server: ResolvedServerInput
  readonly databases: readonly ResolvedDatabaseInput[]
  readonly artifactsDirectory: string
  readonly backup: ResolvedBackupSettings
  readonly restore: ResolvedRestoreSettings
  readonly exclude: ResolvedExclude
  readonly objects: ResolvedObjects
  readonly tools: ResolvedTools
}

export function asServerId(value: string): ServerId {
  assertNonEmpty(value, 'ServerId')
  return value as ServerId
}

export function asDatabaseId(value: string): DatabaseId {
  assertNonEmpty(value, 'DatabaseId')
  return value as DatabaseId
}

export function asAbsoluteDirectory(value: string): AbsoluteDirectory {
  assertNonEmpty(value, 'AbsoluteDirectory')
  if (!isAbsolute(value)) {
    throw new Error(`AbsoluteDirectory must be absolute, got: ${value}`)
  }
  return value as AbsoluteDirectory
}

export function createResolvedServer(input: ResolvedServerInput): ResolvedServer {
  assertNonEmpty(input.host, 'ResolvedServer.host')
  return {
    id: asServerId(input.id),
    host: input.host,
    port: input.port,
    ...(input.user !== undefined ? { user: input.user } : {}),
    tls: input.tls,
  }
}

export function createResolvedDatabase(input: ResolvedDatabaseInput): ResolvedDatabase {
  assertNonEmpty(input.name, 'ResolvedDatabase.name')
  return {
    id: asDatabaseId(input.id),
    name: input.name,
    ...(input.user !== undefined ? { user: input.user } : {}),
  }
}

export function createResolvedArtifacts(directory: string): ResolvedArtifacts {
  return { directory: asAbsoluteDirectory(directory) }
}

/**
 * Build a ResolvedRun. Rejects empty databases and non-absolute artifacts paths.
 * Does not load YAML, apply defaults, or resolve catalog names — that is phase 4.
 */
export function createResolvedRun(input: ResolvedRunInput): ResolvedRun {
  const [first, ...rest] = input.databases
  if (first === undefined) {
    throw new Error('ResolvedRun.databases must be non-empty')
  }
  const databases: NonEmptyDatabases = [
    createResolvedDatabase(first),
    ...rest.map(createResolvedDatabase),
  ]
  return {
    server: createResolvedServer(input.server),
    databases,
    artifacts: createResolvedArtifacts(input.artifactsDirectory),
    backup: input.backup,
    restore: input.restore,
    exclude: input.exclude,
    objects: input.objects,
    tools: input.tools,
  }
}

/** MySQL database names in selection order (mydumper --database=a,b). */
export function mysqlDatabaseNames(run: ResolvedRun): readonly [string, ...string[]] {
  const [first, ...rest] = run.databases
  return [first.name, ...rest.map((database) => database.name)]
}

/**
 * Effective login user for a selected database: database.user ?? server.user.
 * Password remains outside ResolvedRun (command layer / credentials module).
 */
export function effectiveUser(run: ResolvedRun, database: ResolvedDatabase): string | undefined {
  return database.user ?? run.server.user
}

/**
 * Default backup output directory when CLI --output is omitted:
 * `{artifacts.directory}/{databaseId}-{YYYY-MM-DD}` for the primary selected DB.
 */
export function defaultBackupOutputDirectory(run: ResolvedRun, date: string): AbsoluteDirectory {
  return asAbsoluteDirectory(join(run.artifacts.directory, `${run.databases[0].id}-${date}`))
}

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must be non-empty`)
}
