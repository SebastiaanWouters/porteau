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

describe('safe backup service', () => {
  it('requires tool, preflight, event, process and artifact agreement before atomic finalization', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-backup-'))
    directories.push(cwd)
    await chmod(fixture, 0o755)
    await symlink(fixture, join(cwd, 'mydumper'))
    await symlink(fixture, join(cwd, 'myloader'))
    const config = {
      ...defaultConfig,
      connection: { ...defaultConfig.connection, user: 'backup', password: 'secret' },
      include: { databases: ['app'] },
      backup: { ...defaultConfig.backup, directory: './final', compression: 'none' },
    } as PorteauConfig

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
    const config = {
      ...defaultConfig,
      connection: { ...defaultConfig.connection, user: 'backup', password: 'secret' },
      include: { databases: ['app'] },
      backup: {
        ...defaultConfig.backup,
        directory: './never-finalized',
        compression: 'none',
        consistency: { ...defaultConfig.backup.consistency, startupLockTimeoutSeconds: 1 },
      },
    } as PorteauConfig

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
  })
})
