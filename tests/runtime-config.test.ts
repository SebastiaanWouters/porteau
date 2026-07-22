import { describe, expect, it } from 'vite-plus/test'
import {
  createResolvedArtifacts,
  createResolvedRun,
  defaultBackupOutputDirectory,
  effectiveUser,
  mysqlDatabaseNames,
  type ResolvedBackupSettings,
  type ResolvedExclude,
  type ResolvedObjects,
  type ResolvedRestoreSettings,
  type ResolvedRunInput,
  type ResolvedTools,
} from '../src/core/runtime-config.js'

const backup: ResolvedBackupSettings = {
  profile: 'production',
  threads: 4,
  compression: 'zstd',
  consistency: { mode: 'auto', protectDdl: true },
  throttle: { enabled: false, threshold: null },
}

const restore: ResolvedRestoreSettings = {
  threads: 4,
  destinationPolicy: 'require-empty',
  overwritePolicy: 'reject',
  binlogPolicy: 'disable',
}

const exclude: ResolvedExclude = { tables: [], data: [] }
const objects: ResolvedObjects = { triggers: true, views: true }
const tools: ResolvedTools = {}

function minimalRunInput(overrides: Partial<ResolvedRunInput> = {}): ResolvedRunInput {
  return {
    server: {
      id: 'local',
      host: '127.0.0.1',
      port: 3306,
      user: 'server-user',
      tls: 'preferred',
    },
    databases: [{ id: 'app', name: 'app_db' }],
    artifactsDirectory: '/var/backups/porteau',
    backup,
    restore,
    exclude,
    objects,
    tools,
    ...overrides,
  }
}

describe('runtime-config constructors', () => {
  it('rejects an empty databases list', () => {
    expect(() => createResolvedRun(minimalRunInput({ databases: [] }))).toThrow(
      /databases must be non-empty/,
    )
  })

  it('rejects a relative artifacts directory on createResolvedRun', () => {
    expect(() =>
      createResolvedRun(minimalRunInput({ artifactsDirectory: 'relative/out' })),
    ).toThrow(/must be absolute/)
  })

  it('rejects a relative path on createResolvedArtifacts', () => {
    expect(() => createResolvedArtifacts('relative/out')).toThrow(/must be absolute/)
  })

  it('constructs a legal minimal run', () => {
    const run = createResolvedRun(minimalRunInput())
    expect(run.server.id).toBe('local')
    expect(run.server.host).toBe('127.0.0.1')
    expect(run.server.port).toBe(3306)
    expect(run.server.tls).toBe('preferred')
    expect(run.databases).toHaveLength(1)
    expect(run.databases[0].id).toBe('app')
    expect(run.databases[0].name).toBe('app_db')
    expect(run.artifacts.directory).toBe('/var/backups/porteau')
    expect(run.backup).toEqual(backup)
    expect(run.restore).toEqual(restore)
  })
})

describe('runtime-config accessors', () => {
  it('returns MySQL database names in selection order', () => {
    const run = createResolvedRun(
      minimalRunInput({
        databases: [
          { id: 'primary', name: 'db_a' },
          { id: 'secondary', name: 'db_b' },
        ],
      }),
    )
    expect(mysqlDatabaseNames(run)).toEqual(['db_a', 'db_b'])
  })

  it('builds the default backup output from the first database id and date', () => {
    const run = createResolvedRun(
      minimalRunInput({
        databases: [
          { id: 'shop', name: 'shop_prod' },
          { id: 'other', name: 'other_db' },
        ],
        artifactsDirectory: '/artifacts',
      }),
    )
    expect(defaultBackupOutputDirectory(run, '2026-07-22')).toBe('/artifacts/shop-2026-07-22')
  })

  it('prefers database.user over server.user', () => {
    const run = createResolvedRun(
      minimalRunInput({
        server: {
          id: 'local',
          host: '127.0.0.1',
          port: 3306,
          user: 'server-user',
          tls: 'disabled',
        },
        databases: [{ id: 'app', name: 'app_db', user: 'db-user' }],
      }),
    )
    expect(effectiveUser(run, run.databases[0])).toBe('db-user')
  })

  it('falls back to server.user when the database has no user', () => {
    const run = createResolvedRun(minimalRunInput())
    expect(effectiveUser(run, run.databases[0])).toBe('server-user')
  })
})
