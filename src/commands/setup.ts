import { defineCommand } from 'citty'
import {
  approvedInstall,
  executeInstallPlan,
  planUbuntuInstall,
  renderInstallPlan,
} from '../setup/ubuntu.js'
import { collectDiagnostics, runDiagnosticCommand } from './doctor.js'

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
  async run({ args }) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    process.once('SIGINT', abort)
    process.once('SIGTERM', abort)
    try {
      if (args.check && args.yes) throw new Error('--check and --yes cannot be used together')
      if (args.check) {
        await runDiagnosticCommand(args.config ? { configFile: args.config } : {})
        return
      }
      const diagnostics = await collectDiagnostics(args.config ? { configFile: args.config } : {})
      const plan = planUbuntuInstall(diagnostics)
      for (const line of renderInstallPlan(plan)) process.stdout.write(`${line}\n`)
      if (plan.supported && !plan.node && !plan.nativeTools) return
      if (!args.yes)
        throw new Error('Setup requires --yes before making changes; use porteau setup --check')
      await executeInstallPlan(plan, approvedInstall, undefined, controller.signal)
    } finally {
      process.removeListener('SIGINT', abort)
      process.removeListener('SIGTERM', abort)
    }
  },
})
