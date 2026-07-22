import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { defaultConfig, type PorteauConfig } from '../src/core/config.js'
import type { QueryConnection } from '../src/core/database.js'
import type { RestoreRequest } from '../src/core/restore.js'
import { runRestore } from '../src/core/restore.js'

const fixture = fileURLToPath(new URL('./fixtures/subprocess.mjs', import.meta.url))
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'porteau-restore-'))
  directories.push(cwd)
  await symlink(fixture, join(cwd, 'mydumper'))
  await symlink(fixture, join(cwd, 'myloader'))
  const artifact = join(cwd, 'artifact')
  await mkdir(artifact)
  await writeFile(join(artifact, 'metadata'), '[`app`.`users`]\nrows = 1\n')
  await writeFile(join(artifact, 'app-schema-create.sql'), 'CREATE DATABASE app;')
  await writeFile(join(artifact, 'app.users-schema.sql'), 'CREATE TABLE users (id INT);')
  await writeFile(join(artifact, 'app.users.00000.sql'), 'INSERT INTO users VALUES (1);')
  return { cwd, artifact }
}

function config(): PorteauConfig {
  return {
    ...defaultConfig,
    connection: { ...defaultConfig.connection, user: 'restore', password: 'secret' },
  } as PorteauConfig
}

function request(artifactPath: string, overrides: Partial<RestoreRequest> = {}): RestoreRequest {
  return {
    artifactPath,
    sourceDatabase: 'app',
    destinationDatabase: 'restored',
    destinationPolicy: 'require-empty',
    overwritePolicy: 'reject',
    binlogPolicy: 'disable',
    ...overrides,
  }
}

function connection(objects = 0, exists = true): QueryConnection {
  let sessionLogBin = true
  return {
    async query(sql) {
      if (sql.includes('@@version AS')) return [{ version: '8.4.1', versionComment: 'MySQL' }]
      if (sql.includes('information_schema.SCHEMATA'))
        return exists ? [{ databaseName: 'restored' }] : []
      if (sql === 'SHOW GRANTS') return [{ grant: 'GRANT ALL PRIVILEGES ON *.* TO restore' }]
      if (sql.includes('AS objectCount')) return [{ objectCount: objects }]
      if (sql.includes('gtid_mode')) return [{ gtidMode: 'ON', logBin: 1 }]
      if (sql === 'SET SESSION sql_log_bin = 0') {
        sessionLogBin = false
        return []
      }
      if (sql.includes('@@session.sql_log_bin')) return [{ sessionLogBin: Number(sessionLogBin) }]
      throw new Error(`unexpected test query: ${sql}`)
    },
    async end() {},
    destroy() {},
  }
}

function environment(cwd: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: `${cwd}${delimiter}${dirname(process.execPath)}`, ...extra }
}

describe('guarded restore service', () => {
  it('rejects an empty source database before inspecting the artifact', async () => {
    await expect(
      runRestore({
        config: config(),
        request: request('/unused', { sourceDatabase: '' }),
        confirm: () => true,
      }),
    ).rejects.toThrow('Restore requires explicit source and destination databases')
  })

  it('verifies, preflights, confirms, uses protected flags, and requires completion agreement', async () => {
    const { cwd, artifact } = await workspace()
    const invocation = join(cwd, 'invocation.json')
    const summaries: unknown[] = []
    await expect(
      runRestore({
        config: config(),
        request: request(artifact),
        configDirectory: cwd,
        environment: environment(cwd, { PORTEAU_FIXTURE_INVOCATION: invocation }),
        connectionFactory: async () => connection(),
        confirm(summary) {
          summaries.push(summary)
          return true
        },
      }),
    ).resolves.toEqual({ destinationDatabase: 'restored', warnings: 0 })
    expect(summaries).toEqual([
      expect.objectContaining({
        destinationDatabase: 'restored',
        destinationExists: true,
        destinationObjects: 0,
        overwritePolicy: 'reject',
        binlogPolicy: 'disable',
      }),
    ])
    const args = JSON.parse(await readFile(invocation, 'utf8')) as string[]
    expect(args).toEqual([
      expect.stringMatching(/^--defaults-file=/u),
      '--machine-log-json',
      `--directory=${artifact}`,
      '--source-db=app',
      '--database=restored',
      '--threads=4',
      '--drop-table=FAIL',
      '--checksum=WARN',
      '--optimize-keys=AFTER_IMPORT_PER_TABLE',
      '--skip-create-database',
    ])
    const defaultsPath = args.find((value) => value.startsWith('--defaults-file='))!.slice(16)
    await expect(lstat(defaultsPath)).rejects.toThrow()
    expect(args.join(' ')).not.toContain('secret')
  })

  it('verifies the artifact before opening a destination connection', async () => {
    const { cwd, artifact } = await workspace()
    await rm(join(artifact, 'metadata'))
    let connected = false
    await expect(
      runRestore({
        config: config(),
        request: request(artifact),
        configDirectory: cwd,
        environment: environment(cwd),
        connectionFactory: async () => {
          connected = true
          return connection()
        },
        confirm: () => true,
      }),
    ).rejects.toThrow()
    expect(connected).toBe(false)

    for (const controlFile of ['metadata.header', 'metadata.partial.0', 'mydumper_extra.sql']) {
      const unsafe = await workspace()
      await writeFile(join(unsafe.artifact, controlFile), '')
      connected = false
      await expect(
        runRestore({
          config: config(),
          request: request(unsafe.artifact),
          configDirectory: unsafe.cwd,
          environment: environment(unsafe.cwd),
          connectionFactory: async () => {
            connected = true
            return connection()
          },
          confirm: () => true,
        }),
      ).rejects.toThrow(/control file/u)
      expect(connected).toBe(false)
    }

    const incomplete = await workspace()
    await rm(join(incomplete.artifact, 'app.users.00000.sql'))
    connected = false
    await expect(
      runRestore({
        config: config(),
        request: request(incomplete.artifact),
        configDirectory: incomplete.cwd,
        environment: environment(incomplete.cwd),
        connectionFactory: async () => {
          connected = true
          return connection()
        },
        confirm: () => true,
      }),
    ).rejects.toThrow(/missing data/u)
    expect(connected).toBe(false)
  })

  it('does not spawn when confirmation is declined', async () => {
    const { cwd, artifact } = await workspace()
    const invocation = join(cwd, 'invocation.json')
    const versions = join(cwd, 'version-invocation')
    await expect(
      runRestore({
        config: config(),
        request: request(artifact),
        configDirectory: cwd,
        environment: environment(cwd, {
          PORTEAU_FIXTURE_INVOCATION: invocation,
          PORTEAU_FIXTURE_VERSION_INVOCATION: versions,
        }),
        connectionFactory: async () => connection(),
        confirm: () => false,
      }),
    ).rejects.toThrow(/before destination mutation/u)
    await expect(lstat(invocation)).rejects.toThrow()
    await expect(lstat(`${versions}-mydumper`)).rejects.toThrow()
    await expect(lstat(`${versions}-myloader`)).rejects.toThrow()
  })

  it('cancels a pending confirmation without inspecting or spawning tools', async () => {
    const { cwd, artifact } = await workspace()
    const controller = new AbortController()
    const versions = join(cwd, 'version-invocation')
    let confirmationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      confirmationStarted = resolve
    })
    const pending = runRestore({
      config: config(),
      request: request(artifact),
      configDirectory: cwd,
      signal: controller.signal,
      environment: environment(cwd, { PORTEAU_FIXTURE_VERSION_INVOCATION: versions }),
      connectionFactory: async () => connection(),
      confirm: () => {
        confirmationStarted()
        return new Promise(() => {})
      },
    })
    await started
    controller.abort()
    await expect(pending).rejects.toThrow(/cancel/u)
    await expect(lstat(`${versions}-mydumper`)).rejects.toThrow()
    await expect(lstat(`${versions}-myloader`)).rejects.toThrow()
  })

  it.each([
    ['missing completion', { PORTEAU_FIXTURE_RESTORE_NO_COMPLETION: '1' }, /completion/u],
    ['fatal event', { PORTEAU_FIXTURE_RESTORE_FATAL: '1' }, /fatal/u],
    ['cancel event', { PORTEAU_FIXTURE_RESTORE_CANCELLED: '1' }, /reported cancellation/u],
    ['completion errors', { PORTEAU_FIXTURE_RESTORE_ERRORS: '1' }, /disagree/u],
    [
      'duplicate completion',
      { PORTEAU_FIXTURE_RESTORE_DUPLICATE_COMPLETION: '1' },
      /exactly one completion/u,
    ],
    [
      'nonzero process exit',
      { PORTEAU_FIXTURE_RESTORE_PROCESS_EXIT: '23' },
      /exited with code 23/u,
    ],
    [
      'exit/event disagreement',
      { PORTEAU_FIXTURE_RESTORE_EVENT_EXIT: '1' },
      /process and completion event disagree/u,
    ],
  ])('fails on %s and cleans credentials', async (_name, extra, expected) => {
    const { cwd, artifact } = await workspace()
    const invocation = join(cwd, 'invocation.json')
    await expect(
      runRestore({
        config: config(),
        request: request(artifact),
        configDirectory: cwd,
        environment: environment(cwd, { PORTEAU_FIXTURE_INVOCATION: invocation, ...extra }),
        connectionFactory: async () => connection(),
        confirm: () => true,
      }),
    ).rejects.toThrow(expected)
    const args = JSON.parse(await readFile(invocation, 'utf8')) as string[]
    const defaultsPath = args.find((value) => value.startsWith('--defaults-file='))!.slice(16)
    await expect(lstat(defaultsPath)).rejects.toThrow()
  })

  it('cancels the myloader process group and cleans credentials', async () => {
    const { cwd, artifact } = await workspace()
    const invocation = join(cwd, 'invocation.json')
    const controller = new AbortController()
    await expect(
      runRestore({
        config: config(),
        request: request(artifact),
        configDirectory: cwd,
        signal: controller.signal,
        environment: environment(cwd, {
          PORTEAU_FIXTURE_INVOCATION: invocation,
          PORTEAU_FIXTURE_RESTORE_HANG: '1',
        }),
        connectionFactory: async () => connection(),
        confirm: () => true,
        onEvent: () => controller.abort(),
      }),
    ).rejects.toThrow(/cancel/u)
    const args = JSON.parse(await readFile(invocation, 'utf8')) as string[]
    const defaultsPath = args.find((value) => value.startsWith('--defaults-file='))!.slice(16)
    await expect(lstat(defaultsPath)).rejects.toThrow()
  })

  it('maps explicit destructive and binlog policies to qualified native flags', async () => {
    const { cwd, artifact } = await workspace()
    const invocation = join(cwd, 'invocation.json')
    await runRestore({
      config: config(),
      request: request(artifact, {
        destinationPolicy: 'allow-existing',
        overwritePolicy: 'drop',
        binlogPolicy: 'enable',
      }),
      configDirectory: cwd,
      environment: environment(cwd, { PORTEAU_FIXTURE_INVOCATION: invocation }),
      connectionFactory: async () => connection(1),
      confirm: () => true,
    })
    const args = JSON.parse(await readFile(invocation, 'utf8')) as string[]
    expect(args).toEqual(expect.arrayContaining(['--drop-table=DROP', '--enable-binlog']))
  })
})
