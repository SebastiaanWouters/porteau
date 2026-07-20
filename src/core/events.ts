import * as v from 'valibot'

const decimalCounterSchema = v.pipe(v.string(), v.regex(/^(0|[1-9]\d*)$/))
const countSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0))

const commonEntries = {
  runId: v.string(),
  sequence: countSchema,
  parentSequence: v.optional(countSchema),
  timestamp: v.string(),
  phase: v.picklist([
    'startup',
    'preflight',
    'locking',
    'backup',
    'restore',
    'verification',
    'finalization',
  ]),
  tool: v.picklist(['mydumper', 'myloader']),
  sourceEvent: v.string(),
  sourcePhase: v.string(),
  sourceStatus: v.picklist(['started', 'progress', 'finished', 'failed', 'cancelled', 'warning']),
  database: v.optional(v.string()),
  table: v.optional(v.string()),
  rows: v.optional(decimalCounterSchema),
  bytes: v.optional(decimalCounterSchema),
  retries: v.optional(decimalCounterSchema),
  warnings: v.optional(decimalCounterSchema),
  errors: v.optional(decimalCounterSchema),
}

export const engineEventSchema = v.variant('type', [
  v.strictObject({
    ...commonEntries,
    type: v.literal('status'),
    status: v.picklist(['started', 'running', 'completed']),
    message: v.optional(v.string()),
  }),
  v.strictObject({
    ...commonEntries,
    type: v.literal('progress'),
    completed: v.optional(decimalCounterSchema),
    total: v.optional(decimalCounterSchema),
  }),
  v.strictObject({
    ...commonEntries,
    type: v.literal('warning'),
    code: v.optional(v.string()),
    message: v.string(),
  }),
  v.strictObject({
    ...commonEntries,
    type: v.literal('error'),
    code: v.optional(v.string()),
    message: v.string(),
    fatal: v.boolean(),
    retryable: v.optional(v.boolean()),
  }),
  v.strictObject({
    ...commonEntries,
    type: v.literal('cancelled'),
    message: v.optional(v.string()),
  }),
  v.strictObject({
    ...commonEntries,
    type: v.literal('completion'),
    exitCode: v.pipe(v.number(), v.safeInteger()),
    errors: decimalCounterSchema,
    warnings: decimalCounterSchema,
    retries: decimalCounterSchema,
    durationMs: v.optional(countSchema),
  }),
])

export type EngineEvent = v.InferOutput<typeof engineEventSchema>
export type EnginePhase = EngineEvent['phase']
export type StatusEvent = Extract<EngineEvent, { type: 'status' }>
export type ProgressEvent = Extract<EngineEvent, { type: 'progress' }>
export type WarningEvent = Extract<EngineEvent, { type: 'warning' }>
export type ErrorEvent = Extract<EngineEvent, { type: 'error' }>
export type CancelledEvent = Extract<EngineEvent, { type: 'cancelled' }>
export type CompletionEvent = Extract<EngineEvent, { type: 'completion' }>
