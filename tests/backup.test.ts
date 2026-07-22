import { chmod, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { runBackup } from '../src/core/backup.js'
import { defaultConfig, type PorteauConfig } from '../src/core/config.js'
import type { QueryConnection } from '../src/core/database.js'

const fixture = fileURLToPath(new URL('./fixtures/subprocess.mjs', import.meta.url))
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function connection(): QueryConnection {
  return {
    async query(sql) {
      if (sql.includes('@@version AS')) return [{ version: '8.4.1', versionComment: 'MySQL' }]
      if (sql.includes('SCHEMATA')) return [{ databaseName: 'app' }]
      if (sql.includes('information_schema.TABLES'))
        return [
          {
            databaseName: 'app',
            tableName: 'users',
            tableType: 'BASE TABLE',
            engine: 'InnoDB',
            hasKey: 1,
          },
        ]
      if (sql === 'SHOW GRANTS')
        return [
          {
            grant:
              'GRANT SELECT, RELOAD, PROCESS, BACKUP_ADMIN, SHOW VIEW, TRIGGER ON *.* TO backup',
          },
        ]
      if (sql.includes('gtid_mode')) return [{ gtidMode: 'ON', logBin: 1 }]
      throw new Error(`unexpected test query: ${sql}`)
    },
    async end() {},
    destroy() {},
  }
}

function backupConfig(
  artifactsDirectory: string,
  overrides: Partial<PorteauConfig> = {},
): PorteauConfig {
  return {
    ...defaultConfig,
    ...overrides,
    artifacts: { directory: artifactsDirectory },
    servers: {
      local: {
        ...defaultConfig.servers.local,
        user: 'backup',
        password: 'secret',
        ...overrides.servers?.local,
      },
    },
    backup: {
      ...defaultConfig.backup,
      compression: 'none',
      ...overrides.backup,
    },
  } as PorteauConfig
}

describe('safe backup service', () => {
  it('requires tool, preflight, event, process and artifact agreement before atomic finalization', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-backup-'))
    directories.push(cwd)
    await chmod(fixture, 0o755)
    await symlink(fixture, join(cwd, 'mydumper'))
    await symlink(fixture, join(cwd, 'myloader'))
    const config = backupConfig('./final')

    await expect(
      runBackup({
        config,
        configDirectory: cwd,
        environment: { PATH: `${cwd}${delimiter}${dirname(process.execPath)}` },
        connectionFactory: async () => connection(),
      }),
    ).resolves.toEqual({ outputDirectory: join(cwd, 'final'), warnings: 0 })
    expect(await readFile(join(cwd, 'final', 'metadata'), 'utf8')).toContain('[`app`.`users`]')
    await expect(
      runBackup({
        config,
        configDirectory: cwd,
        environment: { PATH: `${cwd}${delimiter}${dirname(process.execPath)}` },
        connectionFactory: async () => connection(),
      }),
    ).rejects.toThrow(/already exists/)
  })

  it('keeps the lock watchdog armed until a qualified post-unlock event', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-lock-'))
    directories.push(cwd)
    await symlink(fixture, join(cwd, 'mydumper'))
    await symlink(fixture, join(cwd, 'myloader'))
    const config = backupConfig('./never-finalized')

    await expect(
      runBackup({
        config,
        configDirectory: cwd,
        environment: {
          PATH: `${cwd}${delimiter}${dirname(process.execPath)}`,
          PORTEAU_FIXTURE_LOCK_HANG: '1',
        },
        connectionFactory: async () => connection(),
      }),
    ).rejects.toThrow(/safety budget/)
    await expect(lstat(join(cwd, 'never-finalized'))).rejects.toThrow()
  }, 20_000)

  it('invokes mydumper NO_LOCK without throttle for no-lock mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-no-lock-'))
    directories.push(cwd)
    await symlink(fixture, join(cwd, 'mydumper'))
    await symlink(fixture, join(cwd, 'myloader'))
    const invocation = join(cwd, 'invocation.json')
    const config = backupConfig('./no-lock-final', {
      backup: {
        ...defaultConfig.backup,
        compression: 'none',
        consistency: {
          ...defaultConfig.backup.consistency,
          mode: 'no-lock',
          protectDdl: false,
        },
      },
    })
    const grants = [
      {
        grant: 'GRANT SELECT, SHOW VIEW, TRIGGER ON `app`.* TO backup',
      },
    ]

    await expect(
      runBackup({
        config,
        configDirectory: cwd,
        environment: {
          PATH: `${cwd}${delimiter}${dirname(process.execPath)}`,
          PORTEAU_FIXTURE_INVOCATION: invocation,
        },
        connectionFactory: async () => {
          const base = connection()
          return {
            ...base,
            async query(sql) {
              if (sql === 'SHOW GRANTS') return grants
              return base.query(sql)
            },
          }
        },
      }),
    ).resolves.toEqual({ outputDirectory: join(cwd, 'no-lock-final'), warnings: 0 })
    const args = JSON.parse(await readFile(invocation, 'utf8')) as string[]
    expect(args).toContain('--sync-thread-lock-mode=NO_LOCK')
    expect(args).toContain('--skip-ddl-locks')
    expect(args).toContain('--ignore-errors=1227')
    expect(args.some((argument) => argument.startsWith('--throttle='))).toBe(false)
  })

  it.each([
    ['missing lifecycle transition', { PORTEAU_FIXTURE_LIFECYCLE: 'missing' }],
    ['reordered lifecycle transition', { PORTEAU_FIXTURE_LIFECYCLE: 'reordered' }],
    ['completion/artifact file-count disagreement', { PORTEAU_FIXTURE_FILE_COUNT: '5' }],
  ])('does not publish on %s', async (_name, fixtureEnvironment) => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-reject-'))
    directories.push(cwd)
    await symlink(fixture, join(cwd, 'mydumper'))
    await symlink(fixture, join(cwd, 'myloader'))
    const config = backupConfig('./rejected')
    await expect(
      runBackup({
        config,
        configDirectory: cwd,
        environment: {
          PATH: `${cwd}${delimiter}${dirname(process.execPath)}`,
          ...fixtureEnvironment,
        },
        connectionFactory: async () => connection(),
      }),
    ).rejects.toThrow()
    await expect(lstat(join(cwd, 'rejected'))).rejects.toThrow()
  })
})
