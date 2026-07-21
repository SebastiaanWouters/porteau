import { describe, expect, it, vi } from 'vite-plus/test'
import { Presentation, type PresentationFlags } from '../src/presentation/context.js'
import { Redactor } from '../src/presentation/redaction.js'
import type { EngineEvent } from '../src/core/events.js'

const flags = (overrides: Partial<PresentationFlags> = {}): PresentationFlags => ({
  json: false,
  quiet: false,
  verbose: false,
  interactive: true,
  yes: false,
  ...overrides,
})
const io = (tty = true, output: string[] = []) => ({
  stdout: (line: string) => output.push(line),
  stderr: (line: string) => output.push(line),
  stdinTTY: tty,
  stdoutTTY: tty,
  stderrTTY: tty,
})

describe('presentation context', () => {
  it.each([
    [{}, true],
    [{ CI: '1' }, false],
    [{ TERM: 'dumb' }, false],
  ])('uses the interactive TTY policy for %j', (env, expected) => {
    expect(new Presentation(flags(), io(), env).interactive).toBe(expected)
  })

  it('requires all three TTYs and disables interaction in JSON mode', () => {
    expect(new Presentation(flags(), { ...io(), stdinTTY: false }, {}).interactive).toBe(false)
    expect(new Presentation(flags({ json: true }), io(), {}).interactive).toBe(false)
  })

  it('honors NO_COLOR by presence, including an empty value', () => {
    expect(new Presentation(flags(), io(), { NO_COLOR: '' }).color).toBe(false)
    expect(new Presentation(flags(), io(), {}).color).toBe(true)
  })

  it('emits parseable v1 JSONL with one terminal record and no stderr', async () => {
    const stdout: string[] = [],
      stderr: string[] = []
    const presentation = new Presentation(
      flags({ json: true }),
      {
        ...io(false),
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {},
    )
    await presentation.info('backup', 'ignored', { phase: 'startup' })
    await presentation.success('backup', 'done', { outputDirectory: '/safe' })
    const records = stdout.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.every((record) => record.schemaVersion === 1)).toBe(true)
    expect(
      records.filter((record) => record.type === 'result' || record.type === 'error'),
    ).toHaveLength(1)
    expect(stderr).toEqual([])
  })

  it('redacts registered and patterned secrets and complete VT sequences', () => {
    const secret = ['sentinel', 'secret'].join('-')
    const redactor = new Redactor(secret)
    expect(
      redactor.clean(`\u001b[31m${secret}\u001b[0m password=${['hunter', '2'].join('')}`),
    ).toBe('[redacted] password=[redacted]')
  })

  it('safely serializes hostile structured data and redacts sensitive keys', async () => {
    const output: string[] = []
    const redactor = new Redactor()
    const cyclic: Record<string, unknown> = {
      password: 'unknown-secret',
      apiToken: 'unknown-token',
      count: 4n,
    }
    cyclic.self = cyclic
    Object.defineProperty(cyclic, 'unsafe', {
      enumerable: true,
      get: () => {
        throw new Error('getter secret')
      },
    })
    const cleaned = redactor.cleanValue(cyclic)
    expect(JSON.stringify(cleaned)).toBe(
      '{"password":"[redacted]","apiToken":"[redacted]","count":"4","self":"[circular]","unsafe":"[unavailable]"}',
    )

    const presentation = new Presentation(flags({ json: true }), io(false, output), {})
    await presentation.info('backup', 'safe', {
      type: 'hostile',
      password: 'unknown-secret',
      cyclic,
    })
    await presentation.success('backup', 'done')
    const records = output.map((line) => JSON.parse(line))
    expect(records[0].event.type).toBe('info')
    expect(records[0].event.data.type).toBe('hostile')
    expect(records[0].event.data.password).toBe('[redacted]')
    expect(records).toHaveLength(2)
  })

  it('replaces overlapping registered secrets longest-first', () => {
    const redactor = new Redactor('secret')
    redactor.register('secret-suffix')
    expect(redactor.clean('secret-suffix secret')).toBe('[redacted] [redacted]')
  })

  it('constructs progress only in interactive mode and never invents a percentage', () => {
    const calls: string[] = []
    const factory = vi.fn(() => ({
      start: (message: string) => calls.push(`start:${message}`),
      update: (message: string) => calls.push(`update:${message}`),
      stop: (message: string) => calls.push(`stop:${message}`),
      cancel: (message: string) => calls.push(`cancel:${message}`),
    }))
    const event = {
      type: 'progress',
      phase: 'backup',
      completed: '2',
      runId: 'r',
      sequence: 1,
      timestamp: '',
      tool: 'mydumper',
      sourceEvent: 'x',
      sourcePhase: 'x',
      sourceStatus: 'progress',
    } as EngineEvent
    new Presentation(flags(), io(), {}, factory).progress('backup', event)
    expect(calls[0]).toBe('start:backup: progress')
    const noninteractive = new Presentation(flags(), io(false), {}, factory)
    noninteractive.progress('backup', event)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('keeps default output concise, quiet output silent, and verbose output detailed', async () => {
    const running = {
      type: 'status',
      status: 'running',
      message: 'worker detail',
      phase: 'backup',
      runId: 'r',
      sequence: 1,
      timestamp: '',
      tool: 'mydumper',
      sourceEvent: 'worker',
      sourcePhase: 'dump',
      sourceStatus: 'progress',
    } as EngineEvent
    const defaultOutput: string[] = []
    const quietOutput: string[] = []
    const verboseOutput: string[] = []
    const standard = new Presentation(flags(), io(false, defaultOutput), {})
    const quiet = new Presentation(flags({ quiet: true }), io(false, quietOutput), {})
    const verbose = new Presentation(flags({ verbose: true }), io(false, verboseOutput), {})
    standard.progress('backup', running)
    quiet.progress('backup', running)
    verbose.progress('backup', running)
    await Promise.all([standard.flush(), quiet.flush(), verbose.flush()])
    expect(defaultOutput).toEqual([])
    expect(quietOutput).toEqual([])
    expect(verboseOutput.join(' ')).toContain('worker detail')
  })

  it('does not start an interactive spinner from a terminal event', () => {
    const factory = vi.fn(() => ({
      start: vi.fn(),
      update: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
    }))
    const completion = {
      type: 'completion',
      phase: 'finalization',
      runId: 'r',
      sequence: 1,
      timestamp: '',
      tool: 'mydumper',
      sourceEvent: 'complete',
      sourcePhase: 'shutdown',
      sourceStatus: 'finished',
      exitCode: 0,
      errors: '0',
      warnings: '0',
      retries: '0',
      files: '1',
    } as EngineEvent
    new Presentation(flags(), io(), {}, factory).progress('backup', completion)
    expect(factory).not.toHaveBeenCalled()
  })

  it('redacts environment and subsequently registered secrets in every mode', async () => {
    const output: string[] = []
    const environmentSecret = ['environment', 'sentinel'].join('-')
    const promptSecret = ['prompt', 'sentinel'].join('-')
    const presentation = new Presentation(flags(), io(false, output), {
      PORTEAU_PASSWORD: environmentSecret,
    })
    presentation.registerSecret(promptSecret)
    await presentation.failure(
      'backup',
      new Error(`${environmentSecret} ${promptSecret}`).message,
      1,
    )
    expect(output.join(' ')).not.toMatch(/environment-sentinel|prompt-sentinel/u)
  })
})
