import { describe, expect, it, vi } from 'vite-plus/test'
import { executeCli } from '../src/cli.js'
import type { EngineEvent } from '../src/core/events.js'
import type { PromptAdapter } from '../src/presentation/prompts.js'
import { config, noPrompts } from './cli-fixtures.js'

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
            return config()
          },
          runBackup,
        },
      }),
    ).toBe(0)
    expect(loads).toHaveLength(1)
    expect(loads[0]).toMatchObject({ flags: {} })
    expect(runBackup).toHaveBeenCalledOnce()
    expect(runBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          connection: expect.objectContaining({
            user: 'backup_user',
            password: 'prompt-secret',
          }),
          include: { databases: ['app', 'audit'] },
        }),
      }),
    )
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

  it('discloses a no-lock consistency warning before running backup', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const runBackup = vi.fn(async () => ({ outputDirectory: '/backup', warnings: 0 }))
    expect(
      await executeCli({
        args: ['backup', '--json', '--no-interactive'],
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        services: {
          loadConfig: async () => ({
            ...config({ user: 'backup', password: 'secret', databases: ['app'] }),
            backup: {
              ...config().backup,
              consistency: {
                ...config().backup.consistency,
                mode: 'no-lock',
                protectDdl: false,
              },
            },
          }),
          runBackup,
        },
      }),
    ).toBe(0)
    expect(runBackup).toHaveBeenCalledOnce()
    const records = stdout.map((line) => JSON.parse(line))
    expect(records[0]).toMatchObject({
      type: 'event',
      event: {
        type: 'plan',
        message:
          'Warning: no-lock does not guarantee a consistent snapshot across concurrent writes.',
        data: { consistencyMode: 'no-lock' },
      },
    })
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
