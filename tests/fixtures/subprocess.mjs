#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

const mode = process.argv[2] ?? '0'

const toolName = basename(process.argv[1])
if (['mydumper', 'myloader'].includes(toolName) && process.argv.includes('--help')) {
  process.stdout.write('--machine-log-json\n')
  process.exit(0)
}
if (['mydumper', 'myloader'].includes(toolName) && process.argv.includes('--version')) {
  if (process.env.PORTEAU_FIXTURE_VERSION_INVOCATION)
    await writeFile(`${process.env.PORTEAU_FIXTURE_VERSION_INVOCATION}-${toolName}`, 'version')
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
      `${JSON.stringify({ ...base, seq: 2, event: 'backup_consistency', phase: 'startup', status: 'finished' })}\n`,
    )
    process.stderr.write(
      `${JSON.stringify({ ...base, seq: 3, event: 'table_unlock', phase: 'startup', status: 'finished' })}\n`,
    )
    setInterval(() => {}, 1_000)
  } else {
    const transitions = [
      { event: 'lock', phase: 'global_lock', status: 'started' },
      { event: 'backup_consistency', phase: 'startup', status: 'finished' },
      { event: 'table_unlock', phase: 'startup', status: 'finished' },
      { event: 'dump_phase', phase: 'wait_database_finish', status: 'progress' },
    ]
    if (process.env.PORTEAU_FIXTURE_LIFECYCLE === 'missing') transitions.splice(1, 1)
    if (process.env.PORTEAU_FIXTURE_LIFECYCLE === 'reordered') {
      ;[transitions[1], transitions[2]] = [transitions[2], transitions[1]]
    }
    transitions.forEach((transition, index) =>
      process.stderr.write(`${JSON.stringify({ ...base, seq: index + 1, ...transition })}\n`),
    )
    process.stderr.write(
      `${JSON.stringify({
        ...base,
        seq: transitions.length + 1,
        event: 'dump_completed',
        phase: 'dump_finish',
        status: 'finished',
        errors: '0',
        warnings: '0',
        retries: '0',
        files: process.env.PORTEAU_FIXTURE_FILE_COUNT ?? '4',
        exit_code: '0',
        duration_ms: '1',
      })}\n`,
    )
    process.exit(0)
  }
}

if (toolName === 'myloader') {
  const base = {
    schema_version: '1',
    event_version: '1',
    run_id: 'restore-fixture',
    ts: '2026-07-20 12:34:56.123456',
    level: 'INFO',
    tool: 'myloader',
    message: 'fixture',
    fatal: false,
  }
  if (process.env.PORTEAU_FIXTURE_INVOCATION)
    await writeFile(process.env.PORTEAU_FIXTURE_INVOCATION, JSON.stringify(process.argv.slice(2)))
  process.stderr.write(
    `${JSON.stringify({ ...base, seq: 1, event: 'process_config', phase: 'startup', status: 'started' })}\n`,
  )
  if (process.env.PORTEAU_FIXTURE_RESTORE_HANG === '1') {
    setInterval(() => {}, 1_000)
  } else if (process.env.PORTEAU_FIXTURE_RESTORE_CANCELLED === '1') {
    process.stderr.write(
      `${JSON.stringify({ ...base, seq: 2, event: 'restore_cancelled', phase: 'cleanup', status: 'cancelled' })}\n`,
    )
  } else if (process.env.PORTEAU_FIXTURE_RESTORE_FATAL === '1') {
    process.stderr.write(
      `${JSON.stringify({ ...base, seq: 2, event: 'process_error', phase: 'runtime', status: 'failed', fatal: true })}\n`,
    )
  } else if (process.env.PORTEAU_FIXTURE_RESTORE_NO_COMPLETION !== '1') {
    const exitCode = process.env.PORTEAU_FIXTURE_RESTORE_EVENT_EXIT ?? '0'
    process.stderr.write(
      `${JSON.stringify({
        ...base,
        seq: 2,
        event: 'restore_completed',
        phase: 'restore_finish',
        status: 'finished',
        errors: process.env.PORTEAU_FIXTURE_RESTORE_ERRORS ?? '0',
        warnings: '0',
        retries: '0',
        files: '4',
        exit_code: exitCode,
        duration_ms: '1',
      })}\n`,
    )
    if (process.env.PORTEAU_FIXTURE_RESTORE_DUPLICATE_COMPLETION === '1')
      process.stderr.write(
        `${JSON.stringify({
          ...base,
          seq: 3,
          event: 'restore_completed',
          phase: 'restore_finish',
          status: 'finished',
          errors: '0',
          warnings: '0',
          retries: '0',
          files: '4',
          exit_code: exitCode,
          duration_ms: '1',
        })}\n`,
      )
    process.exitCode = Number(process.env.PORTEAU_FIXTURE_RESTORE_PROCESS_EXIT ?? '0')
  }
  if (process.env.PORTEAU_FIXTURE_RESTORE_HANG !== '1') process.exit(process.exitCode ?? 0)
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
      files: '0',
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
