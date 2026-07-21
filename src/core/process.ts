import { spawn } from 'node:child_process'

export interface ProcessOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stdoutTruncated: boolean
  readonly timedOut: boolean
  readonly aborted: boolean
}

export interface NativeProcessOptions {
  readonly executable: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly killGraceMs?: number
  readonly stdoutLimit?: number
  readonly onStderr: (chunk: Buffer) => void
  readonly onStderrEnd?: () => void
}

function appendBounded(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (current.length >= limit) return current
  return Buffer.concat([current, chunk.subarray(0, limit - current.length)])
}

/** Run a native tool without ever putting its arguments in an error message. */
export function runNativeProcess(options: NativeProcessOptions): Promise<ProcessOutcome> {
  if (options.signal?.aborted)
    return Promise.reject(new Error('Native process cancelled before start'))
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const limit = options.stdoutLimit ?? 64 * 1024
    const grace = options.killGraceMs ?? 1_000
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stdoutBytes = 0
    let timedOut = false
    let aborted = false
    let terminating = false
    let processError: unknown
    let killTimer: NodeJS.Timeout | undefined
    let timeout: NodeJS.Timeout | undefined

    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ESRCH') processError = new Error('Failed to terminate native process')
      }
    }
    const terminate = () => {
      if (terminating) return
      terminating = true
      signalGroup('SIGTERM')
      killTimer = setTimeout(() => signalGroup('SIGKILL'), grace)
      killTimer.unref()
    }
    const onAbort = () => {
      aborted = true
      terminate()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      stdout = appendBounded(stdout, chunk, limit)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      try {
        options.onStderr(chunk)
      } catch (error) {
        processError = error
        terminate()
      }
    })
    child.once('error', () => {
      if (timeout) clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(new Error('Unable to start native process'))
    })
    child.once('close', (exitCode, signal) => {
      if (timeout) clearTimeout(timeout)
      if (processError === undefined) {
        try {
          options.onStderrEnd?.()
        } catch (error) {
          processError = error
          terminating = true
        }
      }
      if (terminating) signalGroup('SIGKILL')
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      if (processError !== undefined) {
        reject(processError)
        return
      }
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString('utf8'),
        stdoutTruncated: stdoutBytes > limit,
        timedOut,
        aborted,
      })
    })

    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true
        terminate()
      }, options.timeoutMs)
      timeout.unref()
    }
  })
}
