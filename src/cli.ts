#!/usr/bin/env node

import { defineCommand, renderUsage, runCommand } from 'citty'
import packageJson from '../package.json' with { type: 'json' }
import { backupCommand } from './commands/backup.js'
import { configCommand } from './commands/config.js'
import { doctorCommand } from './commands/doctor.js'
import { initCommand } from './commands/init.js'
import { restoreCommand } from './commands/restore.js'
import { setupCommand } from './commands/setup.js'

export const mainCommand = defineCommand({
  meta: {
    name: 'porteau',
    version: packageJson.version,
    description: packageJson.description,
  },
  subCommands: {
    backup: backupCommand,
    restore: restoreCommand,
    init: initCommand,
    setup: setupCommand,
    doctor: doctorCommand,
    config: configCommand,
  },
})

export interface CliExecutionOptions {
  readonly args?: string[]
  readonly stdout?: (line: string) => void
  readonly stderr?: (line: string) => void
}

const commands = {
  backup: backupCommand,
  restore: restoreCommand,
  init: initCommand,
  setup: setupCommand,
  doctor: doctorCommand,
  config: configCommand,
} as const
const usageParent = { meta: { name: 'porteau' } }

async function requestedUsage(args: readonly string[]): Promise<string> {
  const name = args.find((argument) => !argument.startsWith('-'))
  switch (name) {
    case 'backup':
      return renderUsage(commands.backup, usageParent)
    case 'restore':
      return renderUsage(commands.restore, usageParent)
    case 'init':
      return renderUsage(commands.init, usageParent)
    case 'setup':
      return renderUsage(commands.setup, usageParent)
    case 'doctor':
      return renderUsage(commands.doctor, usageParent)
    case 'config':
      return renderUsage(commands.config, usageParent)
    default:
      return renderUsage(mainCommand)
  }
}

export async function executeCli(options: CliExecutionOptions = {}): Promise<number> {
  const args = options.args ?? process.argv.slice(2)
  const stdout = options.stdout ?? ((line: string) => console.log(line))
  const stderr = options.stderr ?? ((line: string) => console.error(line))
  let interrupted = false
  const onSigint = () => {
    interrupted = true
  }
  process.once('SIGINT', onSigint)
  try {
    if (args.includes('--help') || args.includes('-h')) {
      stdout(await requestedUsage(args))
      return interrupted ? 130 : 0
    }
    if (args.length === 1 && ['--version', '-v'].includes(args[0]!)) {
      stdout(packageJson.version)
      return 0
    }
    await runCommand(mainCommand, { rawArgs: args })
    return interrupted ? 130 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown failure'
    stderr(`error: ${message.replace(/[\r\n]+/gu, ' ')}`)
    return interrupted || (error instanceof Error && error.name === 'AbortError') ? 130 : 1
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

if (import.meta.main) {
  process.exitCode = await executeCli()
}
