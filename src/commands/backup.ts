import { defineCommand } from 'citty'
import { dirname, resolve } from 'node:path'
import { runBackup } from '../core/backup.js'
import { loadConfig } from '../core/config.js'

export const backupCommand = defineCommand({
  meta: {
    name: 'backup',
    description: 'Create a consistent logical backup',
  },
  args: {
    config: {
      type: 'string',
      alias: 'c',
      description: 'Path to a YAML configuration file',
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Final backup directory (must not already exist)',
    },
  },
  async run({ args }) {
    const configFile = args.config ? resolve(args.config) : undefined
    const config = await loadConfig(configFile ? { configFile } : {})
    const controller = new AbortController()
    const abort = () => controller.abort()
    process.once('SIGINT', abort)
    process.once('SIGTERM', abort)
    try {
      const result = await runBackup({
        config,
        configDirectory: configFile ? dirname(configFile) : process.cwd(),
        ...(args.output ? { outputDirectory: args.output } : {}),
        signal: controller.signal,
        onEvent(event) {
          if (event.type === 'warning') process.stderr.write(`warning: ${event.message}\n`)
        },
      })
      process.stdout.write(`Backup completed: ${result.outputDirectory}\n`)
    } finally {
      process.removeListener('SIGINT', abort)
      process.removeListener('SIGTERM', abort)
    }
  },
})
