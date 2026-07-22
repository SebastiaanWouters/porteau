import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { executeCli, type CliServices } from '../src/cli.js'
import { defaultConfig, loadConfig, type PorteauConfig } from '../src/core/config.js'
import type { EngineEvent } from '../src/core/events.js'
import type { DiagnosticsResult } from '../src/setup/diagnostics.js'
import type { PromptAdapter } from '../src/presentation/prompts.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function config(
  options: {
    user?: string
    password?: string
    databases?: string[]
  } = {},
): PorteauConfig {
  return {
    ...structuredClone(defaultConfig),
    connection: {
      ...structuredClone(defaultConfig.connection),
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.password === undefined ? {} : { password: options.password }),
    },
    include: { databases: options.databases ?? [] },
  }
}

function diagnostics(overrides: Partial<DiagnosticsResult> = {}): DiagnosticsResult {
  const result: DiagnosticsResult = {
    system: {
      status: 'ok',
      platform: 'linux',
      id: 'ubuntu',
      name: 'Ubuntu 24.04',
      version: '24.04',
      codename: 'noble',
      architecture: 'amd64',
      supported: true,
    },
    node: { status: 'ok', version: '24.1.0', minimumVersion: '22.18.0' },
    tools: {
      mydumper: { name: 'mydumper', status: 'ok', version: '1.0.3-1' },
      myloader: { name: 'myloader', status: 'ok', version: '1.0.3-1' },
    },
    toolPair: { status: 'ok' },
    ok: true,
  }
  return { ...result, ...overrides }
}

const noPrompts: PromptAdapter = {
  text: vi.fn(async () => undefined),
  password: vi.fn(async () => undefined),
  confirm: vi.fn(async () => undefined),
}

describe('global CLI contract', () => {
  it('accepts global options before and after commands and renders JSON conflicts as JSON', async () => {
    for (const args of [
      ['--json', 'config'],
      ['config', '--json'],
    ]) {
      const stdout: string[] = []
      expect(
        await executeCli({
          args,
          stdout: (line) => stdout.push(line),
          stderr: vi.fn(),
          services: { loadConfig: async () => config() },
        }),
      ).toBe(0)
      expect(JSON.parse(stdout.at(-1)!).type).toBe('result')
    }

    const stdout: string[] = []
    const stderr: string[] = []
    expect(
      await executeCli({
        args: ['--json', '--quiet', 'config'],
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      }),
    ).toBe(2)
    expect(JSON.parse(stdout[0]!).error.code).toBe('INVALID_USAGE')
    expect(stderr).toEqual([])
  })

  it('supports advertised aliases and rejects unknown options before loading config', async () => {
    let loadOptions: unknown
    const load = vi.fn(async (options: unknown) => {
      loadOptions = options
      return config()
    })
    expect(
      await executeCli({
        args: ['config', '-c', 'custom.yaml'],
        stdout: vi.fn(),
        services: { loadConfig: load },
      }),
    ).toBe(0)
    expect(loadOptions).toMatchObject({
      configFile: expect.stringContaining('custom.yaml'),
    })

    load.mockClear()
    expect(
      await executeCli({
        args: ['config', '--unknown'],
        stdout: vi.fn(),
        stderr: vi.fn(),
        services: { loadConfig: load },
      }),
    ).toBe(2)
    expect(load).not.toHaveBeenCalled()
  })

  it('parses attached values, option-looking values, and the option terminator consistently', async () => {
    const load = vi.fn(async (_options: unknown) => config())
    for (const args of [
      ['config', '--config=custom.yaml'],
      ['config', '--config', '--json'],
      ['--json', 'config', '--config=custom.yaml'],
    ]) {
      expect(
        await executeCli({
          args,
          stdout: vi.fn(),
          stderr: vi.fn(),
          services: { loadConfig: load },
        }),
      ).toBe(0)
    }
    expect(load.mock.calls[0]?.[0]).toMatchObject({
      configFile: expect.stringContaining('custom.yaml'),
    })
    expect(load.mock.calls[1]?.[0]).toMatchObject({ configFile: expect.stringContaining('--json') })

    load.mockClear()
    for (const args of [
      ['--help', 'backup', 'unexpected'],
      ['--version', 'backup'],
    ]) {
      expect(await executeCli({ args, stdout: vi.fn(), stderr: vi.fn() })).toBe(2)
    }
    for (const args of [
      ['config', '--config', '--json', '--unknown'],
      ['config', '--', '--json'],
    ]) {
      const stdout: string[] = []
      const stderr: string[] = []
      expect(
        await executeCli({
          args,
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        }),
      ).toBe(2)
      expect(stdout).toEqual([])
      expect(stderr[0]).toMatch(/^error:/u)
    }
    expect(load).not.toHaveBeenCalled()
  })

  it('documents global options in root and subcommand help', async () => {
    for (const args of [['--help'], ['backup', '--help']]) {
      const output: string[] = []
      expect(await executeCli({ args, stdout: (line) => output.push(line) })).toBe(0)
      expect(output.join('\n')).toContain('--no-interactive')
      expect(output.join('\n')).toContain('--json')
    }
  })
})

describe('guided backup', () => {
  it('aborts a pending prompt when the process is interrupted', async () => {
    const text = vi.fn(
      async (_message: string, signal?: AbortSignal) =>
        new Promise<undefined>((resolvePrompt) => {
          signal?.addEventListener('abort', () => resolvePrompt(undefined), { once: true })
        }),
    )
    const invocation = executeCli({
      args: ['backup'],
      stdout: vi.fn(),
      stderr: vi.fn(),
      env: {},
      stdinTTY: true,
      stdoutTTY: true,
      prompts: { ...noPrompts, text },
      services: { loadConfig: async () => config() },
    })
    await vi.waitFor(() => expect(text).toHaveBeenCalledOnce())
    process.emit('SIGINT')
    expect(await invocation).toBe(130)
  })

  it('fails missing automation inputs without prompting or calling backup', async () => {
    const runBackup = vi.fn()
    const text = vi.fn()
    expect(
      await executeCli({
        args: ['backup', '--no-interactive'],
        stdout: vi.fn(),
        stderr: vi.fn(),
        prompts: { ...noPrompts, text },
        services: { loadConfig: async () => config(), runBackup },
      }),
    ).toBe(1)
    expect(text).not.toHaveBeenCalled()
    expect(runBackup).not.toHaveBeenCalled()
  })

  it('prompts only for missing values, revalidates them, and normalizes database lists', async () => {
    const loads: unknown[] = []
    const runBackup = vi.fn(async () => ({ outputDirectory: '/backup', warnings: 0 }))
    const prompts: PromptAdapter = {
      text: vi.fn().mockResolvedValueOnce(' backup_user ').mockResolvedValueOnce(' app, audit '),
      password: vi.fn(async () => 'prompt-secret'),
      confirm: vi.fn(),
    }
    expect(
      await executeCli({
        args: ['backup'],
        stdout: vi.fn(),
        stderr: vi.fn(),
        env: {},
        stdinTTY: true,
        stdoutTTY: true,
        prompts,
        services: {
          loadConfig: async (options) => {
            loads.push(options)
            return loads.length === 1
              ? config()
              : config({
                  user: 'backup_user',
                  password: 'prompt-secret',
                  databases: ['app', 'audit'],
                })
          },
          runBackup,
        },
      }),
    ).toBe(0)
    expect(loads.at(-1)).toMatchObject({
      flags: {
        connection: { user: 'backup_user', password: 'prompt-secret' },
        include: { databases: ['app', 'audit'] },
      },
    })
    expect(runBackup).toHaveBeenCalledOnce()
  })

  it('cancels before backup when a prompt is cancelled and rejects password argv', async () => {
    const runBackup = vi.fn()
    expect(
      await executeCli({
        args: ['backup'],
        stdout: vi.fn(),
        stderr: vi.fn(),
        env: {},
        stdinTTY: true,
        stdoutTTY: true,
        prompts: noPrompts,
        services: { loadConfig: async () => config(), runBackup },
      }),
    ).toBe(130)
    expect(runBackup).not.toHaveBeenCalled()

    expect(
      await executeCli({
        args: ['backup', '--password', 'forbidden'],
        stdout: vi.fn(),
        stderr: vi.fn(),
        services: { loadConfig: vi.fn() },
      }),
    ).toBe(2)
  })

  it('redacts configured secrets from JSON events and failures and settles progress', async () => {
    const secret = 'yaml-secret-sentinel'
    const stdout: string[] = []
    const progressCalls: string[] = []
    const event = {
      type: 'status',
      status: 'started',
      message: `native echoed ${secret}`,
      phase: 'backup',
      runId: 'run',
      sequence: 1,
      timestamp: '2026-01-01T00:00:00Z',
      tool: 'mydumper',
      sourceEvent: 'private',
      sourcePhase: 'private',
      sourceStatus: 'started',
    } as EngineEvent
    expect(
      await executeCli({
        args: ['backup', '--json'],
        stdout: (line) => stdout.push(line),
        stderr: vi.fn(),
        services: {
          loadConfig: async () => config({ user: 'backup', password: secret, databases: ['app'] }),
          async runBackup(options) {
            options.onEvent?.(event)
            throw new Error(`failed with ${secret}`)
          },
        },
      }),
    ).toBe(1)
    expect(stdout.join('\n')).not.toContain(secret)
    const records = stdout.map((line) => JSON.parse(line))
    expect(records[0]).toMatchObject({ type: 'event', event: { type: 'status' } })
    expect(records[0].event).not.toHaveProperty('sourceEvent')
    expect(records.filter((record) => ['result', 'error'].includes(record.type))).toHaveLength(1)

    await executeCli({
      args: ['backup'],
      stdout: vi.fn(),
      stderr: vi.fn(),
      env: {},
      stdinTTY: true,
      stdoutTTY: true,
      progress: () => ({
        start: (message) => progressCalls.push(`start:${message}`),
        update: vi.fn(),
        stop: (message) => progressCalls.push(`stop:${message}`),
        cancel: (message) => progressCalls.push(`cancel:${message}`),
      }),
      services: {
        loadConfig: async () => config({ user: 'backup', password: secret, databases: ['app'] }),
        async runBackup(options) {
          options.onEvent?.(event)
          throw new Error('failed')
        },
      },
    })
    expect(progressCalls).toEqual([
      expect.stringContaining('start:'),
      expect.stringContaining('cancel:'),
    ])
  })
})

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

  it('maps explicit policies, discloses the plan, and emits a JSON result for approved automation', async () => {
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
            destinationPolicy: options.request.destinationPolicy,
            overwritePolicy: options.request.overwritePolicy,
            binlogPolicy: options.request.binlogPolicy,
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
          '--source-database',
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
    expect(received!.request).toEqual({
      artifactPath: join(cwd, 'artifact'),
      sourceDatabase: 'app',
      destinationDatabase: 'restored',
      destinationPolicy: 'allow-existing',
      overwritePolicy: 'drop',
      binlogPolicy: 'enable',
    })
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

  it('applies restore flags over YAML policy values while preserving other YAML policies', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'porteau-restore-precedence-'))
    roots.push(cwd)
    const configFile = join(cwd, 'porteau.yaml')
    await writeFile(
      configFile,
      [
        'connection:',
        '  user: restore',
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
          '--source-database',
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
    expect(received!.request).toMatchObject({
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
          '--source-database',
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
          '--source-database',
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

describe('init, config, and doctor flows', () => {
  it('creates a protected valid config without a password and refuses overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'porteau-init-'))
    roots.push(root)
    const path = join(root, 'porteau.yaml')
    const args = [
      'init',
      '-o',
      path,
      '--host',
      ' db ',
      '--user',
      ' backup ',
      '--database',
      'app, audit',
    ]
    const ambientLoad = vi.fn(async () => {
      throw new Error('ambient config must not be loaded')
    })
    expect(
      await executeCli({
        args,
        cwd: root,
        stdout: vi.fn(),
        stderr: vi.fn(),
        services: { loadConfig: ambientLoad },
      }),
    ).toBe(0)
    expect(ambientLoad).not.toHaveBeenCalled()
    const contents = await readFile(path, 'utf8')
    expect(contents).not.toMatch(/password:/u)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await loadConfig({ configFile: path, env: {} })).toMatchObject({
      connection: { host: 'db', user: 'backup' },
      include: { databases: ['app', 'audit'] },
    })

    await writeFile(path, 'original')
    expect(await executeCli({ args, cwd: root, stdout: vi.fn(), stderr: vi.fn() })).toBe(1)
    expect(await readFile(path, 'utf8')).toBe('original')
    expect(await readdir(root)).toEqual(['porteau.yaml'])
  })

  it('does not create init output after prompt cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'porteau-init-cancel-'))
    roots.push(root)
    const path = join(root, 'cancelled.yaml')
    expect(
      await executeCli({
        args: ['init', '--output', path],
        cwd: root,
        stdout: vi.fn(),
        stderr: vi.fn(),
        env: {},
        stdinTTY: true,
        stdoutTTY: true,
        prompts: noPrompts,
      }),
    ).toBe(130)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).toEqual([])
  })

  it('omits config passwords in human and JSON output', async () => {
    const secret = 'config-secret-sentinel'
    for (const args of [['config'], ['config', '--json']]) {
      const output: string[] = []
      expect(
        await executeCli({
          args,
          stdout: (line) => output.push(line),
          stderr: (line) => output.push(line),
          services: {
            loadConfig: async () => config({ user: 'backup', password: secret }),
          },
        }),
      ).toBe(0)
      expect(output.join('\n')).not.toContain(secret)
      expect(output.join('\n')).toContain('passwordConfigured')
    }
  })

  it('renders one doctor failure and forwards cwd and environment', async () => {
    const output: string[] = []
    const cwd = '/injected/workspace'
    const env = { PATH: '/injected/bin' }
    let diagnosticOptions: unknown
    const collect = vi.fn(async (options: unknown) => {
      diagnosticOptions = options
      return diagnostics({ ok: false, toolPair: { status: 'error' } })
    })
    expect(
      await executeCli({
        args: ['doctor', '--json'],
        cwd,
        env,
        stdout: (line) => output.push(line),
        stderr: vi.fn(),
        services: { collectDiagnostics: collect },
      }),
    ).toBe(1)
    expect(diagnosticOptions).toMatchObject({ cwd, env })
    expect(
      output.map((line) => JSON.parse(line)).filter((record) => record.type === 'error'),
    ).toHaveLength(1)
    expect(output.map((line) => JSON.parse(line))[0]).toMatchObject({
      type: 'event',
      event: { type: 'diagnostics', data: { ok: false } },
    })
  })
})
