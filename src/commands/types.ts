import type { loadConfig } from '../core/config.js'
import type { runBackup } from '../core/backup.js'
import type { runRestore } from '../core/restore.js'
import type { Presentation } from '../presentation/context.js'
import type { PromptAdapter } from '../presentation/prompts.js'
import type { collectDiagnostics } from './doctor-format.js'

export interface CliServices {
  loadConfig: typeof loadConfig
  runBackup: typeof runBackup
  runRestore: typeof runRestore
  collectDiagnostics: typeof collectDiagnostics
}

export type PresentationFlags = ConstructorParameters<typeof Presentation>[0]

export interface ArgDefinition {
  readonly type: 'string' | 'boolean'
  readonly alias?: string | string[]
  readonly description?: string
}

export interface CommandMeta {
  readonly name: string
  readonly description: string
}

export interface CommandRuntime {
  readonly presentation: Presentation
  readonly prompts: PromptAdapter
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly signal: AbortSignal
  readonly flags: PresentationFlags
}

export interface CommandContext<
  ServiceKeys extends keyof CliServices = keyof CliServices,
> extends CommandRuntime {
  readonly values: Readonly<Record<string, string | boolean>>
  readonly services: Pick<CliServices, ServiceKeys>
}

export interface CommandModule<ServiceKeys extends keyof CliServices = keyof CliServices> {
  readonly meta: CommandMeta
  readonly args: Record<string, ArgDefinition>
  run(context: CommandContext<ServiceKeys>): Promise<number>
}

export function defineCommand<ServiceKeys extends keyof CliServices>(
  command: CommandModule<ServiceKeys>,
): CommandModule<ServiceKeys> {
  return command
}
