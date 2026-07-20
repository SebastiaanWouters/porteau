import { defineCommand } from 'citty'

export const setupCommand = defineCommand({
  meta: {
    name: 'setup',
    description: 'Install or inspect native dependencies',
  },
})
