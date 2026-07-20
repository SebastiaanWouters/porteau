import { defineCommand } from 'citty'

export const backupCommand = defineCommand({
  meta: {
    name: 'backup',
    description: 'Create a consistent logical backup',
  },
})
