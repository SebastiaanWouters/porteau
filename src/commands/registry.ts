import { backupCommand } from './backup.js'
import { configCommand } from './config.js'
import { doctorCommand } from './doctor.js'
import { initCommand } from './init.js'
import { restoreCommand } from './restore.js'
import type { CommandModule } from './types.js'

export const COMMANDS = {
  backup: backupCommand,
  restore: restoreCommand,
  init: initCommand,
  doctor: doctorCommand,
  config: configCommand,
} as const satisfies Record<string, CommandModule>

export type CommandName = keyof typeof COMMANDS
