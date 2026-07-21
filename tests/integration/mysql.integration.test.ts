import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { runBackup } from '../../src/core/backup.js'
import { defaultConfig, type PorteauConfig } from '../../src/core/config.js'

const enabled = process.env.PORTEAU_MYSQL_INTEGRATION === '1'
const host = process.env.MYSQL_HOST ?? 'mysql'
const password = process.env.MYSQL_PWD ?? ''
const root = join(tmpdir(), `porteau-mysql-qualification-${process.pid}`)
const suite = enabled ? describe : describe.skip
const loaderConnection = ['-h', host, '-u', 'root']

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
    const db = await mysql.createConnection({
      host,
      user: 'root',
      password,
      ssl: {},
      multipleStatements: true,
    })
    await db.query(`
      CREATE DATABASE safe_app;
      CREATE TABLE safe_app.rows(
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        value VARCHAR(80) NOT NULL
      ) ENGINE=InnoDB;
      CREATE TABLE safe_app.omitted(id INT PRIMARY KEY) ENGINE=InnoDB;
      INSERT INTO safe_app.rows(value)
        SELECT UUID() FROM information_schema.COLUMNS a, information_schema.COLUMNS b LIMIT 50000;
      INSERT INTO safe_app.omitted VALUES (1);
      CREATE DATABASE unsafe_app;
      CREATE TABLE unsafe_app.unsafe(id INT) ENGINE=MyISAM;
    `)
    await db.end()
  }, 60_000)

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('backs up through Porteau under writes, applies filters, and restores with pinned myloader', async () => {
    const output = join(root, 'consistent')
    const events: string[] = []
    const writer = await mysql.createConnection({ host, user: 'root', password, ssl: {} })
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
      exclude: { schema: [], data: ['safe_app.omitted'] },
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
    expect(artifact).toContain('safe_app.omitted-schema.sql')
    expect(artifact.some((name) => /^safe_app\.omitted\.\d+\.sql$/u.test(name))).toBe(false)
    expect(events).toEqual(
      expect.arrayContaining([
        'lock/global_lock/started',
        'backup_consistency/startup/finished',
        'table_unlock/startup/finished',
        'dump_phase/wait_database_finish/progress',
      ]),
    )
    const load = spawnSync(
      'myloader',
      [...loaderConnection, `--directory=${output}`, '--source-db=safe_app', '--database=restored'],
      { encoding: 'utf8', env: { ...process.env, MYSQL_PWD: password } },
    )
    expect(load.status, load.stderr).toBe(0)
    const verify = await mysql.createConnection({ host, user: 'root', password, ssl: {} })
    const [rows] = await verify.query('SELECT COUNT(*) count FROM restored.rows')
    const [omitted] = await verify.query('SELECT COUNT(*) count FROM restored.omitted')
    await verify.end()
    expect(Number((rows as { count: number }[])[0]!.count)).toBeGreaterThan(0)
    expect(Number((omitted as { count: number }[])[0]!.count)).toBe(0)
  }, 90_000)

  it('rejects a selected nontransactional table before creating output', async () => {
    const output = join(root, 'unsafe')
    await expect(runBackup({ config: config('unsafe_app', output) })).rejects.toThrow(/non-InnoDB/)
    await expect(readdir(output)).rejects.toThrow()
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
