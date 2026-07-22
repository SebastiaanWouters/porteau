import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vite-plus/test'
import { executeCli, type CliServices } from '../src/cli.js'
import { defaultConfig, type PorteauConfig } from '../src/core/config.js'
import { config, noPrompts, roots } from './cli-fixtures.js'

describe('guarded restore CLI', () => {
  const restoreConfig = (overrides: Partial<PorteauConfig['restore']> = {}) => ({
    ...config({ user: 'restore', password: 'restore-secret' }),
    restore: { ...structuredClone(defaultConfig.restore), ...overrides },
  })
  const summary = {
    host: 'localhost',
    port: 3306,
    sourceDatabase: 'app',
    destinationDatabase: 'restored',
    destinationExists: false,
    destinationObjects: 0,
    destinationPolicy: 'require-empty' as const,
    overwritePolicy: 'reject' as const,
    binlogPolicy: 'disable' as const,
  }

  it('defaults server and database when selection flags are omitted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-restore-defaults-'))
    roots.push(cwd)
    let received: Parameters<CliServices['runRestore']>[0]
    expect(
      await executeCli({
        args: [
          'restore',
          '--yes',
          '--artifact',
          './artifact',
          '--destination-database',
          'restored',
        ],
        cwd,
        stdout: vi.fn(),
        stderr: vi.fn(),
        services: {
          loadConfig: async () => restoreConfig(),
          runRestore: async (options) => {
            received = options
            return { destinationDatabase: 'restored', warnings: 0 }
          },
        },
      }),
    ).toBe(0)
    expect(received!.run.server.id).toBe('local')
    expect(received!.run.databases[0]).toMatchObject({ id: 'app', name: 'app' })
  })

  it('selects --server staging and uses that server credentials', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-restore-server-'))
    roots.push(cwd)
    const multi = {
      ...restoreConfig(),
      servers: {
        local: {
          host: '127.0.0.1',
          port: 3306,
          user: 'local-user',
          password: 'local-secret',
          tls: 'preferred' as const,
        },
        staging: {
          host: 'staging.example',
          port: 3307,
          user: 'staging-user',
          password: 'staging-secret',
          tls: 'preferred' as const,
        },
      },
    }
    let received: Parameters<CliServices['runRestore']>[0]
    expect(
      await executeCli({
        args: [
          'restore',
          '--yes',
          '--server',
          'staging',
          '--database',
          'app',
          '--artifact',
          './artifact',
          '--destination-database',
          'restored',
        ],
        cwd,
        stdout: vi.fn(),
        stderr: vi.fn(),
        services: {
          loadConfig: async () => multi,
          runRestore: async (options) => {
            received = options
            return { destinationDatabase: 'restored', warnings: 0 }
          },
        },
      }),
    ).toBe(0)
    expect(received!.run.server).toMatchObject({
      id: 'staging',
      host: 'staging.example',
      port: 3307,
      user: 'staging-user',
    })
    expect(received!.credentials).toEqual({ user: 'staging-user', password: 'staging-secret' })
  })

  it('surfaces unknown --server and --database errors', async () => {
    const runRestore = vi.fn()
    const unknownServer: string[] = []
    expect(
      await executeCli({
        args: [
          'restore',
          '--json',
          '--yes',
          '--server',
          'missing',
          '--destination-database',
          'restored',
          '--artifact',
          'artifact',
        ],
        stdout: (line) => unknownServer.push(line),
        stderr: vi.fn(),
        services: { loadConfig: async () => restoreConfig(), runRestore },
      }),
    ).toBe(1)
    expect(JSON.parse(unknownServer.at(-1)!)).toMatchObject({
      type: 'error',
      error: { message: expect.stringMatching(/Unknown server "missing"/) },
    })
    expect(runRestore).not.toHaveBeenCalled()

    const unknownDatabase: string[] = []
    expect(
      await executeCli({
        args: [
          'restore',
          '--json',
          '--yes',
          '--database',
          'missing',
          '--destination-database',
          'restored',
          '--artifact',
          'artifact',
        ],
        stdout: (line) => unknownDatabase.push(line),
        stderr: vi.fn(),
        services: { loadConfig: async () => restoreConfig(), runRestore },
      }),
    ).toBe(1)
    expect(JSON.parse(unknownDatabase.at(-1)!)).toMatchObject({
      type: 'error',
      error: { message: expect.stringMatching(/Unknown database "missing"/) },
    })
    expect(runRestore).not.toHaveBeenCalled()
  })

  it('does not prompt for server or database when catalogs are single-entry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-restore-noprompt-'))
    roots.push(cwd)
    const text = vi.fn().mockResolvedValueOnce('restored')
    const runRestore = vi.fn(async () => ({ destinationDatabase: 'restored', warnings: 0 }))
    expect(
      await executeCli({
        args: ['restore', '--yes', '--artifact', './artifact'],
        cwd,
        env: {},
        stdinTTY: true,
        stdoutTTY: true,
        stdout: vi.fn(),
        stderr: vi.fn(),
        prompts: { ...noPrompts, text },
        services: {
          loadConfig: async () => restoreConfig(),
          runRestore,
        },
      }),
    ).toBe(0)
    expect(text).toHaveBeenCalledOnce()
    expect(text).toHaveBeenCalledWith('Destination database', expect.any(AbortSignal))
    expect(runRestore).toHaveBeenCalledOnce()
  })

  it('maps catalog key, policies, discloses the plan, and emits a JSON result for approved automation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-restore-cli-'))
    roots.push(cwd)
    const output: string[] = []
    let received: Parameters<CliServices['runRestore']>[0]
    const runRestore = vi.fn(async (options) => {
      received = options
      expect(
        await options.confirm(
          {
            ...summary,
            sourceDatabase: options.run.databases[0].name,
            destinationPolicy: options.run.restore.destinationPolicy,
            overwritePolicy: options.run.restore.overwritePolicy,
            binlogPolicy: options.run.restore.binlogPolicy,
          },
          options.signal,
        ),
      ).toBe(true)
      return { destinationDatabase: 'restored', warnings: 0 }
    })
    expect(
      await executeCli({
        args: [
          'restore',
          '--json',
          '--yes',
          '--artifact',
          './artifact',
          '--user',
          'restore',
          '--database',
          'app',
          '--destination-database',
          'restored',
          '--destination-policy',
          'allow-existing',
          '--overwrite-policy',
          'drop',
          '--binlog-policy',
          'enable',
        ],
        cwd,
        env: { PORTEAU_PASSWORD: 'restore-secret' },
        stdout: (line) => output.push(line),
        stderr: vi.fn(),
        services: { runRestore },
      }),
    ).toBe(0)
    expect(received!.artifactPath).toBe(join(cwd, 'artifact'))
    expect(received!.destinationDatabase).toBe('restored')
    expect(received!.run.databases[0]).toMatchObject({ id: 'app', name: 'app' })
    expect(received!.run.restore).toMatchObject({
      destinationPolicy: 'allow-existing',
      overwritePolicy: 'drop',
      binlogPolicy: 'enable',
    })
    expect(received!.credentials).toEqual({ user: 'restore', password: 'restore-secret' })
    const records = output.map((line) => JSON.parse(line))
    expect(records).toEqual([
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({ type: 'plan' }),
      }),
      expect.objectContaining({
        type: 'result',
        command: 'restore',
        result: { destinationDatabase: 'restored', warnings: 0 },
      }),
    ])
    expect(output.join('\n')).not.toContain('restore-secret')
  })

  it('resolves relative --artifact against the config directory, not process cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'porteau-restore-configdir-'))
    roots.push(root)
    const configDir = join(root, 'etc')
    await mkdir(configDir)
    const configFile = join(configDir, 'porteau.yaml')
    await writeFile(
      configFile,
      [
        'servers:',
        '  local:',
        '    user: restore',
        'databases:',
        '  app:',
        '    name: app',
        'artifacts:',
        '  directory: ./backups',
        '',
      ].join('\n'),
    )
    let received: Parameters<CliServices['runRestore']>[0]
    expect(
      await executeCli({
        args: [
          'restore',
          '--json',
          '--yes',
          '--config',
          configFile,
          '--artifact',
          './backups/app-2026-07-21',
          '--destination-database',
          'restored',
        ],
        cwd: root,
        env: { PORTEAU_PASSWORD: 'restore-secret' },
        stdout: vi.fn(),
        stderr: vi.fn(),
        services: {
          runRestore: async (options) => {
            received = options
            return { destinationDatabase: 'restored', warnings: 0 }
          },
        },
      }),
    ).toBe(0)
    expect(received!.artifactPath).toBe(join(configDir, 'backups', 'app-2026-07-21'))
    expect(received!.run.artifacts.directory).toBe(join(configDir, 'backups'))
  })

  it('auto-picks a single artifact under artifacts.directory when --artifact is omitted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-restore-autopick-'))
    roots.push(cwd)
    const configFile = join(cwd, 'porteau.yaml')
    await writeFile(
      configFile,
      [
        'servers:',
        '  local:',
        '    user: restore',
        'databases:',
        '  app:',
        '    name: app',
        'artifacts:',
        '  directory: ./backups',
        '',
      ].join('\n'),
    )
    await mkdir(join(cwd, 'backups', 'app-2026-07-21'), { recursive: true })
    let received: Parameters<CliServices['runRestore']>[0]
    expect(
      await executeCli({
        args: [
          'restore',
          '--json',
          '--yes',
          '--config',
          configFile,
          '--destination-database',
          'restored',
        ],
        cwd,
        env: { PORTEAU_PASSWORD: 'restore-secret' },
        stdout: vi.fn(),
        stderr: vi.fn(),
        services: {
          runRestore: async (options) => {
            received = options
            return { destinationDatabase: 'restored', warnings: 0 }
          },
        },
      }),
    ).toBe(0)
    expect(received!.artifactPath).toBe(join(cwd, 'backups', 'app-2026-07-21'))
  })

  it('refuses ambiguous artifact auto-pick and requires --artifact', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-restore-ambiguous-'))
    roots.push(cwd)
    const configFile = join(cwd, 'porteau.yaml')
    await writeFile(
      configFile,
      [
        'servers:',
        '  local:',
        '    user: restore',
        'databases:',
        '  app:',
        '    name: app',
        'artifacts:',
        '  directory: ./backups',
        '',
      ].join('\n'),
    )
    await mkdir(join(cwd, 'backups', 'app-2026-07-20'), { recursive: true })
    await mkdir(join(cwd, 'backups', 'app-2026-07-21'), { recursive: true })
    const runRestore = vi.fn()
    const output: string[] = []
    expect(
      await executeCli({
        args: [
          'restore',
          '--json',
          '--yes',
          '--config',
          configFile,
          '--destination-database',
          'restored',
        ],
        cwd,
        env: { PORTEAU_PASSWORD: 'restore-secret' },
        stdout: (line) => output.push(line),
        stderr: vi.fn(),
        services: { runRestore },
      }),
    ).toBe(1)
    expect(runRestore).not.toHaveBeenCalled()
    expect(output.join('\n')).toMatch(/Ambiguous restore artifact/)
  })

  it('applies restore flags over YAML policy values while preserving other YAML policies', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-restore-precedence-'))
    roots.push(cwd)
    const configFile = join(cwd, 'porteau.yaml')
    await writeFile(
      configFile,
      [
        'servers:',
        '  local:',
        '    user: restore',
        'restore:',
        '  destinationPolicy: allow-existing',
        '  overwritePolicy: truncate',
        '  binlogPolicy: enable',
        '',
      ].join('\n'),
    )
    let received: Parameters<CliServices['runRestore']>[0]
    expect(
      await executeCli({
        args: [
          'restore',
          '--json',
          '--yes',
          '--config',
          configFile,
          '--artifact',
          'artifact',
          '--database',
          'app',
          '--destination-database',
          'restored',
          '--overwrite-policy',
          'drop',
        ],
        cwd,
        env: { PORTEAU_PASSWORD: 'restore-secret' },
        stdout: vi.fn(),
        stderr: vi.fn(),
        services: {
          runRestore: async (options) => {
            received = options
            return { destinationDatabase: 'restored', warnings: 0 }
          },
        },
      }),
    ).toBe(0)
    expect(received!.run.restore).toMatchObject({
      destinationPolicy: 'allow-existing',
      overwritePolicy: 'drop',
      binlogPolicy: 'enable',
    })
  })

  it('requires --yes for automation after disclosure', async () => {
    const output: string[] = []
    const runRestore = vi.fn(async (options) => {
      await options.confirm(summary, options.signal)
      throw new Error('unreachable')
    })
    expect(
      await executeCli({
        args: [
          'restore',
          '--json',
          '--artifact',
          'artifact',
          '--database',
          'app',
          '--destination-database',
          'restored',
        ],
        stdout: (line) => output.push(line),
        stderr: vi.fn(),
        services: { loadConfig: async () => restoreConfig(), runRestore },
      }),
    ).toBe(1)
    expect(output.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({ type: 'plan' }),
      }),
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({
          message: 'Restore requires --yes in non-interactive mode',
        }),
      }),
    ])
  })

  it('treats an interactive confirmation decline as cancellation', async () => {
    const output: string[] = []
    const confirm = vi.fn(async () => false)
    const runRestore = vi.fn(async (options) => {
      await options.confirm(summary, options.signal)
      throw new Error('unreachable')
    })
    expect(
      await executeCli({
        args: [
          'restore',
          '--artifact',
          'artifact',
          '--database',
          'app',
          '--destination-database',
          'restored',
        ],
        env: {},
        stdinTTY: true,
        stdoutTTY: true,
        stdout: (line) => output.push(line),
        stderr: vi.fn(),
        prompts: { ...noPrompts, confirm },
        services: { loadConfig: async () => restoreConfig(), runRestore },
      }),
    ).toBe(130)
    expect(output.join('\n')).toContain('Destination policy: require-empty')
    expect(confirm).toHaveBeenCalledWith('Apply this restore plan?', expect.any(AbortSignal))
  })

  it('fails incomplete automation input before invoking restore and rejects password argv', async () => {
    const runRestore = vi.fn()
    expect(
      await executeCli({
        args: ['restore', '--no-interactive'],
        stdout: vi.fn(),
        stderr: vi.fn(),
        services: { loadConfig: async () => restoreConfig(), runRestore },
      }),
    ).toBe(1)
    expect(runRestore).not.toHaveBeenCalled()
    expect(
      await executeCli({
        args: ['restore', '--password', 'forbidden'],
        stdout: vi.fn(),
        stderr: vi.fn(),
      }),
    ).toBe(2)
  })
})
