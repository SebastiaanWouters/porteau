import { describe, expect, it } from 'vite-plus/test'
import { defaultConfig, defaultServer, type PorteauConfig } from '../src/core/config.js'
import {
  connectionOptions,
  DatabaseError,
  queryWithDeadline,
  sanitizeDatabaseError,
  tlsOptions,
  type QueryConnection,
} from '../src/core/database.js'
import { runBackupPreflight, runRestorePreflight } from '../src/core/preflight.js'

const config = defaultConfig as PorteauConfig

function backupPreflightArgs(
  cfg: PorteauConfig,
  rest: {
    readonly databases: readonly string[]
    readonly tablePatterns: readonly string[]
    readonly profile?: 'production' | 'replica' | 'expert'
    readonly connectionFactory?: Parameters<typeof runBackupPreflight>[0]['connectionFactory']
  },
) {
  const server = defaultServer(cfg)
  return {
    connection: {
      host: server.host,
      port: server.port,
      ...(server.user !== undefined ? { user: server.user } : {}),
      ...(server.password !== undefined ? { password: server.password } : {}),
      tls: server.tls,
    },
    includeViews: cfg.objects.views,
    includeTriggers: cfg.objects.triggers,
    profile: rest.profile ?? cfg.backup.profile,
    consistencyMode: cfg.backup.consistency.mode,
    databases: rest.databases,
    tablePatterns: rest.tablePatterns,
    ...(rest.connectionFactory ? { connectionFactory: rest.connectionFactory } : {}),
  }
}

function restoreConnection(cfg: PorteauConfig = config) {
  const server = defaultServer(cfg)
  return {
    host: server.host,
    port: server.port,
    ...(server.user !== undefined ? { user: server.user } : {}),
    ...(server.password !== undefined ? { password: server.password } : {}),
    tls: server.tls,
  }
}

type Responses = {
  databases?: readonly unknown[]
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
      if (sql.includes('SCHEMATA')) return responses.databases ?? [{ databaseName: 'app' }]
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
  const report = await runBackupPreflight(
    backupPreflightArgs(config, {
      databases: ['app'],
      tablePatterns: ['app.*'],
      profile,
      connectionFactory: async () => state.connection,
    }),
  )
  return { report, state }
}

function safeNoLockConfig(): PorteauConfig {
  return {
    ...config,
    backup: {
      ...config.backup,
      profile: 'expert',
      consistency: {
        ...config.backup.consistency,
        mode: 'safe-no-lock',
        protectDdl: false,
      },
    },
  }
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

  it('accepts safe-no-lock without lock-administration privileges', async () => {
    const state = fake({
      grants: [
        { grant: 'GRANT REPLICATION CLIENT ON *.* TO user' },
        { grant: 'GRANT SELECT, SHOW VIEW, TRIGGER ON `app`.* TO user' },
      ],
    })

    await expect(
      runBackupPreflight(
        backupPreflightArgs(safeNoLockConfig(), {
          databases: ['app'],
          tablePatterns: ['app.*'],
          connectionFactory: async () => state.connection,
        }),
      ),
    ).resolves.toHaveProperty('tables')
  })

  it.each(['SELECT', 'SHOW VIEW', 'TRIGGER'])(
    'still requires %s for safe-no-lock when its corresponding content is enabled',
    async (missingPrivilege) => {
      const state = fake({
        grants: [
          { grant: 'GRANT REPLICATION CLIENT ON *.* TO user' },
          {
            grant: `GRANT ${['SELECT', 'SHOW VIEW', 'TRIGGER']
              .filter((privilege) => privilege !== missingPrivilege)
              .join(', ')} ON \`app\`.* TO user`,
          },
        ],
      })

      await expect(
        runBackupPreflight(
          backupPreflightArgs(safeNoLockConfig(), {
            databases: ['app'],
            tablePatterns: ['app.*'],
            connectionFactory: async () => state.connection,
          }),
        ),
      ).rejects.toThrow(new RegExp(missingPrivilege, 'u'))
    },
  )

  it('requires REPLICATION CLIENT for safe-no-lock consistency checks', async () => {
    const state = fake({
      grants: [{ grant: 'GRANT SELECT, SHOW VIEW, TRIGGER ON `app`.* TO user' }],
    })

    await expect(
      runBackupPreflight(
        backupPreflightArgs(safeNoLockConfig(), {
          databases: ['app'],
          tablePatterns: ['app.*'],
          connectionFactory: async () => state.connection,
        }),
      ),
    ).rejects.toThrow(/REPLICATION CLIENT/u)
  })

  it('rejects replica profile on a primary and insufficient safe-lock privileges', async () => {
    await expect(preflight({}, 'replica')).rejects.toThrow(/configured replica/u)
    await expect(preflight({ grants: [{ grant: 'GRANT SELECT ON *.* TO user' }] })).rejects.toThrow(
      /auto strategy/u,
    )
  })

  it.each(['GRANT SELECT ON `other`.* TO user', 'GRANT SELECT ON `app`.`users` TO user'])(
    'rejects incomplete SELECT catalog proof from %s',
    async (selectGrant) => {
      await expect(
        preflight({
          grants: [
            { grant: 'GRANT RELOAD, PROCESS, BACKUP_ADMIN ON *.* TO user' },
            { grant: selectGrant },
            { grant: 'GRANT SHOW VIEW, TRIGGER ON `app`.* TO user' },
          ],
        }),
      ).rejects.toThrow(/auto strategy/)
    },
  )

  it('accepts exact global administration and whole-database object grants', async () => {
    await expect(
      preflight({
        grants: [
          { grant: 'GRANT RELOAD, PROCESS, BACKUP_ADMIN ON *.* TO user' },
          { grant: 'GRANT SELECT, SHOW VIEW, TRIGGER ON `app`.* TO user' },
        ],
      }),
    ).resolves.toHaveProperty('report.tables')
  })

  it('matches escaped wildcard characters in database grant scopes', async () => {
    const state = fake({
      databases: [{ databaseName: 'scone_preview' }],
      tables: [
        {
          databaseName: 'scone_preview',
          tableName: 'users',
          tableType: 'BASE TABLE',
          engine: 'InnoDB',
          hasKey: 1,
        },
      ],
      grants: [
        { grant: 'GRANT REPLICATION CLIENT ON *.* TO user' },
        { grant: 'GRANT ALL PRIVILEGES ON `scone\\_preview`.* TO user' },
      ],
    })

    await expect(
      runBackupPreflight(
        backupPreflightArgs(safeNoLockConfig(), {
          databases: ['scone_preview'],
          tablePatterns: ['scone_preview.*'],
          connectionFactory: async () => state.connection,
        }),
      ),
    ).resolves.toHaveProperty('tables')
  })

  it.each(['SELECT', 'SHOW VIEW', 'TRIGGER'])(
    'subtracts a database-scoped partial revoke of %s from global backup privileges',
    async (privilege) => {
      await expect(
        preflight({
          grants: [
            {
              grant:
                'GRANT SELECT, RELOAD, PROCESS, BACKUP_ADMIN, SHOW VIEW, TRIGGER ON *.* TO user',
            },
            { grant: `REVOKE ${privilege} ON \`app\`.* FROM user` },
          ],
        }),
      ).rejects.toThrow(/auto strategy/u)
    },
  )

  it('requires data privileges across every selected database', async () => {
    const state = fake({
      databases: [{ databaseName: 'app' }, { databaseName: 'audit' }],
      grants: [
        { grant: 'GRANT RELOAD, PROCESS, BACKUP_ADMIN ON *.* TO user' },
        { grant: 'GRANT SELECT, SHOW VIEW, TRIGGER ON `app`.* TO user' },
      ],
    })
    await expect(
      runBackupPreflight(
        backupPreflightArgs(config, {
          databases: ['app', 'audit'],
          tablePatterns: ['app.*'],
          connectionFactory: async () => state.connection,
        }),
      ),
    ).rejects.toThrow(/auto strategy/)
  })

  it('accepts no-lock with only database-scoped privileges', async () => {
    const state = fake({
      grants: [{ grant: 'GRANT SELECT, SHOW VIEW, TRIGGER ON `app`.* TO user' }],
    })
    const noLockConfig: PorteauConfig = {
      ...safeNoLockConfig(),
      backup: {
        ...safeNoLockConfig().backup,
        consistency: {
          ...safeNoLockConfig().backup.consistency,
          mode: 'no-lock',
        },
      },
    }

    await expect(
      runBackupPreflight(
        backupPreflightArgs(noLockConfig, {
          databases: ['app'],
          tablePatterns: ['app.*'],
          connectionFactory: async () => state.connection,
        }),
      ),
    ).resolves.toHaveProperty('tables')
  })

  it('still requires SELECT for no-lock backups', async () => {
    const state = fake({
      grants: [{ grant: 'GRANT SHOW VIEW, TRIGGER ON `app`.* TO user' }],
    })
    const noLockConfig: PorteauConfig = {
      ...safeNoLockConfig(),
      backup: {
        ...safeNoLockConfig().backup,
        consistency: {
          ...safeNoLockConfig().backup.consistency,
          mode: 'no-lock',
        },
      },
    }

    await expect(
      runBackupPreflight(
        backupPreflightArgs(noLockConfig, {
          databases: ['app'],
          tablePatterns: ['app.*'],
          connectionFactory: async () => state.connection,
        }),
      ),
    ).rejects.toThrow(/no-lock strategy: SELECT/u)
  })
})

describe('destination restore preflight', () => {
  function destination(
    objects: string | number,
    exists = true,
    options: {
      readonly globalLogBin?: boolean
      readonly sessionLogBin?: boolean
      readonly disableEffective?: boolean
      readonly rejectDisable?: boolean
      readonly grants?: readonly unknown[]
    } = {},
  ) {
    let ended = 0
    let sessionLogBin = options.sessionLogBin ?? true
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = []
    const connection: QueryConnection = {
      async query(sql, values) {
        queries.push({ sql, ...(values ? { values } : {}) })
        if (sql.includes('@@version AS'))
          return [{ version: '8.4.1', versionComment: 'MySQL Community' }]
        if (sql.includes('information_schema.SCHEMATA'))
          return exists ? [{ databaseName: 'restored' }] : []
        if (sql === 'SHOW GRANTS')
          return options.grants ?? [{ grant: 'GRANT ALL PRIVILEGES ON *.* TO restore' }]
        if (sql.includes('AS objectCount')) return [{ objectCount: String(objects) }]
        if (sql.includes('gtid_mode'))
          return [{ gtidMode: 'ON', logBin: Number(options.globalLogBin ?? true) }]
        if (sql === 'SET SESSION sql_log_bin = 0') {
          if (options.rejectDisable)
            throw { code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR', sqlState: '42000' }
          if (options.disableEffective !== false) sessionLogBin = false
          return []
        }
        if (sql.includes('@@session.sql_log_bin')) return [{ sessionLogBin: Number(sessionLogBin) }]
        throw new Error(`Unexpected SQL in test: ${sql}`)
      },
      async end() {
        ended += 1
      },
      destroy() {},
    }
    return { connection, queries, ended: () => ended }
  }

  it('accepts an absent or empty destination using parameterized inspection and closes', async () => {
    for (const exists of [false, true]) {
      const state = destination(0, exists)
      await expect(
        runRestorePreflight({
          connection: restoreConnection(),
          destinationDatabase: 'restored',
          destinationPolicy: 'require-empty',
          overwritePolicy: 'reject',
          binlogPolicy: 'disable',
          connectionFactory: async () => state.connection,
        }),
      ).resolves.toMatchObject({
        destination: { database: 'restored', exists, objects: 0 },
        logBin: true,
      })
      expect(state.queries.filter(({ values }) => values).map(({ values }) => values)).toEqual(
        exists ? [['restored'], ['restored', 'restored', 'restored']] : [['restored']],
      )
      expect(state.ended()).toBe(1)
    }
  })

  it('refuses existing objects by default and destructive policy without allow-existing', async () => {
    const nonempty = destination(2)
    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'restored',
        destinationPolicy: 'require-empty',
        overwritePolicy: 'reject',
        binlogPolicy: 'disable',
        connectionFactory: async () => nonempty.connection,
      }),
    ).rejects.toThrow(/not empty/u)
    expect(nonempty.ended()).toBe(1)
    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'restored',
        destinationPolicy: 'require-empty',
        overwritePolicy: 'drop',
        binlogPolicy: 'disable',
        connectionFactory: async () => destination(0).connection,
      }),
    ).rejects.toThrow(/allow-existing/u)
  })

  it('allows existing objects only through an explicit existing-destination policy', async () => {
    const state = destination(2)
    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'restored',
        destinationPolicy: 'allow-existing',
        overwritePolicy: 'truncate',
        binlogPolicy: 'disable',
        connectionFactory: async () => state.connection,
      }),
    ).resolves.toMatchObject({ destination: { exists: true, objects: 2 } })
  })

  it('requires a valid complete object count and an enabled session for enable-binlog policy', async () => {
    const malformed = destination('not-a-count')
    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'restored',
        destinationPolicy: 'require-empty',
        overwritePolicy: 'reject',
        binlogPolicy: 'disable',
        connectionFactory: async () => malformed.connection,
      }),
    ).rejects.toThrow(/invalid object count/u)

    const disabled = destination(0, true, { sessionLogBin: false })
    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'restored',
        destinationPolicy: 'require-empty',
        overwritePolicy: 'reject',
        binlogPolicy: 'enable',
        connectionFactory: async () => disabled.connection,
      }),
    ).rejects.toThrow(/binlogging is disabled/u)

    const globallyDisabled = destination(0, true, { globalLogBin: false })
    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'restored',
        destinationPolicy: 'require-empty',
        overwritePolicy: 'reject',
        binlogPolicy: 'enable',
        connectionFactory: async () => globallyDisabled.connection,
      }),
    ).rejects.toThrow(/binlogging is disabled/u)
  })

  it('proves disable-binlog capability and complete catalog visibility', async () => {
    const ineffective = destination(0, true, { disableEffective: false })
    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'restored',
        destinationPolicy: 'require-empty',
        overwritePolicy: 'reject',
        binlogPolicy: 'disable',
        connectionFactory: async () => ineffective.connection,
      }),
    ).rejects.toThrow(/could not be disabled/u)

    const rejected = destination(0, true, { rejectDisable: true })
    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'restored',
        destinationPolicy: 'require-empty',
        overwritePolicy: 'reject',
        binlogPolicy: 'disable',
        connectionFactory: async () => rejected.connection,
      }),
    ).rejects.toMatchObject({ code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR' })

    const hidden = destination(0, true, {
      grants: [{ grant: 'GRANT CREATE, INSERT, SELECT ON `restored`.* TO restore' }],
    })
    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'restored',
        destinationPolicy: 'require-empty',
        overwritePolicy: 'reject',
        binlogPolicy: 'disable',
        connectionFactory: async () => hidden.connection,
      }),
    ).rejects.toThrow(/catalog visibility/u)

    const wholeDatabase = destination(0, true, {
      grants: [{ grant: 'GRANT ALL PRIVILEGES ON `restored`.* TO restore' }],
    })
    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'restored',
        destinationPolicy: 'require-empty',
        overwritePolicy: 'reject',
        binlogPolicy: 'disable',
        connectionFactory: async () => wholeDatabase.connection,
      }),
    ).resolves.toMatchObject({ destination: { objects: 0 } })
  })

  it('accepts an escaped database name in a restore grant scope', async () => {
    const state = destination(0, true, {
      grants: [{ grant: 'GRANT ALL PRIVILEGES ON `scone\\_preview`.* TO restore' }],
    })

    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'scone_preview',
        destinationPolicy: 'require-empty',
        overwritePolicy: 'reject',
        binlogPolicy: 'disable',
        connectionFactory: async () => state.connection,
      }),
    ).resolves.toMatchObject({ destination: { objects: 0 } })
  })

  it('accepts the qualified MySQL 8.4 expanded global grant and rejects partial revokes', async () => {
    const expanded =
      'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, RELOAD, SHUTDOWN, PROCESS, FILE, REFERENCES, INDEX, ALTER, SHOW DATABASES, SUPER, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, REPLICATION SLAVE, REPLICATION CLIENT, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, CREATE USER, EVENT, TRIGGER, CREATE TABLESPACE, CREATE ROLE, DROP ROLE ON *.* TO `root`@`localhost` WITH GRANT OPTION'
    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'restored',
        destinationPolicy: 'require-empty',
        overwritePolicy: 'reject',
        binlogPolicy: 'disable',
        connectionFactory: async () =>
          destination(0, true, { grants: [{ grant: expanded }] }).connection,
      }),
    ).resolves.toMatchObject({ destination: { objects: 0 } })

    await expect(
      runRestorePreflight({
        connection: restoreConnection(),
        destinationDatabase: 'restored',
        destinationPolicy: 'require-empty',
        overwritePolicy: 'reject',
        binlogPolicy: 'disable',
        connectionFactory: async () =>
          destination(0, true, {
            grants: [
              { grant: expanded },
              { grant: 'REVOKE SELECT ON `restored`.* FROM `root`@`localhost`' },
            ],
          }).connection,
      }),
    ).rejects.toThrow(/catalog visibility/u)
  })

  it.each(['mysql', 'information_schema', 'performance_schema', 'sys'])(
    'refuses system destination %s before connecting',
    async (destinationDatabase) => {
      let connected = false
      await expect(
        runRestorePreflight({
          connection: restoreConnection(),
          destinationDatabase,
          destinationPolicy: 'require-empty',
          overwritePolicy: 'reject',
          binlogPolicy: 'disable',
          connectionFactory: async () => {
            connected = true
            return destination(0).connection
          },
        }),
      ).rejects.toThrow(/system database/u)
      expect(connected).toBe(false)
    },
  )
})
