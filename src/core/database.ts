import mysql from 'mysql2/promise'
import type { ConnectionOptions } from 'mysql2'
import type { PorteauConfig } from './config.js'

export interface QueryConnection {
  query(sql: string, values?: readonly unknown[]): Promise<readonly unknown[]>
  end(): Promise<void>
  destroy(): void
}

export type ConnectionFactory = (options: ConnectionOptions) => Promise<QueryConnection>

export interface DatabaseErrorDetails {
  readonly code: string
  readonly sqlState?: string
}

export class DatabaseError extends Error implements DatabaseErrorDetails {
  readonly code: string
  readonly sqlState?: string

  constructor(details: DatabaseErrorDetails) {
    super(`Database operation failed (${details.code})`)
    this.name = 'DatabaseError'
    this.code = details.code
    if (details.sqlState !== undefined) this.sqlState = details.sqlState
  }
}

function safeToken(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/u.test(value) ? value : fallback
}

export function sanitizeDatabaseError(error: unknown, fallback = 'DATABASE_ERROR'): DatabaseError {
  if (error instanceof DatabaseError) return error
  const candidate = error as { code?: unknown; sqlState?: unknown }
  const code = safeToken(candidate?.code, fallback)
  const sqlState = safeToken(candidate?.sqlState, '') || undefined
  return new DatabaseError({ code, ...(sqlState ? { sqlState } : {}) })
}

export function tlsOptions(
  mode: PorteauConfig['connection']['tls'],
  _host: string,
): ConnectionOptions['ssl'] {
  if (mode === 'disabled') return undefined
  if (mode === 'preferred' || mode === 'required') return { rejectUnauthorized: false }
  if (mode === 'verify-ca') return { rejectUnauthorized: true }
  // mysql2 passes the configured host to Node TLS for identity verification.
  return { rejectUnauthorized: true }
}

export function connectionOptions(
  config: PorteauConfig['connection'],
  timeoutMilliseconds = 10_000,
): ConnectionOptions {
  const ssl = tlsOptions(config.tls, config.host)
  return {
    host: config.host,
    port: config.port,
    ...(config.user === undefined ? {} : { user: config.user }),
    ...(config.password === undefined ? {} : { password: config.password }),
    ...(ssl === undefined ? {} : { ssl }),
    connectTimeout: timeoutMilliseconds,
    supportBigNumbers: true,
    bigNumberStrings: true,
  }
}

export const mysqlConnectionFactory: ConnectionFactory = async (options) => {
  const connection = await mysql.createConnection(options)
  return {
    async query(sql, values) {
      const [rows] = await connection.query(sql, values as unknown[] | undefined)
      return Array.isArray(rows) ? rows : []
    },
    async end() {
      await connection.end()
    },
    destroy() {
      connection.destroy()
    },
  }
}

export async function queryWithDeadline(
  connection: QueryConnection,
  sql: string,
  values: readonly unknown[] | undefined,
  options: { readonly timeoutMilliseconds: number; readonly signal?: AbortSignal },
): Promise<readonly unknown[]> {
  if (options.signal?.aborted) {
    connection.destroy()
    throw new DatabaseError({ code: 'ABORTED' })
  }
  let timer: NodeJS.Timeout | undefined
  let abort: (() => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      connection.destroy()
      reject(new DatabaseError({ code: 'QUERY_TIMEOUT' }))
    }, options.timeoutMilliseconds)
    abort = () => {
      connection.destroy()
      reject(new DatabaseError({ code: 'ABORTED' }))
    }
    options.signal?.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([connection.query(sql, values), deadline])
  } catch (error) {
    throw sanitizeDatabaseError(error)
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) options.signal?.removeEventListener('abort', abort)
  }
}
