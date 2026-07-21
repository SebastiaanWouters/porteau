import { defineCommand } from 'citty'
import { runDiagnosticCommand } from './doctor.js'

export const setupCommand = defineCommand({
  meta: {
    name: 'setup',
    description: 'Install or inspect native dependencies',
  },
  args: {
    check: {
      type: 'boolean',
      description: 'Run read-only dependency diagnostics',
    },
    config: {
      type: 'string',
      alias: 'c',
      description: 'Path to a YAML configuration file',
    },
  },
  async run({ args }) {
    if (!args.check) {
      throw new Error('Setup mutation is not implemented yet; use porteau setup --check')
    }
    await runDiagnosticCommand(args.config ? { configFile: args.config } : {})
  },
})
