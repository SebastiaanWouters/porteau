#!/usr/bin/env node

import { defineCommand, runMain } from 'citty'
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

if (import.meta.main) {
  await runMain(mainCommand)
}
