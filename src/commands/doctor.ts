import { resolve } from 'node:path'
import { defineCommand, type CommandContext } from './types.js'
import { formatDiagnostics } from './doctor-format.js'

export {
  collectDiagnostics,
  formatDiagnostics,
  type DiagnosticCommandOptions,
} from './doctor-format.js'

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Run read-only environment diagnostics',
  },
  args: {
    config: {
      type: 'string',
      alias: 'c',
      description: 'Path to a YAML configuration file',
    },
  },
  async run(context: CommandContext<'collectDiagnostics'>) {
    const { values, cwd, env, presentation, services, signal } = context
    const result = await services.collectDiagnostics({
      ...(values.config ? { configFile: resolve(cwd, String(values.config)) } : {}),
      env,
      cwd,
      signal,
      diagnostics: { env, signal },
    })
    signal.throwIfAborted()
    if (!result.ok) {
      await presentation.reportDiagnostics('doctor', formatDiagnostics(result).join('\n'), result)
      await presentation.failure('doctor', 'Diagnostics found blocking dependency issues.', 1)
      return 1
    }
    await presentation.success('doctor', formatDiagnostics(result).join('\n'), {
      diagnostics: result,
    })
    return 0
  },
})
