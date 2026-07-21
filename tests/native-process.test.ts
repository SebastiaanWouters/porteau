import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'
import { MachineLogParser, runMachineTool } from '../src/core/mydumper.js'

const fixture = fileURLToPath(new URL('./fixtures/subprocess.mjs', import.meta.url))

describe('machine JSONL', () => {
  it.each(['mydumper', 'myloader'] as const)(
    'parses the redacted pinned %s qualification fixture',
    (tool) => {
      const events: unknown[] = []
      const parser = new MachineLogParser(tool, (event) => events.push(event))
      parser.write(
        readFileSync(
          fileURLToPath(
            new URL(`./fixtures/native/${tool}-startup-failure.jsonl`, import.meta.url),
          ),
        ),
      )
      parser.end()
      expect(events.at(-1)).toMatchObject({ type: 'error', fatal: true })
    },
  )

  it.each(['mydumper', 'myloader'] as const)(
    'parses the redacted pinned %s success qualification fixture',
    (tool) => {
      const events: unknown[] = []
      const parser = new MachineLogParser(tool, (event) => events.push(event))
      parser.write(
        readFileSync(
          fileURLToPath(new URL(`./fixtures/native/${tool}-success.jsonl`, import.meta.url)),
        ),
      )
      parser.end()
      expect(events.at(-1)).toMatchObject({
        type: 'completion',
        exitCode: 0,
        errors: '0',
      })
    },
  )

  it('parses chunk boundaries and CRLF and permits additive fields', () => {
    const events: unknown[] = []
    const parser = new MachineLogParser('mydumper', (event) => events.push(event))
    const line = JSON.stringify({
      schema_version: '1',
      event_version: '1',
      seq: 1,
      run_id: 'r',
      ts: '2026-07-20 12:34:56.123456',
      level: 'info',
      tool: 'mydumper',
      event: 'table_progress',
      phase: 'dump',
      status: 'progress',
      message: 'opaque',
      fatal: false,
      rows: '9007199254740993',
      future: true,
    })
    parser.write(line.slice(0, 20))
    parser.write(`${line.slice(20)}\r\n`)
    parser.end()
    expect(events).toMatchObject([{ type: 'progress', rows: '9007199254740993' }])
  })

  it('maps the pinned native cancellation event explicitly', () => {
    const events: unknown[] = []
    const parser = new MachineLogParser('mydumper', (event) => events.push(event))
    parser.write(
      readFileSync(
        fileURLToPath(new URL('./fixtures/native/mydumper-cancelled.jsonl', import.meta.url)),
      ),
    )
    parser.end()
    expect(events).toMatchObject([{ type: 'cancelled', sourceStatus: 'cancelled' }])
  })

  it('rejects versions, unsafe sequences, and truncated lines', () => {
    const parser = new MachineLogParser('mydumper', () => {})
    parser.write('{}')
    expect(() => parser.end()).toThrow(/Truncated/)
  })
})

describe('native process lifecycle', () => {
  it('keeps machine stderr separate and reports exit agreement data', async () => {
    const events: unknown[] = []
    const outcome = await runMachineTool({
      executable: process.execPath,
      args: [fixture, 'success'],
      tool: 'mydumper',
      onEvent: (event) => events.push(event),
    })
    expect(outcome.exitCode).toBe(0)
    expect(events).toMatchObject([{ type: 'status' }, { type: 'completion' }])
  })

  it('times out and terminates a process group', async () => {
    const outcome = await runMachineTool({
      executable: process.execPath,
      args: [fixture, 'grandchild'],
      tool: 'mydumper',
      onEvent: () => {},
      timeoutMs: 50,
      killGraceMs: 50,
    })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.signal).toBe('SIGTERM')
    const pid = Number(/^grandchild:(\d+)/mu.exec(outcome.stdout)?.[1])
    let state = 'unknown'
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] ?? 'unknown'
      } catch {
        state = 'missing'
      }
      if (state === 'missing' || state === 'Z') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(['missing', 'Z']).toContain(state)
  })

  it('surfaces malformed and truncated machine output', async () => {
    await expect(
      runMachineTool({
        executable: process.execPath,
        args: [fixture, 'malformed'],
        tool: 'mydumper',
        onEvent: () => {},
      }),
    ).rejects.toThrow(/Malformed/)
    await expect(
      runMachineTool({
        executable: process.execPath,
        args: [fixture, 'truncated'],
        tool: 'mydumper',
        onEvent: () => {},
      }),
    ).rejects.toThrow(/Truncated/)
  })

  it('terminates a hanging process immediately after malformed machine output', async () => {
    await expect(
      runMachineTool({
        executable: process.execPath,
        args: [fixture, 'malformed-hang'],
        tool: 'mydumper',
        onEvent: () => {},
      }),
    ).rejects.toThrow(/Malformed/)
  })

  it('kills surviving descendants when stderr ends with a truncated event', async () => {
    const pidFile = `/tmp/porteau-truncated-${process.pid}.pid`
    try {
      await expect(
        runMachineTool({
          executable: process.execPath,
          args: [fixture, 'truncated-grandchild', pidFile],
          tool: 'mydumper',
          onEvent: () => {},
        }),
      ).rejects.toThrow(/Truncated/)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      let state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2]
      for (let attempt = 0; state !== 'Z' && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        try {
          state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2]
        } catch {
          state = 'missing'
        }
      }
      expect(['missing', 'Z']).toContain(state)
    } finally {
      rmSync(pidFile, { force: true })
    }
  })
})
