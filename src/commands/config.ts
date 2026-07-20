import { defineCommand } from 'citty'

export const configCommand = defineCommand({
  meta: {
    name: 'config',
    description: 'Inspect the effective configuration',
  },
})
