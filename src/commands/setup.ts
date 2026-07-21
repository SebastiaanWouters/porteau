import { defineCommand } from 'citty'
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
    yes: {
      type: 'boolean',
      description: 'Approve and execute the displayed installation plan',
    },
    config: {
      type: 'string',
      alias: 'c',
      description: 'Path to a YAML configuration file',
    },
  },
})
