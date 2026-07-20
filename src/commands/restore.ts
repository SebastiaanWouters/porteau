import { defineCommand } from 'citty'

export const restoreCommand = defineCommand({
  meta: {
    name: 'restore',
    description: 'Restore a Porteau backup artifact',
  },
})
