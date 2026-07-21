import type { PorteauConfig } from './config.js'
import {
  connectionOptions,
  mysqlConnectionFactory,
  queryWithDeadline,
  sanitizeDatabaseError,
  type ConnectionFactory,
} from './database.js'
import type { ExecutionProfile } from './engine.js'
import { expandTablePatterns } from './filters.js'

export type ServerProduct = 'mysql' | 'mariadb'
export interface CatalogTable {
  readonly database: string
  readonly table: string
  readonly kind: 'base-table' | 'view'
  readonly engine: string | null
  readonly hasKey: boolean
  readonly hasTriggers: boolean
}
export interface PreflightWarning {
  readonly code: 'KEYLESS_TABLE'
  readonly database: string
  readonly table: string
}
export interface ReplicaStatus {
  readonly isReplica: boolean
  readonly ioRunning: boolean
  readonly sqlRunning: boolean
  readonly lagSeconds: number | null
}
export interface PreflightReport {
  readonly server: { readonly product: ServerProduct; readonly version: string }
  readonly tables: readonly CatalogTable[]
  readonly warnings: readonly PreflightWarning[]
  readonly privileges: readonly string[]
  readonly variables: { readonly gtidMode: string; readonly logBin: boolean }
  readonly replica?: ReplicaStatus
}
export interface PreflightRequest {
  readonly config: PorteauConfig
  readonly databases: readonly string[]
  readonly tablePatterns: readonly string[]
  readonly includeViews?: boolean
  readonly profile?: ExecutionProfile
  readonly timeoutMilliseconds?: number
  readonly signal?: AbortSignal
  readonly connectionFactory?: ConnectionFactory
}

const SERVER_SQL = 'SELECT @@version AS version, @@version_comment AS versionComment'
const DATABASE_SQL =
  'SELECT SCHEMA_NAME AS databaseName FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?)'
const TABLE_SQL = `SELECT t.TABLE_SCHEMA AS databaseName, t.TABLE_NAME AS tableName, t.TABLE_TYPE AS tableType,
 t.ENGINE AS engine, EXISTS (SELECT 1 FROM information_schema.STATISTICS s
 WHERE s.TABLE_SCHEMA=t.TABLE_SCHEMA AND s.TABLE_NAME=t.TABLE_NAME AND s.NON_UNIQUE=0) AS hasKey
 ,EXISTS (SELECT 1 FROM information_schema.TRIGGERS tr
 WHERE tr.EVENT_OBJECT_SCHEMA=t.TABLE_SCHEMA AND tr.EVENT_OBJECT_TABLE=t.TABLE_NAME) AS hasTriggers
 FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA IN (?)`
const MYSQL_VARIABLES_SQL = 'SELECT @@global.gtid_mode AS gtidMode, @@global.log_bin AS logBin'
const MARIADB_VARIABLES_SQL =
  'SELECT @@global.gtid_binlog_pos AS gtidMode, @@global.log_bin AS logBin'

type Row = Record<string, unknown>
function first(rows: readonly unknown[]): Row {
  return (rows[0] ?? {}) as Row
}
function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
    ? String(value)
    : ''
}
function productOf(version: string, comment: string): ServerProduct {
  if (/mariadb/iu.test(`${version} ${comment}`))
    throw new Error('MariaDB backup has not been qualified for this release')
  if (version.startsWith('8.')) return 'mysql'
  throw new Error('Unsupported or unrecognized MySQL server product/version')
}
interface Grant {
  readonly privileges: ReadonlySet<string>
  readonly database?: string
}
function parseGrants(rows: readonly unknown[]): Grant[] {
  const grants: Grant[] = []
  for (const row of rows) {
    for (const value of Object.values(row as Row)) {
      if (typeof value !== 'string') continue
      const match = /^GRANT\s+(.+?)\s+ON\s+(\*\.\*|`(?:``|[^`])+`\.\*)\s+TO\s+/iu.exec(value)
      if (!match) continue
      const privileges = match[1]!.split(',').map((item) => item.trim().toUpperCase())
      if (privileges.some((item) => !/^[A-Z_]+(?: [A-Z_]+)*$/u.test(item))) continue
      const scope = match[2]!
      grants.push({
        privileges: new Set(privileges),
        ...(scope === '*.*' ? {} : { database: scope.slice(1, -3).replaceAll('``', '`') }),
      })
    }
  }
  return grants
}

export async function runBackupPreflight(request: PreflightRequest): Promise<PreflightReport> {
  if (request.databases.length === 0 || request.tablePatterns.length === 0)
    throw new Error('Backup preflight requires selected databases and table patterns')
  const timeoutMilliseconds = request.timeoutMilliseconds ?? 10_000
  const profile = request.profile ?? request.config.backup.profile
  const factory = request.connectionFactory ?? mysqlConnectionFactory
  let connection
  try {
    connection = await factory(connectionOptions(request.config.connection, timeoutMilliseconds))
    const query = (sql: string, values?: readonly unknown[]) =>
      queryWithDeadline(connection!, sql, values, {
        timeoutMilliseconds,
        ...(request.signal ? { signal: request.signal } : {}),
      })
    const serverRow = first(await query(SERVER_SQL))
    const version = text(serverRow.version)
    const product = productOf(version, text(serverRow.versionComment))
    const databaseRows = await query(DATABASE_SQL, [request.databases])
    const foundDatabases = new Set(databaseRows.map((row) => text((row as Row).databaseName)))
    const missing = request.databases.filter((database) => !foundDatabases.has(database))
    if (missing.length > 0)
      throw new Error(`Selected databases do not exist: ${missing.join(', ')}`)

    const rawTables = await query(TABLE_SQL, [request.databases])
    const catalog: CatalogTable[] = rawTables.map((value) => {
      const row = value as Row
      const kind = text(row.tableType).toUpperCase() === 'VIEW' ? 'view' : 'base-table'
      return {
        database: text(row.databaseName),
        table: text(row.tableName),
        kind,
        engine: row.engine === null ? null : text(row.engine),
        hasKey: Boolean(Number(row.hasKey)),
        hasTriggers: Boolean(Number(row.hasTriggers)),
      }
    })
    const selectable = catalog.filter(
      (table) => request.includeViews !== false || table.kind !== 'view',
    )
    const selectedIds = expandTablePatterns(request.tablePatterns, selectable)
    const selectedKeys = new Set(selectedIds.map((table) => `${table.database}\0${table.table}`))
    const tables = selectable.filter((table) =>
      selectedKeys.has(`${table.database}\0${table.table}`),
    )
    const unsafe = tables.filter(
      (table) => table.kind === 'base-table' && table.engine?.toUpperCase() !== 'INNODB',
    )
    if (request.config.backup.consistency.requireInnoDB && unsafe.length > 0)
      throw new Error(
        `Selected non-InnoDB base tables are unsafe: ${unsafe.map((t) => `${t.database}.${t.table}`).join(', ')}`,
      )

    const grantRows = await query('SHOW GRANTS')
    const grants = parseGrants(grantRows)
    const has = (privilege: string, database?: string) =>
      grants.some(
        (grant) =>
          (grant.database === undefined || grant.database === database) &&
          (grant.privileges.has(privilege) || grant.privileges.has('ALL PRIVILEGES')),
      )
    const globalRequired =
      product === 'mysql' ? ['RELOAD', 'PROCESS', 'BACKUP_ADMIN'] : ['RELOAD', 'PROCESS']
    if (profile === 'replica') globalRequired.push('REPLICATION CLIENT')
    const dataRequired = ['SELECT']
    if (product === 'mariadb') dataRequired.push('LOCK TABLES')
    if (request.config.objects.views) dataRequired.push('SHOW VIEW')
    if (request.config.objects.triggers) dataRequired.push('TRIGGER')
    if (request.config.objects.events) dataRequired.push('EVENT')
    const absent = [
      ...globalRequired.filter((privilege) => !has(privilege)),
      ...dataRequired.filter((privilege) =>
        request.databases.some((database) => !has(privilege, database)),
      ),
    ]
    if (absent.length > 0)
      throw new Error(`Insufficient privileges for safe lock strategy: ${absent.join(', ')}`)
    const privileges = [...new Set(grants.flatMap((grant) => [...grant.privileges]))]
    const variablesRow = first(
      await query(product === 'mysql' ? MYSQL_VARIABLES_SQL : MARIADB_VARIABLES_SQL),
    )
    const variables = {
      gtidMode: text(variablesRow.gtidMode),
      logBin: Boolean(Number(variablesRow.logBin)),
    }

    let replica: ReplicaStatus | undefined
    if (profile === 'replica') {
      const row = first(
        await query(product === 'mariadb' ? 'SHOW SLAVE STATUS' : 'SHOW REPLICA STATUS'),
      )
      replica = {
        isReplica: Object.keys(row).length > 0,
        ioRunning: text(row.Replica_IO_Running ?? row.Slave_IO_Running).toUpperCase() === 'YES',
        sqlRunning: text(row.Replica_SQL_Running ?? row.Slave_SQL_Running).toUpperCase() === 'YES',
        lagSeconds:
          row.Seconds_Behind_Source === null || row.Seconds_Behind_Master === null
            ? null
            : Number(row.Seconds_Behind_Source ?? row.Seconds_Behind_Master ?? 0),
      }
      if (!replica.isReplica) throw new Error('Replica profile requires a configured replica')
      if (!replica.ioRunning || !replica.sqlRunning)
        throw new Error('Replica SQL and IO threads must be running')
    }
    const warnings = tables
      .filter((table) => table.kind === 'base-table' && !table.hasKey)
      .map(
        (table): PreflightWarning => ({
          code: 'KEYLESS_TABLE',
          database: table.database,
          table: table.table,
        }),
      )
    return {
      server: { product, version },
      tables,
      warnings,
      privileges,
      variables,
      ...(replica ? { replica } : {}),
    }
  } catch (error) {
    if (error && typeof error === 'object' && ('code' in error || 'sqlState' in error))
      throw sanitizeDatabaseError(error)
    throw error
  } finally {
    if (connection) {
      try {
        await connection.end()
      } catch {
        /* A destroyed connection is already closed. */
      }
    }
  }
}
