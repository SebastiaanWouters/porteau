#!/usr/bin/env node
import { defineCommand, renderUsage } from 'citty'
import { randomUUID } from 'node:crypto'
import { link, open, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import packageJson from '../package.json' with { type: 'json' }
import { backupCommand } from './commands/backup.js'
import { configCommand } from './commands/config.js'
import { collectDiagnostics, doctorCommand, formatDiagnostics } from './commands/doctor.js'
import { initCommand } from './commands/init.js'
import { restoreCommand } from './commands/restore.js'
import { setupCommand } from './commands/setup.js'
import { runBackup } from './core/backup.js'
import { defaultConfig, loadConfig, validateConfig, type PorteauConfig } from './core/config.js'
import { runRestore, type RestoreConfirmation } from './core/restore.js'
import {
  approvedInstall,
  executeInstallPlan,
  planUbuntuInstall,
  renderInstallPlan,
} from './setup/ubuntu.js'
import { OutputError, Presentation } from './presentation/context.js'
import { clackPrompts, type PromptAdapter } from './presentation/prompts.js'
import type { ProgressFactory } from './presentation/progress.js'

export const mainCommand = defineCommand({
  meta: { name: 'porteau', version: packageJson.version, description: packageJson.description },
  subCommands: {
    backup: backupCommand,
    restore: restoreCommand,
    init: initCommand,
    setup: setupCommand,
    doctor: doctorCommand,
    config: configCommand,
  },
})
const commands = {
  backup: backupCommand,
  restore: restoreCommand,
  init: initCommand,
  setup: setupCommand,
  doctor: doctorCommand,
  config: configCommand,
} as const
async function usage(name?: string): Promise<string> {
  const parent = { meta: { name: 'porteau' } }
  const rendered = await (name === 'backup'
    ? renderUsage(backupCommand, parent)
    : name === 'restore'
      ? renderUsage(restoreCommand, parent)
      : name === 'init'
        ? renderUsage(initCommand, parent)
        : name === 'setup'
          ? renderUsage(setupCommand, parent)
          : name === 'doctor'
            ? renderUsage(doctorCommand, parent)
            : name === 'config'
              ? renderUsage(configCommand, parent)
              : renderUsage(mainCommand))
  return `${rendered}\nGLOBAL OPTIONS\n  --json  JSONL output\n  --quiet  Essential output only\n  --verbose  Detailed output\n  --no-interactive  Never prompt\n  --yes  Approve setup or restore mutation`
}
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
export interface CliServices {
  loadConfig: typeof loadConfig
  runBackup: typeof runBackup
  runRestore: typeof runRestore
  collectDiagnostics: typeof collectDiagnostics
  executeInstallPlan: typeof executeInstallPlan
}
const defaultServices: CliServices = {
  loadConfig,
  runBackup,
  runRestore,
  collectDiagnostics,
  executeInstallPlan,
}
class UsageError extends Error {}
const globalBoolean = new Set(['--json', '--quiet', '--verbose', '--no-interactive', '--yes'])
interface ParsedCli {
  readonly flags: PresentationFlags
  readonly command?: keyof typeof commands
  readonly values: Record<string, string | boolean>
  readonly help: boolean
  readonly version: boolean
}
type PresentationFlags = ConstructorParameters<typeof Presentation>[0]
interface ParseContext {
  readonly flags: PresentationFlags
  command?: keyof typeof commands
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

function optionDefinitions(command: keyof typeof commands) {
  const definitions = commands[command].args as Record<
    string,
    { type?: string; alias?: string | string[] }
  >
  const options = new Map<string, { name: string; boolean: boolean }>()
  for (const [name, definition] of Object.entries(definitions ?? {})) {
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
  command: keyof typeof commands,
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
  let command: keyof typeof commands | undefined
  let help = false
  let version = false
  let commandStart = raw.length
  let literalCommand = false
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index]!
    if (token === '--') {
      const candidate = raw[index + 1]
      if (!candidate || !(candidate in commands))
        throw new UsageError(candidate ? `Unknown command: ${candidate}` : 'No command specified')
      command = candidate as keyof typeof commands
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
    if (!(token in commands)) throw new UsageError(`Unknown command: ${token}`)
    command = token as keyof typeof commands
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
const publicConfig = (config: PorteauConfig) => ({
  connection: {
    host: config.connection.host,
    port: config.connection.port,
    user: config.connection.user,
    tls: config.connection.tls,
    passwordConfigured: config.connection.password !== undefined,
  },
  tools: config.tools,
  backup: config.backup,
  restore: config.restore,
  include: config.include,
  exclude: config.exclude,
  objects: config.objects,
})
const yamlString = (value: string) => JSON.stringify(value)
const normalizeRequired = (value: string, label: string) => {
  const normalized = value.trim()
  if (!normalized) throw new UsageError(`${label} must not be blank`)
  return normalized
}
const normalizeList = (value: string | boolean, label: string) => {
  if (typeof value !== 'string') throw new UsageError(`${label} requires a value`)
  const values = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!values.length) throw new UsageError(`${label} requires at least one value`)
  return values
}
function initialYaml(host: string, port: number, user: string | undefined, databases: string[]) {
  return [
    '# Porteau configuration (passwords belong in PORTEAU_PASSWORD, never this file)',
    'connection:',
    `  host: ${yamlString(host)}`,
    `  port: ${port}`,
    ...(user ? [`  user: ${yamlString(user)}`] : []),
    'include:',
    '  databases:',
    ...databases.map((item) => `    - ${yamlString(item)}`),
    '',
  ].join('\n')
}

function restoreSummary(summary: RestoreConfirmation): string {
  return [
    `Restore ${summary.sourceDatabase} to ${summary.host}:${summary.port}/${summary.destinationDatabase}`,
    `Destination: ${summary.destinationExists ? 'exists' : 'will be created'} (${summary.destinationObjects} objects)`,
    `Destination policy: ${summary.destinationPolicy}`,
    `Overwrite policy: ${summary.overwritePolicy}`,
    `Binary log policy: ${summary.binlogPolicy}`,
  ].join('\n')
}

async function writeConfigAtomic(
  path: string,
  contents: string,
  signal: AbortSignal,
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let published = false
  try {
    signal.throwIfAborted()
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    signal.throwIfAborted()
    // Linking a fully-written sibling is atomic and refuses to replace a path
    // that appeared after the initial existence check.
    await link(temporary, path)
    published = true
    await rm(temporary)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    if (published) return
    throw error
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
      const text = await usage(name)
      controller.signal.throwIfAborted()
      const rendered = presentation.color ? text : stripVTControlCharacters(text)
      await presentation.success(name ?? 'porteau', rendered, { help: rendered })
      return controller.signal.aborted ? 130 : 0
    }
    const a = parsed.values
    if (name === 'config') {
      const config = await services.loadConfig({
        cwd,
        env,
        ...(a.config ? { configFile: resolve(cwd, String(a.config)) } : {}),
      })
      presentation.registerSecret(config.connection.password)
      controller.signal.throwIfAborted()
      await presentation.success(name, JSON.stringify(publicConfig(config), null, 2), {
        config: publicConfig(config),
      })
      return 0
    }
    if (name === 'doctor') {
      const result = await services.collectDiagnostics({
        ...(a.config ? { configFile: resolve(cwd, String(a.config)) } : {}),
        env,
        cwd,
        signal: controller.signal,
        diagnostics: { env, signal: controller.signal },
      })
      controller.signal.throwIfAborted()
      if (!result.ok) {
        await presentation.reportDiagnostics(name, formatDiagnostics(result).join('\n'), result)
        await presentation.failure(name, 'Diagnostics found blocking dependency issues.', 1)
        return 1
      }
      await presentation.success(name, formatDiagnostics(result).join('\n'), {
        diagnostics: result,
      })
      return 0
    }
    if (name === 'setup') {
      if (a.check && parsed.flags.yes)
        throw new UsageError('--check and --yes cannot be used together')
      const result = await services.collectDiagnostics({
        ...(a.config ? { configFile: resolve(cwd, String(a.config)) } : {}),
        env,
        cwd,
        signal: controller.signal,
        diagnostics: { env, signal: controller.signal },
      })
      controller.signal.throwIfAborted()
      if (a.check) {
        if (!result.ok) {
          await presentation.reportDiagnostics(name, formatDiagnostics(result).join('\n'), result)
          await presentation.failure(name, 'Diagnostics found blocking dependency issues.', 1)
          return 1
        }
        await presentation.success(name, formatDiagnostics(result).join('\n'), {
          diagnostics: result,
        })
        return 0
      }
      const plan = planUbuntuInstall(result, env)
      const planLines = renderInstallPlan(plan)
      await presentation.disclose(name, planLines.join('\n'), { lines: planLines, plan })
      controller.signal.throwIfAborted()
      if (!plan.supported || plan.blockers.length) throw new Error(renderInstallPlan(plan).at(-1))
      if (!plan.node && !plan.nativeTools) {
        await presentation.success(name, 'No changes required.')
        return 0
      }
      let approved = parsed.flags.yes
      if (!approved && presentation.interactive) {
        const answer = await prompts.confirm('Execute this installation plan?', controller.signal)
        if (controller.signal.aborted) throw Object.assign(new Error(), { name: 'AbortError' })
        if (answer === undefined || answer === false)
          throw Object.assign(new Error('Setup cancelled'), { name: 'AbortError' })
        approved = answer
      }
      if (!approved)
        throw new Error('Setup requires --yes before making changes; use porteau setup --check')
      controller.signal.throwIfAborted()
      await services.executeInstallPlan(plan, approvedInstall, undefined, controller.signal)
      controller.signal.throwIfAborted()
      await presentation.success(name, 'Setup completed.')
      return 0
    }
    if (name === 'init') {
      const output = resolve(cwd, String(a.output ?? 'porteau.config.yaml'))
      let host = a.host ? String(a.host) : undefined,
        user = a.user ? String(a.user) : undefined,
        databases = a.database ? normalizeList(a.database, '--database') : []
      if (presentation.interactive) {
        if (!host) {
          host = await prompts.text('Database host', controller.signal)
          controller.signal.throwIfAborted()
          if (host === undefined) throw Object.assign(new Error(), { name: 'AbortError' })
          host = normalizeRequired(host, 'Database host')
        }
        if (!user) {
          user = await prompts.text('Database user', controller.signal)
          controller.signal.throwIfAborted()
          if (user === undefined) throw Object.assign(new Error(), { name: 'AbortError' })
          user = normalizeRequired(user, 'Database user')
        }
        if (!databases.length) {
          const answer = await prompts.text(
            'Included databases (comma-separated)',
            controller.signal,
          )
          controller.signal.throwIfAborted()
          if (answer === undefined) throw Object.assign(new Error(), { name: 'AbortError' })
          databases = normalizeList(answer, 'Included databases')
        }
      }
      if (!host) host = 'localhost'
      else host = normalizeRequired(host, '--host')
      if (user) user = normalizeRequired(user, '--user')
      if (!databases.length) throw new UsageError('--database requires at least one value')
      const port = a.port ? Number(a.port) : 3306
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new UsageError('--port must be an integer from 1 to 65535')
      validateConfig({
        ...defaultConfig,
        connection: { ...defaultConfig.connection, host, port, ...(user ? { user } : {}) },
        include: { databases },
      })
      controller.signal.throwIfAborted()
      try {
        await writeConfigAtomic(output, initialYaml(host, port, user, databases), controller.signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error(`Refusing to overwrite ${output}`)
        throw error
      }
      await presentation.success(name, `Created ${output}`, { path: output })
      return 0
    }
    if (name === 'restore') {
      const configFile = a.config ? resolve(cwd, String(a.config)) : undefined
      const restoreFlags = {
        ...(a['destination-policy'] ? { destinationPolicy: String(a['destination-policy']) } : {}),
        ...(a['overwrite-policy'] ? { overwritePolicy: String(a['overwrite-policy']) } : {}),
        ...(a['binlog-policy'] ? { binlogPolicy: String(a['binlog-policy']) } : {}),
      }
      let config = await services.loadConfig({
        cwd,
        env,
        ...(configFile ? { configFile } : {}),
        flags: {
          ...(a.user ? { connection: { user: String(a.user) } } : {}),
          ...(Object.keys(restoreFlags).length ? { restore: restoreFlags } : {}),
        },
      })
      controller.signal.throwIfAborted()
      presentation.registerSecret(config.connection.password)
      let user = config.connection.user,
        password = config.connection.password,
        artifact = a.artifact ? String(a.artifact) : undefined,
        sourceDatabase = a['source-database'] ? String(a['source-database']) : undefined,
        destinationDatabase = a['destination-database']
          ? String(a['destination-database'])
          : undefined
      if (user !== undefined) user = normalizeRequired(user, 'Destination database user')
      if (presentation.interactive) {
        if (!user) {
          user = await prompts.text('Destination database user', controller.signal)
          controller.signal.throwIfAborted()
          if (user === undefined) throw Object.assign(new Error(), { name: 'AbortError' })
          user = normalizeRequired(user, 'Destination database user')
        }
        if (password === undefined) {
          password = await prompts.password('Destination database password', controller.signal)
          controller.signal.throwIfAborted()
          if (password === undefined) throw Object.assign(new Error(), { name: 'AbortError' })
          presentation.registerSecret(password)
        }
        if (!artifact) {
          artifact = await prompts.text('Backup artifact directory', controller.signal)
          controller.signal.throwIfAborted()
          if (artifact === undefined) throw Object.assign(new Error(), { name: 'AbortError' })
        }
        if (!sourceDatabase) {
          sourceDatabase = await prompts.text('Source database in artifact', controller.signal)
          controller.signal.throwIfAborted()
          if (sourceDatabase === undefined) throw Object.assign(new Error(), { name: 'AbortError' })
        }
        if (!destinationDatabase) {
          destinationDatabase = await prompts.text('Destination database', controller.signal)
          controller.signal.throwIfAborted()
          if (destinationDatabase === undefined)
            throw Object.assign(new Error(), { name: 'AbortError' })
        }
      }
      if (!user || password === undefined || !artifact || !sourceDatabase || !destinationDatabase)
        throw new Error(
          'Restore requires an artifact, source database, destination database, database user, and password',
        )
      artifact = normalizeRequired(artifact, 'Backup artifact directory')
      sourceDatabase = normalizeRequired(sourceDatabase, 'Source database')
      destinationDatabase = normalizeRequired(destinationDatabase, 'Destination database')
      config = await services.loadConfig({
        cwd,
        env,
        ...(configFile ? { configFile } : {}),
        flags: {
          connection: { user, password },
          ...(Object.keys(restoreFlags).length ? { restore: restoreFlags } : {}),
        },
      })
      controller.signal.throwIfAborted()
      presentation.registerSecret(config.connection.password)
      const result = await services.runRestore({
        config,
        request: {
          artifactPath: resolve(cwd, artifact),
          sourceDatabase,
          destinationDatabase,
          destinationPolicy: config.restore.destinationPolicy,
          overwritePolicy: config.restore.overwritePolicy,
          binlogPolicy: config.restore.binlogPolicy,
        },
        configDirectory: configFile ? dirname(configFile) : cwd,
        signal: controller.signal,
        environment: env,
        onEvent: (event) => presentation.progress(name, event),
        async confirm(summary) {
          const rendered = restoreSummary(summary)
          await presentation.disclose(name, rendered, { summary })
          controller.signal.throwIfAborted()
          if (parsed.flags.yes) return true
          if (!presentation.interactive)
            throw new Error('Restore requires --yes in non-interactive mode')
          const answer = await prompts.confirm('Apply this restore plan?', controller.signal)
          controller.signal.throwIfAborted()
          if (answer !== true)
            throw Object.assign(new Error('Restore cancelled before destination mutation'), {
              name: 'AbortError',
            })
          return true
        },
      })
      controller.signal.throwIfAborted()
      await presentation.success(name, `Restore completed: ${result.destinationDatabase}`, {
        destinationDatabase: result.destinationDatabase,
        warnings: result.warnings,
      })
      return 0
    }
    const configFile = a.config ? resolve(cwd, String(a.config)) : undefined
    let config = await services.loadConfig({
      cwd,
      env,
      ...(configFile ? { configFile } : {}),
      flags: {
        ...(a.user ? { connection: { user: String(a.user) } } : {}),
        ...(a.database ? { include: { databases: normalizeList(a.database, '--database') } } : {}),
      },
    })
    controller.signal.throwIfAborted()
    presentation.registerSecret(config.connection.password)
    let user = config.connection.user,
      password = config.connection.password,
      databases = config.include.databases
    if (user !== undefined) user = normalizeRequired(user, 'Database user')
    if (presentation.interactive) {
      if (!user) {
        user = await prompts.text('Database user', controller.signal)
        controller.signal.throwIfAborted()
        if (user === undefined) throw Object.assign(new Error(), { name: 'AbortError' })
        user = normalizeRequired(user, 'Database user')
      }
      if (password === undefined) {
        password = await prompts.password('Database password', controller.signal)
        controller.signal.throwIfAborted()
        if (password === undefined) throw Object.assign(new Error(), { name: 'AbortError' })
        presentation.registerSecret(password)
      }
      if (!databases.length) {
        const answer = await prompts.text('Included databases (comma-separated)', controller.signal)
        controller.signal.throwIfAborted()
        if (answer === undefined) throw Object.assign(new Error(), { name: 'AbortError' })
        databases = normalizeList(answer, 'Included databases')
      }
    }
    if (!user || password === undefined || !databases.length)
      throw new Error(
        'Backup requires a database user, password, and at least one included database',
      )
    config = await services.loadConfig({
      cwd,
      env,
      ...(configFile ? { configFile } : {}),
      flags: { connection: { user, password }, include: { databases } },
    })
    controller.signal.throwIfAborted()
    presentation.registerSecret(config.connection.password)
    const result = await services.runBackup({
      config,
      configDirectory: configFile ? dirname(configFile) : cwd,
      ...(a.output ? { outputDirectory: String(a.output) } : {}),
      signal: controller.signal,
      environment: env,
      onEvent: (event) => presentation.progress(name, event),
    })
    controller.signal.throwIfAborted()
    await presentation.success(name, `Backup completed: ${result.outputDirectory}`, {
      outputDirectory: result.outputDirectory,
      warnings: result.warnings,
    })
    return 0
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
