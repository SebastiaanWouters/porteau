import { defineCommand } from 'citty'

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Run read-only environment diagnostics',
  },
})
