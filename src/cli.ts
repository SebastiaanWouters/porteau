#!/usr/bin/env node
import { stripVTControlCharacters } from 'node:util'
import packageJson from '../package.json' with { type: 'json' }
import { collectDiagnostics } from './commands/doctor-format.js'
import { COMMANDS, type CommandName } from './commands/registry.js'
import { UsageError } from './commands/shared.js'
import type { CliServices } from './commands/types.js'
import { runBackup } from './core/backup.js'
import { loadConfig } from './core/config.js'
import { runRestore } from './core/restore.js'
import { OutputError, Presentation } from './presentation/context.js'
import { clackPrompts, type PromptAdapter } from './presentation/prompts.js'
import type { ProgressFactory } from './presentation/progress.js'
import { renderUsage } from './cli/usage.js'

export type { CliServices } from './commands/types.js'
export { COMMANDS } from './commands/registry.js'

export interface CliExecutionOptions {
  args?: string[]
  stdout?: (line: string) => unknown
  stderr?: (line: string) => unknown
  env?: NodeJS.ProcessEnv
  cwd?: string
  stdinTTY?: boolean
  stdoutTTY?: boolean
  stderrTTY?: boolean
  prompts?: PromptAdapter
  progress?: ProgressFactory
  services?: Partial<CliServices>
}

const defaultServices: CliServices = {
  loadConfig,
  runBackup,
  runRestore,
  collectDiagnostics,
}

const globalBoolean = new Set(['--json', '--quiet', '--verbose', '--no-interactive', '--yes'])

interface ParsedCli {
  readonly flags: PresentationFlags
  readonly command?: CommandName
  readonly values: Record<string, string | boolean>
  readonly help: boolean
  readonly version: boolean
}

type PresentationFlags = ConstructorParameters<typeof Presentation>[0]

interface ParseContext {
  readonly flags: PresentationFlags
  command?: CommandName
}

function setGlobal(flags: PresentationFlags, value: string): boolean {
  if (!globalBoolean.has(value)) return false
  if (value === '--json') flags.json = true
  if (value === '--quiet') flags.quiet = true
  if (value === '--verbose') flags.verbose = true
  if (value === '--no-interactive') flags.interactive = false
  if (value === '--yes') flags.yes = true
  return true
}

function optionDefinitions(command: CommandName) {
  const definitions = COMMANDS[command].args
  const options = new Map<string, { name: string; boolean: boolean }>()
  for (const [name, definition] of Object.entries(definitions)) {
    const option = { name, boolean: definition.type === 'boolean' }
    options.set(`--${name}`, option)
    for (const alias of Array.isArray(definition.alias)
      ? definition.alias
      : definition.alias
        ? [definition.alias]
        : [])
      options.set(`-${alias}`, option)
  }
  return options
}

function parseCommandArguments(
  command: CommandName,
  raw: string[],
  flags: PresentationFlags,
  literal = false,
): { values: Record<string, string | boolean>; help: boolean; version: boolean } {
  const definitions = optionDefinitions(command)
  const values: Record<string, string | boolean> = {}
  let help = false
  let version = false
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index]!
    if (literal || token === '--') {
      if (token === '--') literal = true
      else throw new UsageError(`Unexpected positional argument: ${token}`)
      continue
    }
    if (token === '--help' || token === '-h') {
      help = true
      continue
    }
    if (token === '--version' || token === '-v') {
      version = true
      continue
    }
    if (setGlobal(flags, token)) continue

    const equals = token.startsWith('--') ? token.indexOf('=') : -1
    const optionName = equals > 0 ? token.slice(0, equals) : token
    const definition = definitions.get(optionName)
    if (!definition) throw new UsageError(`Unknown option: ${optionName}`)
    if (definition.name in values) throw new UsageError(`${optionName} was provided more than once`)
    if (definition.boolean) {
      if (equals > 0) throw new UsageError(`${optionName} does not accept a value`)
      values[definition.name] = true
      continue
    }
    const value = equals > 0 ? token.slice(equals + 1) : raw[++index]
    if (value === undefined || value === '') throw new UsageError(`${optionName} requires a value`)
    values[definition.name] = value
  }
  return { values, help, version }
}

function parse(raw: string[], context: ParseContext): ParsedCli {
  const { flags } = context
  let command: CommandName | undefined
  let help = false
  let version = false
  let commandStart = raw.length
  let literalCommand = false
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index]!
    if (token === '--') {
      const candidate = raw[index + 1]
      if (!candidate || !(candidate in COMMANDS))
        throw new UsageError(candidate ? `Unknown command: ${candidate}` : 'No command specified')
      command = candidate as CommandName
      context.command = command
      commandStart = index + 2
      literalCommand = true
      break
    }
    if (token === '--help' || token === '-h') {
      help = true
      continue
    }
    if (token === '--version' || token === '-v') {
      version = true
      continue
    }
    if (setGlobal(flags, token)) continue
    if (token.startsWith('-')) throw new UsageError(`Unknown option: ${token}`)
    if (!(token in COMMANDS)) throw new UsageError(`Unknown command: ${token}`)
    command = token as CommandName
    context.command = command
    commandStart = index + 1
    break
  }

  const commandArguments = command
    ? parseCommandArguments(command, raw.slice(commandStart), flags, literalCommand)
    : { values: {}, help: false, version: false }
  help ||= commandArguments.help
  version ||= commandArguments.version
  if (flags.quiet && flags.verbose)
    throw new UsageError('--quiet and --verbose cannot be used together')
  if (flags.json && (flags.quiet || flags.verbose))
    throw new UsageError('--json cannot be combined with --quiet or --verbose')
  if (flags.json) flags.interactive = false
  if (version && (command || help))
    throw new UsageError('--version cannot be combined with a command')
  return {
    flags,
    ...(command ? { command } : {}),
    values: commandArguments.values,
    help,
    version,
  }
}

function streamWriter(stream: NodeJS.WriteStream): (line: string) => Promise<void> {
  return (line) =>
    new Promise<void>((resolveWrite, rejectWrite) => {
      let settled = false
      const finish = (error?: Error | null) => {
        if (settled) return
        settled = true
        stream.removeListener('error', finish)
        if (error) rejectWrite(error)
        else resolveWrite()
      }
      stream.once('error', finish)
      stream.write(`${line}\n`, finish)
    })
}

export async function executeCli(options: CliExecutionOptions = {}): Promise<number> {
  const env = options.env ?? process.env,
    cwd = options.cwd ?? process.cwd(),
    prompts = options.prompts ?? clackPrompts,
    services = { ...defaultServices, ...options.services }
  const raw = options.args ?? process.argv.slice(2)
  const parseContext: ParseContext = {
    flags: { json: false, quiet: false, verbose: false, interactive: true, yes: false },
  }
  let parsed: ParsedCli
  let command = 'porteau'
  try {
    parsed = parse(raw, parseContext)
  } catch (error) {
    const p = new Presentation(
      { ...parseContext.flags, interactive: false },
      {
        stdout: options.stdout ?? streamWriter(process.stdout),
        stderr: options.stderr ?? streamWriter(process.stderr),
        stdinTTY: false,
        stdoutTTY: false,
        stderrTTY: false,
      },
      env,
    )
    await p.failure(
      parseContext.command ?? command,
      error instanceof Error ? error.message : 'Invalid arguments',
      2,
    )
    return 2
  }
  const io = {
    stdout: options.stdout ?? streamWriter(process.stdout),
    stderr: options.stderr ?? streamWriter(process.stderr),
    stdinTTY: options.stdinTTY ?? !!process.stdin.isTTY,
    stdoutTTY: options.stdoutTTY ?? !!process.stdout.isTTY,
    stderrTTY: options.stderrTTY ?? !!process.stderr.isTTY,
  }
  const controller = new AbortController()
  const presentation = new Presentation(
    parsed.flags,
    io,
    env,
    options.progress,
    controller.signal,
    () => controller.abort(),
  )
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    const name = parsed.command
    command = name ?? 'porteau'
    if (parsed.version) {
      await presentation.success('porteau', packageJson.version, { version: packageJson.version })
      return 0
    }
    if (parsed.help || !name) {
      const text = renderUsage(name)
      controller.signal.throwIfAborted()
      const rendered = presentation.color ? text : stripVTControlCharacters(text)
      await presentation.success(name ?? 'porteau', rendered, { help: rendered })
      return controller.signal.aborted ? 130 : 0
    }
    return await COMMANDS[name].run({
      values: parsed.values,
      flags: parsed.flags,
      presentation,
      prompts,
      services,
      env,
      cwd,
      signal: controller.signal,
    })
  } catch (error) {
    const cancelled =
      controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
    const code = cancelled ? 130 : error instanceof UsageError ? 2 : 1
    if (!(error instanceof OutputError))
      await presentation.failure(
        command,
        cancelled
          ? 'Operation cancelled'
          : error instanceof Error
            ? error.message
            : 'Unknown failure',
        code,
      )
    return code
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
}

if (import.meta.main) process.exitCode = await executeCli()
