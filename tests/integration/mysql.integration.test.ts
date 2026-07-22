import { access, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { runBackup } from '../../src/core/backup.js'
import { defaultConfig, type PorteauConfig } from '../../src/core/config.js'
import { runBackupPreflight, runRestorePreflight } from '../../src/core/preflight.js'
import { runRestore } from '../../src/core/restore.js'

const enabled = process.env.PORTEAU_MYSQL_INTEGRATION === '1'
const host = process.env.MYSQL_HOST ?? 'mysql'
const password = process.env.MYSQL_PWD ?? ''
const root = join(tmpdir(), `porteau-mysql-qualification-${process.pid}`)
const suite = enabled ? describe : describe.skip
const disposableTls = { rejectUnauthorized: false }

function config(database: string, output: string): PorteauConfig {
  return {
    ...defaultConfig,
    connection: {
      ...defaultConfig.connection,
      host,
      user: 'root',
      password,
      tls: 'required',
    },
    include: { databases: [database] },
    backup: {
      ...defaultConfig.backup,
      directory: output,
      compression: 'none',
      throttle: { ...defaultConfig.backup.throttle, enabled: false },
    },
  } as PorteauConfig
}

suite('Porteau against pinned MySQL and mydumper', () => {
  beforeAll(async () => {
    await access('/.dockerenv').catch(() => {
      throw new Error('MySQL qualification must run inside the disposable Compose container')
    })
    const db = await mysql.createConnection({
      host,
      user: 'root',
      password,
      ssl: disposableTls,
      multipleStatements: true,
    })
    await db.query(`
      CREATE DATABASE safe_app;
      CREATE TABLE safe_app.rows(
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        value VARCHAR(80) NOT NULL
      ) ENGINE=InnoDB;
      CREATE TABLE safe_app.schema_only(id INT PRIMARY KEY) ENGINE=InnoDB;
      CREATE TABLE safe_app.excluded(id INT PRIMARY KEY) ENGINE=InnoDB;
      INSERT INTO safe_app.rows(value)
        SELECT UUID() FROM information_schema.COLUMNS a, information_schema.COLUMNS b LIMIT 5000;
      INSERT INTO safe_app.schema_only VALUES (1);
      INSERT INTO safe_app.excluded VALUES (1);
      CREATE VIEW safe_app.row_view AS SELECT id, value FROM safe_app.rows WHERE id <= 10;
      CREATE DATABASE unsafe_app;
      CREATE TABLE unsafe_app.unsafe(id INT) ENGINE=MyISAM;
      CREATE USER 'partially_revoked'@'%' IDENTIFIED BY 'partial-only';
      GRANT ALL PRIVILEGES ON *.* TO 'partially_revoked'@'%';
      GRANT BACKUP_ADMIN ON *.* TO 'partially_revoked'@'%';
      REVOKE SELECT ON safe_app.* FROM 'partially_revoked'@'%';
      CREATE USER 'no_lock_backup'@'%' IDENTIFIED BY 'no-lock-only';
      GRANT SELECT, SHOW VIEW, TRIGGER ON safe_app.* TO 'no_lock_backup'@'%';
      GRANT REPLICATION CLIENT ON *.* TO 'no_lock_backup'@'%';
    `)
    await db.end()
  }, 60_000)

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips through guarded Porteau backup and restore under writes', async () => {
    const output = join(root, 'consistent')
    const events: string[] = []
    const writer = await mysql.createConnection({
      host,
      user: 'root',
      password,
      ssl: disposableTls,
    })
    const [initial] = await writer.query('SELECT COUNT(*) count FROM safe_app.rows')
    const initialRows = Number((initial as { count: number }[])[0]!.count)
    let writing = true
    let writes = 0
    const writeLoop = (async () => {
      while (writing) {
        await writer.query('INSERT INTO safe_app.rows(value) VALUES (UUID())')
        writes += 1
      }
    })()
    const backupConfig = {
      ...config('safe_app', output),
      exclude: { tables: ['safe_app.excluded'], data: ['safe_app.schema_only'] },
    }
    try {
      await runBackup({
        config: backupConfig,
        onEvent(event) {
          events.push(`${event.sourceEvent}/${event.sourcePhase}/${event.sourceStatus}`)
        },
      })
    } finally {
      writing = false
      await writeLoop
      await writer.end()
    }

    expect(writes).toBeGreaterThan(0)
    const artifact = await readdir(output)
    expect(artifact).toContain('safe_app.schema_only-schema.sql')
    expect(artifact.some((name) => /^safe_app\.schema_only\.\d+\.sql$/u.test(name))).toBe(false)
    expect(artifact.some((name) => name.startsWith('safe_app.excluded'))).toBe(false)
    expect(artifact).toEqual(
      expect.arrayContaining(['safe_app.row_view-schema.sql', 'safe_app.row_view-schema-view.sql']),
    )
    expect(events).toEqual(
      expect.arrayContaining([
        'lock/global_lock/started',
        'backup_consistency/startup/finished',
        'table_unlock/startup/finished',
        'dump_phase/wait_database_finish/progress',
      ]),
    )
    const restoreEvents: string[] = []
    await expect(
      runRestore({
        config: backupConfig,
        request: {
          artifactPath: output,
          sourceDatabase: 'safe_app',
          destinationDatabase: 'restored',
          destinationPolicy: 'require-empty',
          overwritePolicy: 'reject',
          binlogPolicy: 'disable',
        },
        confirm: () => true,
        onEvent(event) {
          restoreEvents.push(`${event.sourceEvent}/${event.sourcePhase}/${event.sourceStatus}`)
        },
      }),
    ).resolves.toEqual({ destinationDatabase: 'restored', warnings: expect.any(Number) })
    expect(restoreEvents).toEqual(
      expect.arrayContaining(['restore_completed/restore_finish/finished']),
    )
    const verify = await mysql.createConnection({
      host,
      user: 'root',
      password,
      ssl: disposableTls,
    })
    const [sourceRows] = await verify.query('SELECT COUNT(*) count FROM safe_app.rows')
    const [rows] = await verify.query('SELECT COUNT(*) count FROM restored.rows')
    const [schemaOnly] = await verify.query('SELECT COUNT(*) count FROM restored.schema_only')
    const [excluded] = await verify.query(
      "SELECT COUNT(*) count FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'restored' AND TABLE_NAME = 'excluded'",
    )
    const [view] = await verify.query(
      "SELECT TABLE_TYPE tableType FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'restored' AND TABLE_NAME = 'row_view'",
    )
    await verify.end()
    const restoredRows = Number((rows as { count: number }[])[0]!.count)
    const finalSourceRows = Number((sourceRows as { count: number }[])[0]!.count)
    expect(restoredRows).toBeGreaterThanOrEqual(initialRows)
    expect(restoredRows).toBeLessThanOrEqual(finalSourceRows)
    expect(Number((schemaOnly as { count: number }[])[0]!.count)).toBe(0)
    expect(Number((excluded as { count: number }[])[0]!.count)).toBe(0)
    expect((view as { tableType: string }[])[0]!.tableType).toBe('VIEW')

    await expect(
      runRestore({
        config: backupConfig,
        request: {
          artifactPath: output,
          sourceDatabase: 'safe_app',
          destinationDatabase: 'restored',
          destinationPolicy: 'require-empty',
          overwritePolicy: 'reject',
          binlogPolicy: 'disable',
        },
        confirm: () => true,
      }),
    ).rejects.toThrow(/not empty/u)
  }, 90_000)

  it('backs up in safe-no-lock mode without global administration privileges', async () => {
    const output = join(root, 'safe-no-lock')
    const backupConfig = config('safe_app', output)
    const noLockConfig: PorteauConfig = {
      ...backupConfig,
      connection: {
        ...backupConfig.connection,
        user: 'no_lock_backup',
        password: 'no-lock-only',
      },
      backup: {
        ...backupConfig.backup,
        profile: 'expert',
        consistency: {
          ...backupConfig.backup.consistency,
          mode: 'safe-no-lock',
          protectDdl: false,
        },
      },
    }

    await expect(runBackup({ config: noLockConfig })).resolves.toEqual({
      outputDirectory: output,
      warnings: expect.any(Number),
    })
    expect(await readdir(output)).toContain('safe_app.rows-schema.sql')
  }, 90_000)

  it('rejects a selected nontransactional table before creating output', async () => {
    const output = join(root, 'unsafe')
    await expect(runBackup({ config: config('unsafe_app', output) })).rejects.toThrow(/non-InnoDB/)
    await expect(readdir(output)).rejects.toThrow()
  })

  it('subtracts real MySQL partial revokes from backup and restore visibility', async () => {
    const partialConfig = {
      ...config('safe_app', join(root, 'partial-revoke')),
      connection: {
        ...config('safe_app', root).connection,
        user: 'partially_revoked',
        password: 'partial-only',
      },
    }
    await expect(
      runBackupPreflight({
        config: partialConfig,
        databases: ['safe_app'],
        tablePatterns: ['safe_app.*'],
      }),
    ).rejects.toThrow(/safe lock strategy: SELECT/u)
    await expect(
      runRestorePreflight({
        config: partialConfig,
        destinationDatabase: 'safe_app',
        destinationPolicy: 'allow-existing',
        overwritePolicy: 'reject',
        binlogPolicy: 'enable',
      }),
    ).rejects.toThrow(/catalog visibility/u)
  })

  it('cancels the native process tree and removes partial and final artifacts', async () => {
    const output = join(root, 'cancelled')
    const controller = new AbortController()
    await expect(
      runBackup({
        config: config('safe_app', output),
        signal: controller.signal,
        onEvent(event) {
          if (event.sourceEvent === 'dump_phase') controller.abort()
        },
      }),
    ).rejects.toThrow(/cancel/i)
    await expect(readdir(output)).rejects.toThrow()
    const parent = await readdir(root)
    expect(parent.some((name) => name.includes('.partial'))).toBe(false)
    const processes = spawnSync('pgrep', ['-x', 'mydumper'], { encoding: 'utf8' })
    expect(processes.status).toBe(1)
  }, 60_000)
})
