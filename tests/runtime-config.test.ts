import { isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { defaultConfig, validateConfig } from '../src/core/config.js'
import {
  asDatabaseId,
  asServerId,
  createResolvedArtifacts,
  createResolvedRun,
  defaultBackupOutputDirectory,
  effectiveUser,
  mysqlDatabaseNames,
  resolveRun,
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

const resolveFixture = validateConfig({
  ...defaultConfig,
  artifacts: { directory: './backups' },
  defaults: { server: 'local', database: 'app' },
  servers: {
    local: {
      host: '127.0.0.1',
      port: 3306,
      user: 'server-user',
      password: 'secret',
      tls: 'preferred',
    },
    staging: {
      host: 'staging.example',
      port: 3307,
      user: 'staging-user',
      tls: 'required',
    },
  },
  databases: {
    app: { name: 'app_db' },
    analytics: { name: 'analytics_db', user: 'analytics-user' },
  },
})

const resolveContext = { configDirectory: '/etc/porteau' }

describe('resolveRun', () => {
  it('applies defaults when selection is omitted', () => {
    const run = resolveRun(resolveFixture, undefined, resolveContext)
    expect(run.server.id).toBe('local')
    expect(run.server.host).toBe('127.0.0.1')
    expect(run.databases).toHaveLength(1)
    expect(run.databases[0].id).toBe('app')
    expect(run.databases[0].name).toBe('app_db')
  })

  it('applies defaults when selection databases is empty', () => {
    const run = resolveRun(resolveFixture, { databases: [] }, resolveContext)
    expect(run.server.id).toBe('local')
    expect(run.databases[0].id).toBe('app')
  })

  it('lets explicit server and database selection win', () => {
    const run = resolveRun(
      resolveFixture,
      {
        server: asServerId('staging'),
        databases: [asDatabaseId('analytics')],
      },
      resolveContext,
    )
    expect(run.server.id).toBe('staging')
    expect(run.server.host).toBe('staging.example')
    expect(run.server.port).toBe(3307)
    expect(run.server.user).toBe('staging-user')
    expect(run.server.tls).toBe('required')
    expect(run.databases[0].id).toBe('analytics')
    expect(run.databases[0].name).toBe('analytics_db')
  })

  it('lists known server keys for an unknown server', () => {
    expect(() =>
      resolveRun(resolveFixture, { server: asServerId('missing') }, resolveContext),
    ).toThrow(/Unknown server "missing". Known servers: local, staging/)
  })

  it('lists known database keys for an unknown database', () => {
    expect(() =>
      resolveRun(resolveFixture, { databases: [asDatabaseId('missing')] }, resolveContext),
    ).toThrow(/Unknown database "missing". Known databases: analytics, app/)
  })

  it('resolves artifacts.directory absolute against configDirectory', () => {
    const run = resolveRun(resolveFixture, undefined, resolveContext)
    expect(run.artifacts.directory).toBe(join('/etc/porteau', 'backups'))
    expect(isAbsolute(run.artifacts.directory)).toBe(true)
  })

  it('preserves per-database user on ResolvedDatabase', () => {
    const run = resolveRun(
      resolveFixture,
      { databases: [asDatabaseId('analytics')] },
      resolveContext,
    )
    expect(run.databases[0].user).toBe('analytics-user')
    expect(effectiveUser(run, run.databases[0])).toBe('analytics-user')
  })

  it('does not copy password onto ResolvedServer', () => {
    const run = resolveRun(resolveFixture, undefined, resolveContext)
    expect(run.server).not.toHaveProperty('password')
    expect(resolveFixture.servers.local?.password).toBe('secret')
  })

  it('copies backup, restore, exclude, objects, and tools settings', () => {
    const run = resolveRun(resolveFixture, undefined, resolveContext)
    expect(run.backup).toEqual(resolveFixture.backup)
    expect(run.restore).toEqual(resolveFixture.restore)
    expect(run.exclude).toEqual(resolveFixture.exclude)
    expect(run.objects).toEqual(resolveFixture.objects)
    expect(run.tools).toEqual(resolveFixture.tools)
  })
})
