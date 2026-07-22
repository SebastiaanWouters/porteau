import { mkdtemp, writeFile } from 'node:fs/promises'
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
