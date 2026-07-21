import { defineCommand } from 'citty'
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
    user: { type: 'string', description: 'Database user' },
    database: { type: 'string', description: 'Comma-separated included databases' },
  },
})
