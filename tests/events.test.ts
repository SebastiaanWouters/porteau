import * as v from 'valibot'
import { describe, expect, it } from 'vite-plus/test'
import { engineEventSchema } from '../src/core/events.js'

const baseEvent = {
  runId: '019f8150-6219-76ac-9fb7-3f43e7040cd6',
  sequence: 1,
  timestamp: '2026-07-20T23:00:00.000Z',
  phase: 'backup',
  tool: 'mydumper',
  sourceEvent: 'process_error',
  sourcePhase: 'dump',
  sourceStatus: 'failed',
} as const

describe('normalized engine event contract', () => {
  it('preserves large counters and object context on errors', () => {
    const event = v.parse(engineEventSchema, {
      ...baseEvent,
      type: 'error',
      message: 'table failed',
      fatal: true,
      database: 'app',
      table: 'events',
      rows: '9007199254740993',
      bytes: '18446744073709551615',
      retries: '9007199254740994',
    })

    expect(event.rows).toBe('9007199254740993')
    expect(event.retries).toBe('9007199254740994')
    expect(event.table).toBe('events')
  })

  it('represents cancellation explicitly', () => {
    expect(
      v.safeParse(engineEventSchema, {
        ...baseEvent,
        type: 'cancelled',
        sourceStatus: 'cancelled',
      }).success,
    ).toBe(true)
  })

  it('rejects lossy numeric row counters', () => {
    expect(
      v.safeParse(engineEventSchema, {
        ...baseEvent,
        type: 'progress',
        sourceStatus: 'progress',
        rows: 9_007_199_254_740_992,
      }).success,
    ).toBe(false)
  })
})
