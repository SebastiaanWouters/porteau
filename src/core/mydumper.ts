import type { EngineEvent, EnginePhase } from './events.js'
import { StringDecoder } from 'node:string_decoder'
import { runNativeProcess, type NativeProcessOptions, type ProcessOutcome } from './process.js'

export type MachineTool = 'mydumper' | 'myloader'

type JsonRecord = Record<string, unknown>
const timestampPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{1,6}$/
const decimals = [
  'rows',
  'rows_done',
  'rows_total',
  'bytes',
  'retries',
  'warnings',
  'errors',
  'completed',
  'total',
  'exit_code',
  'duration_ms',
] as const

function requiredString(record: JsonRecord, name: string): string {
  if (typeof record[name] !== 'string' || record[name] === '')
    throw new Error(`Invalid machine event field: ${name}`)
  return record[name]
}

function decimal(record: JsonRecord, name: (typeof decimals)[number]): string | undefined {
  const value = record[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error(`Invalid machine event field: ${name}`)
  return value
}

function requiredDecimal(record: JsonRecord, name: (typeof decimals)[number]): string {
  const value = decimal(record, name)
  if (value === undefined) throw new Error(`Machine completion event is missing ${name}`)
  return value
}

function sourcePhase(phase: string, tool: MachineTool): EnginePhase {
  const normalized = phase.toLowerCase()
  if (/start|initial/.test(normalized)) return 'startup'
  if (/lock|snapshot/.test(normalized)) return 'locking'
  if (/verify|check/.test(normalized)) return 'verification'
  if (/final|cleanup|complete/.test(normalized)) return 'finalization'
  return tool === 'mydumper' ? 'backup' : 'restore'
}

export function parseMachineEvent(line: string, expectedTool: MachineTool): EngineEvent {
  let record: JsonRecord
  try {
    const value: unknown = JSON.parse(line)
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error()
    record = value as JsonRecord
  } catch {
    throw new Error('Malformed machine log JSON')
  }
  if (record.schema_version !== '1' || record.event_version !== '1')
    throw new Error('Unsupported machine log version')
  if (record.tool !== expectedTool) throw new Error('Unexpected machine log tool')
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) < 0)
    throw new Error('Invalid machine event field: seq')
  if (
    record.parent_seq !== undefined &&
    (!Number.isSafeInteger(record.parent_seq) || (record.parent_seq as number) < 0)
  )
    throw new Error('Invalid machine event field: parent_seq')
  const timestamp = requiredString(record, 'ts')
  if (!timestampPattern.test(timestamp)) throw new Error('Invalid machine event field: ts')
  const event = requiredString(record, 'event')
  const phase = requiredString(record, 'phase')
  const status = requiredString(record, 'status')
  const message = typeof record.message === 'string' ? record.message : event
  requiredString(record, 'level')
  if (typeof record.fatal !== 'boolean') throw new Error('Invalid machine event field: fatal')
  if (record.retryable !== undefined && typeof record.retryable !== 'boolean')
    throw new Error('Invalid machine event field: retryable')
  for (const name of decimals) decimal(record, name)

  const common = {
    runId: requiredString(record, 'run_id'),
    sequence: record.seq as number,
    ...(record.parent_seq === undefined ? {} : { parentSequence: record.parent_seq as number }),
    timestamp,
    phase: sourcePhase(phase, expectedTool),
    tool: expectedTool,
    sourceEvent: event,
    sourcePhase: phase,
    sourceStatus: status as EngineEvent['sourceStatus'],
    ...(typeof (record.database ?? record.db) === 'string'
      ? { database: (record.database ?? record.db) as string }
      : {}),
    ...(typeof record.table === 'string' ? { table: record.table } : {}),
    ...((decimal(record, 'rows') ?? decimal(record, 'rows_done'))
      ? { rows: decimal(record, 'rows') ?? decimal(record, 'rows_done') }
      : {}),
    ...(decimal(record, 'bytes') ? { bytes: decimal(record, 'bytes') } : {}),
    ...(decimal(record, 'retries') ? { retries: decimal(record, 'retries') } : {}),
    ...(decimal(record, 'warnings') ? { warnings: decimal(record, 'warnings') } : {}),
    ...(decimal(record, 'errors') ? { errors: decimal(record, 'errors') } : {}),
  }
  if (
    ![
      'started',
      'progress',
      'finished',
      'failed',
      'cancelled',
      'warning',
      'detected',
      'paused',
    ].includes(status)
  )
    throw new Error('Invalid machine event field: status')
  if (status === 'cancelled') return { ...common, type: 'cancelled', message } as EngineEvent
  if (record.fatal || status === 'failed')
    return {
      ...common,
      type: 'error',
      message,
      fatal: record.fatal,
      ...(record.retryable === undefined ? {} : { retryable: record.retryable }),
    } as EngineEvent
  if (status === 'warning' || String(record.level).toLowerCase() === 'warning')
    return { ...common, type: 'warning', message } as EngineEvent
  if (status === 'progress')
    return {
      ...common,
      type: 'progress',
      completed: decimal(record, 'completed') ?? decimal(record, 'rows_done'),
      total: decimal(record, 'total') ?? decimal(record, 'rows_total'),
    } as EngineEvent
  if (status === 'finished' && ['dump_completed', 'restore_completed'].includes(event)) {
    const exitCode = requiredDecimal(record, 'exit_code')
    const errors = requiredDecimal(record, 'errors')
    const warnings = requiredDecimal(record, 'warnings')
    const retries = requiredDecimal(record, 'retries')
    const duration = decimal(record, 'duration_ms')
    if (!Number.isSafeInteger(Number(exitCode)))
      throw new Error('Invalid machine event field: exit_code')
    if (duration !== undefined && !Number.isSafeInteger(Number(duration)))
      throw new Error('Invalid machine event field: duration_ms')
    return {
      ...common,
      type: 'completion',
      exitCode: Number(exitCode),
      errors,
      warnings,
      retries,
      ...(duration === undefined ? {} : { durationMs: Number(duration) }),
    } as EngineEvent
  }
  return {
    ...common,
    type: 'status',
    status: status === 'started' ? 'started' : status === 'finished' ? 'completed' : 'running',
    message,
  } as EngineEvent
}

export class MachineLogParser {
  #pending = ''
  readonly #decoder = new StringDecoder('utf8')
  constructor(
    private readonly tool: MachineTool,
    private readonly emit: (event: EngineEvent) => void,
  ) {}
  write(chunk: Uint8Array | string): void {
    this.#pending += typeof chunk === 'string' ? chunk : this.#decoder.write(Buffer.from(chunk))
    const lines = this.#pending.split('\n')
    this.#pending = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line) this.emit(parseMachineEvent(line, this.tool))
    }
  }
  end(): void {
    this.#pending += this.#decoder.end()
    if (this.#pending !== '') throw new Error('Truncated machine log line')
  }
}

export async function runMachineTool(
  options: Omit<NativeProcessOptions, 'onStderr'> & {
    tool: MachineTool
    onEvent: (event: EngineEvent) => void
  },
): Promise<ProcessOutcome> {
  const parser = new MachineLogParser(options.tool, options.onEvent)
  const outcome = await runNativeProcess({
    ...options,
    onStderr: (chunk) => {
      parser.write(chunk)
    },
    onStderrEnd: () => parser.end(),
  })
  return outcome
}
