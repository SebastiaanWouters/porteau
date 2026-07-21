import { describe, expect, it } from 'vite-plus/test'
import { defaultConfig, type PorteauConfig } from '../src/core/config.js'
import {
  connectionOptions,
  DatabaseError,
  queryWithDeadline,
  sanitizeDatabaseError,
  tlsOptions,
  type QueryConnection,
} from '../src/core/database.js'
import { runBackupPreflight } from '../src/core/preflight.js'

const config = defaultConfig as PorteauConfig
type Responses = {
  tables?: readonly unknown[]
  grants?: readonly unknown[]
  replica?: readonly unknown[]
}

function fake(responses: Responses = {}) {
  let ended = 0
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = []
  const connection: QueryConnection = {
    async query(sql, values) {
      queries.push({ sql, ...(values ? { values } : {}) })
      if (sql.includes('@@version AS'))
        return [{ version: '8.4.1', versionComment: 'MySQL Community' }]
      if (sql.includes('SCHEMATA')) return [{ databaseName: 'app' }]
      if (sql.includes('information_schema.TABLES'))
        return (
          responses.tables ?? [
            {
              databaseName: 'app',
              tableName: 'users',
              tableType: 'BASE TABLE',
              engine: 'InnoDB',
              hasKey: 1,
            },
            {
              databaseName: 'app',
              tableName: 'summary',
              tableType: 'VIEW',
              engine: null,
              hasKey: 0,
            },
          ]
        )
      if (sql === 'SHOW GRANTS')
        return (
          responses.grants ?? [
            {
              grant:
                'GRANT SELECT, RELOAD, PROCESS, BACKUP_ADMIN, REPLICATION CLIENT, SHOW VIEW, TRIGGER ON *.* TO user',
            },
          ]
        )
      if (sql.includes('gtid_mode')) return [{ gtidMode: 'ON', logBin: 1 }]
      if (sql.startsWith('SHOW REPLICA')) return responses.replica ?? []
      throw new Error(`Unexpected SQL in test: ${sql}`)
    },
    async end() {
      ended += 1
    },
    destroy() {},
  }
  return { connection, queries, ended: () => ended }
}

async function preflight(
  responses: Responses = {},
  profile: 'production' | 'replica' = 'production',
) {
  const state = fake(responses)
  const report = await runBackupPreflight({
    config,
    databases: ['app'],
    tablePatterns: ['app.*'],
    profile,
    connectionFactory: async () => state.connection,
  })
  return { report, state }
}

describe('mysql connection boundary', () => {
  it('uses direct fields, bigint-safe values, timeouts, and conservative TLS mappings', () => {
    const options = connectionOptions({
      host: 'db.internal',
      port: 3307,
      user: 'u',
      password: 'secret',
      tls: 'required',
    })
    expect(options).toMatchObject({
      host: 'db.internal',
      port: 3307,
      user: 'u',
      password: 'secret',
      supportBigNumbers: true,
      bigNumberStrings: true,
      connectTimeout: 10_000,
    })
    expect(options).not.toHaveProperty('uri')
    expect(tlsOptions('disabled', 'db')).toBeUndefined()
    expect(tlsOptions('preferred', 'db')).toEqual({ rejectUnauthorized: false })
    expect(tlsOptions('required', 'db')).toEqual({ rejectUnauthorized: false })
    expect(tlsOptions('verify-ca', 'db')).toEqual({ rejectUnauthorized: true })
    expect(tlsOptions('verify-identity', 'db')).toEqual({ rejectUnauthorized: true })
  })

  it('destroys timed out and aborted queries and exposes only stable error metadata', async () => {
    let destroyed = 0
    const pending: QueryConnection = {
      query: () => new Promise(() => {}),
      end: async () => {},
      destroy: () => {
        destroyed += 1
      },
    }
    await expect(
      queryWithDeadline(pending, 'SELECT password', undefined, { timeoutMilliseconds: 1 }),
    ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' })
    const controller = new AbortController()
    const query = queryWithDeadline(pending, 'SELECT secret', undefined, {
      timeoutMilliseconds: 100,
      signal: controller.signal,
    })
    controller.abort()
    await expect(query).rejects.toMatchObject({ code: 'ABORTED' })
    expect(destroyed).toBe(2)
    const sanitized = sanitizeDatabaseError({
      code: 'ER_ACCESS_DENIED_ERROR',
      sqlState: '28000',
      message: 'secret db.internal SELECT password',
    })
    expect(sanitized).toBeInstanceOf(DatabaseError)
    expect(sanitized).toMatchObject({ code: 'ER_ACCESS_DENIED_ERROR', sqlState: '28000' })
    expect(sanitized.message).not.toMatch(/secret|internal|SELECT|password/u)
  })
})

describe('read-only backup preflight', () => {
  it('returns a typed production catalog, distinguishes views, warns keyless tables, parameterizes values, and closes', async () => {
    const { report, state } = await preflight({
      tables: [
        {
          databaseName: 'app',
          tableName: 'users',
          tableType: 'BASE TABLE',
          engine: 'InnoDB',
          hasKey: 1,
        },
        {
          databaseName: 'app',
          tableName: 'audit',
          tableType: 'BASE TABLE',
          engine: 'InnoDB',
          hasKey: 0,
        },
        { databaseName: 'app', tableName: 'summary', tableType: 'VIEW', engine: null, hasKey: 0 },
      ],
    })
    expect(report.server).toEqual({ product: 'mysql', version: '8.4.1' })
    expect(report.tables.map((table) => table.kind)).toEqual(['base-table', 'base-table', 'view'])
    expect(report.warnings).toEqual([{ code: 'KEYLESS_TABLE', database: 'app', table: 'audit' }])
    expect(
      state.queries.filter(({ values }) => values).every(({ sql }) => sql.includes('(?)')),
    ).toBe(true)
    expect(state.ended()).toBe(1)
  })

  it('rejects selected non-InnoDB base tables but not views', async () => {
    await expect(
      preflight({
        tables: [
          {
            databaseName: 'app',
            tableName: 'legacy',
            tableType: 'BASE TABLE',
            engine: 'MyISAM',
            hasKey: 1,
          },
        ],
      }),
    ).rejects.toThrow(/non-InnoDB/u)
  })

  it('rejects replica profile on a primary and insufficient safe-lock privileges', async () => {
    await expect(preflight({}, 'replica')).rejects.toThrow(/configured replica/u)
    await expect(preflight({ grants: [{ grant: 'GRANT SELECT ON *.* TO user' }] })).rejects.toThrow(
      /safe lock strategy/u,
    )
  })
})
