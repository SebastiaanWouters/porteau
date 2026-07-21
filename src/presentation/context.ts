import { createConsola, type ConsolaInstance } from 'consola'
import { defineDiagnostics } from 'nostics'
import type { EngineEvent } from '../core/events.js'
import { clackProgress, type InteractiveProgress, type ProgressFactory } from './progress.js'
import { Redactor } from './redaction.js'

export type OutputMode = 'human' | 'json'
export interface PresentationFlags {
  json: boolean
  quiet: boolean
  verbose: boolean
  interactive: boolean
  yes: boolean
}
export interface PresentationIO {
  stdout: (line: string) => unknown
  stderr: (line: string) => unknown
  stdinTTY: boolean
  stdoutTTY: boolean
  stderrTTY: boolean
}

export const diagnostics = defineDiagnostics({
  codes: { PORTEAU_FAILURE: { why: 'The requested operation failed' } },
})

export class OutputError extends Error {
  readonly name = 'OutputError'
  constructor(readonly cause: unknown) {
    super('Unable to write CLI output')
  }
}

export class Presentation {
  readonly mode: OutputMode
  readonly interactive: boolean
  readonly color: boolean
  #terminal = false
  #lastProgress = 0
  #progress?: InteractiveProgress
  #progressStarted = false
  #pending: Promise<void> = Promise.resolve()
  #outputError?: OutputError
  readonly #redactor: Redactor
  readonly #logger: ConsolaInstance

  constructor(
    readonly flags: PresentationFlags,
    readonly io: PresentationIO,
    env: NodeJS.ProcessEnv,
    readonly progressFactory: ProgressFactory = clackProgress,
    readonly signal?: AbortSignal,
    readonly onOutputFailure?: (error: OutputError) => void,
  ) {
    this.mode = flags.json ? 'json' : 'human'
    this.color = !('NO_COLOR' in env) && env.TERM !== 'dumb' && io.stdoutTTY
    this.interactive =
      this.mode === 'human' &&
      flags.interactive &&
      !env.CI &&
      env.TERM !== 'dumb' &&
      io.stdinTTY &&
      io.stdoutTTY
    this.#redactor = new Redactor(env.PORTEAU_PASSWORD)
    this.#logger = createConsola({
      level: flags.verbose ? 4 : 3,
      reporters: [
        {
          log: (record) => {
            const message = record.message || record.args.map(String).join(' ')
            void this.#write('stderr', this.#redactor.clean(message)).catch(() => {})
          },
        },
      ],
    })
  }

  registerSecret(secret?: string): void {
    this.#redactor.register(secret)
  }

  async flush(): Promise<void> {
    await this.#pending
    if (this.#outputError) throw this.#outputError
  }

  #write(destination: 'stdout' | 'stderr', line: string): Promise<void> {
    if (this.#outputError) return Promise.reject(this.#outputError)
    const attempt = this.#pending.then(async () => {
      if (this.#outputError) throw this.#outputError
      await this.io[destination](line)
    })
    this.#pending = attempt.catch((error: unknown) => {
      if (!this.#outputError) {
        this.#outputError = error instanceof OutputError ? error : new OutputError(error)
        this.onOutputFailure?.(this.#outputError)
      }
    })
    return attempt
  }

  #json(record: Record<string, unknown>): Promise<void> {
    let serialized: string
    try {
      serialized = JSON.stringify(this.#redactor.cleanValue(record))
    } catch (error) {
      return Promise.reject(new OutputError(error))
    }
    return this.#write('stdout', serialized)
  }

  async #writeLines(destination: 'stdout' | 'stderr', value: string): Promise<void> {
    for (const line of this.#redactor.cleanLines(value)) await this.#write(destination, line)
  }

  #settleProgress(kind: 'success' | 'failure', message: string): void {
    if (!this.#progressStarted) return
    try {
      if (kind === 'success') this.#progress?.stop(this.#redactor.clean(message))
      else this.#progress?.cancel(this.#redactor.clean(message))
    } catch {
      // Output is still finalized even if a third-party progress renderer fails.
    } finally {
      this.#progressStarted = false
    }
  }

  progress(command: string, event: EngineEvent): void {
    if (this.flags.quiet) return
    const now = Date.now()
    if (!this.interactive && event.type === 'progress' && now - this.#lastProgress < 250) return
    this.#lastProgress = now
    const fields: Record<string, unknown> = {}
    for (const key of [
      'runId',
      'sequence',
      'parentSequence',
      'timestamp',
      'phase',
      'tool',
      'type',
      'status',
      'message',
      'code',
      'completed',
      'total',
      'rows',
      'bytes',
      'retries',
      'warnings',
      'errors',
      'files',
      'durationMs',
      'exitCode',
      'fatal',
      'retryable',
    ] as const) {
      if (key in event && event[key as keyof EngineEvent] !== undefined)
        fields[key] = event[key as keyof EngineEvent]
    }
    if (this.mode === 'json') {
      void this.#json({ schemaVersion: 1, type: 'event', command, event: fields }).catch(() => {})
      return
    }
    if (this.interactive) {
      const detail =
        event.type === 'progress' && event.completed !== undefined && event.total !== undefined
          ? `${event.phase}: ${event.completed}/${event.total}`
          : `${event.phase}: ${'message' in event && event.message ? this.#redactor.clean(event.message) : event.type}`
      if ((event.type === 'cancelled' || event.type === 'error') && this.#progressStarted) {
        this.#settleProgress('failure', detail)
      } else if (event.type === 'completion' && this.#progressStarted) {
        this.#settleProgress('success', detail)
      } else if (!['cancelled', 'error', 'completion'].includes(event.type)) {
        try {
          if (!this.#progressStarted) {
            this.#progress ??= this.progressFactory(this.signal)
            this.#progressStarted = true
            this.#progress.start(detail)
          } else this.#progress?.update(detail)
        } catch (error) {
          this.#settleProgress('failure', 'Progress output failed')
          this.onOutputFailure?.(new OutputError(error))
        }
      }
      return
    }
    if (
      this.flags.verbose ||
      event.type === 'warning' ||
      event.type === 'error' ||
      event.type === 'cancelled' ||
      event.type === 'completion' ||
      (event.type === 'status' && event.status !== 'running')
    )
      this.#logger.info(
        `${event.phase}: ${'message' in event && event.message ? event.message : event.type}`,
      )
  }

  async info(command: string, message: string, data: Record<string, unknown> = {}): Promise<void> {
    if (this.mode === 'json')
      await this.#json({
        schemaVersion: 1,
        type: 'event',
        command,
        event: { type: 'info', message, data },
      })
    else if (!this.flags.quiet) {
      this.#logger.info(message)
      await this.flush()
    }
  }

  async disclose(command: string, message: string, data: Record<string, unknown>): Promise<void> {
    if (this.mode === 'json')
      await this.#json({
        schemaVersion: 1,
        type: 'event',
        command,
        event: { type: 'plan', message, data },
      })
    else await this.#writeLines(this.interactive ? 'stdout' : 'stderr', message)
  }

  async reportDiagnostics(command: string, message: string, data: unknown): Promise<void> {
    if (this.mode === 'json')
      await this.#json({
        schemaVersion: 1,
        type: 'event',
        command,
        event: { type: 'diagnostics', data },
      })
    else await this.#writeLines('stderr', message)
  }

  async success(
    command: string,
    message: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.#terminal) throw new Error('Terminal output rendered more than once')
    await this.flush()
    this.#settleProgress('success', message)
    if (this.mode === 'json')
      await this.#json({ schemaVersion: 1, type: 'result', command, ok: true, result: data })
    else await this.#writeLines('stdout', message)
    this.#terminal = true
  }

  async failure(command: string, message: string, exitCode: number): Promise<void> {
    if (this.#terminal) return
    this.#settleProgress('failure', 'Failed')
    if (this.#outputError) return
    const safe = this.#redactor.clean(message)
    const operationCode = diagnostics.PORTEAU_FAILURE().name
    try {
      if (this.mode === 'json')
        await this.#json({
          schemaVersion: 1,
          type: 'error',
          command,
          ok: false,
          error: {
            code: exitCode === 2 ? 'INVALID_USAGE' : exitCode === 130 ? 'CANCELLED' : operationCode,
            message: safe,
          },
        })
      else await this.#write('stderr', `error: ${safe}`)
      this.#terminal = true
    } catch {
      // The selected sink is broken; do not reject executeCli or retry indefinitely.
    }
  }
}
