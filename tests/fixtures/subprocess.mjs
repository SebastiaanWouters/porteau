#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

const mode = process.argv[2] ?? '0'

const toolName = basename(process.argv[1])
if (['mydumper', 'myloader'].includes(toolName) && process.argv.includes('--version')) {
  process.stdout.write(`${toolName} v1.0.3-1, built against MySQL 8.0.46 with SSL support\n`)
  process.exit(0)
}

if (toolName === 'mydumper') {
  const output = process.argv.find((argument) => argument.startsWith('--outputdir='))?.slice(12)
  if (!output) throw new Error('missing output directory')
  await mkdir(output)
  await writeFile(`${output}/metadata`, '[`app`.`users`]\nrows = 1\n')
  await writeFile(`${output}/app-schema-create.sql`, 'CREATE DATABASE app;')
  await writeFile(`${output}/app.users-schema.sql`, 'CREATE TABLE users (id INT);')
  await writeFile(`${output}/app.users.00000.sql`, 'INSERT INTO users VALUES (1);')
  const base = {
    schema_version: '1',
    event_version: '1',
    run_id: 'fixture',
    ts: '2026-07-20 12:34:56.123456',
    level: 'INFO',
    tool: 'mydumper',
    message: 'fixture',
    fatal: false,
  }
  if (process.env.PORTEAU_FIXTURE_LOCK_HANG === '1') {
    process.stderr.write(
      `${JSON.stringify({ ...base, seq: 1, event: 'lock', phase: 'global_lock', status: 'started' })}\n`,
    )
    process.stderr.write(
      `${JSON.stringify({ ...base, seq: 2, event: 'table_unlock', phase: 'startup', status: 'finished' })}\n`,
    )
    setInterval(() => {}, 1_000)
  } else {
    process.stderr.write(
      `${JSON.stringify({ ...base, seq: 1, event: 'dump_started', phase: 'dump_start', status: 'started' })}\n`,
    )
    process.stderr.write(
      `${JSON.stringify({ ...base, seq: 2, event: 'dump_completed', phase: 'dump_finish', status: 'finished', errors: '0', warnings: '0', retries: '0', exit_code: '0', duration_ms: '1' })}\n`,
    )
    process.exit(0)
  }
}

if (mode !== '0' && Number.isNaN(Number.parseInt(mode, 10))) {
  const base = {
    schema_version: '1',
    event_version: '1',
    seq: 1,
    run_id: 'fixture',
    ts: '2026-07-20 12:34:56.123456',
    level: 'info',
    tool: 'mydumper',
    event: 'dump_started',
    phase: 'dump',
    status: 'started',
    message: 'started',
    fatal: false,
  }
  const emit = (value, ending = '\n') => process.stderr.write(JSON.stringify(value) + ending)
  if (mode === 'success') {
    emit(base)
    emit({
      ...base,
      seq: 2,
      event: 'dump_completed',
      status: 'finished',
      warnings: '0',
      errors: '0',
      retries: '0',
      exit_code: '0',
      duration_ms: '42',
    })
  } else if (mode === 'warning')
    emit({ ...base, level: 'warning', status: 'warning', message: 'careful' })
  else if (mode === 'malformed') process.stderr.write('{bad}\n')
  else if (mode === 'malformed-hang') {
    process.stderr.write('{bad}\n')
    setInterval(() => {}, 1_000)
  } else if (mode === 'truncated') emit(base, '')
  else if (mode === 'truncated-grandchild') {
    const { spawn } = await import('node:child_process')
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
      { stdio: 'ignore' },
    )
    child.unref()
    await writeFile(process.argv[3], String(child.pid))
    emit(base, '')
  } else if (mode === 'fatal') emit({ ...base, status: 'failed', fatal: true, message: 'failed' })
  else if (mode === 'nonzero') {
    emit(base)
    process.exitCode = 23
  } else if (mode === 'hang' || mode === 'grandchild') {
    if (mode === 'grandchild') {
      const { spawn } = await import('node:child_process')
      const child = spawn(
        process.execPath,
        ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
        { stdio: 'ignore' },
      )
      process.stdout.write(`grandchild:${child.pid}\n`)
    }
    emit(base)
    setInterval(() => {}, 1_000)
  }
} else {
  const exitCode = Number.parseInt(mode, 10)

  process.stdout.write('fixture stdout\n')
  process.stderr.write('fixture stderr\n')
  process.exitCode = exitCode
}
