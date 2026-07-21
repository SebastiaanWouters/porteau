import { defineCommand } from 'citty'

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Create a Porteau configuration',
  },
  args: {
    output: { type: 'string', alias: 'o', description: 'Configuration file to create' },
    host: { type: 'string', description: 'Database host' },
    port: { type: 'string', description: 'Database port' },
    user: { type: 'string', description: 'Database user' },
    database: { type: 'string', description: 'Comma-separated included databases' },
  },
})
