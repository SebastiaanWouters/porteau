import { randomUUID } from 'node:crypto'
import { link, open, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { defaultConfig, validateConfig } from '../core/config.js'
import { normalizeList, normalizeRequired, promptOrAbort, UsageError } from './shared.js'
import { defineCommand, type CommandContext } from './types.js'

function catalogKey(name: string): string {
  const key = name.replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return key || 'database'
}

function initialYaml(host: string, port: number, user: string | undefined, databases: string[]) {
  const yamlString = (value: string) => JSON.stringify(value)
  const entries = databases.map((name) => ({ key: catalogKey(name), name }))
  const unique = new Map<string, string>()
  for (const entry of entries) {
    let key = entry.key
    let suffix = 2
    while (unique.has(key)) {
      key = `${entry.key}-${suffix}`
      suffix += 1
    }
    unique.set(key, entry.name)
  }
  const databaseKeys = [...unique.keys()]
  const defaultDatabase = databaseKeys[0]!
  return [
    '# Porteau configuration (passwords belong in PORTEAU_PASSWORD, never this file)',
    'artifacts:',
    '  directory: "./backups"',
    'defaults:',
    '  server: local',
    `  database: ${yamlString(defaultDatabase)}`,
    'servers:',
    '  local:',
    `    host: ${yamlString(host)}`,
    `    port: ${port}`,
    ...(user ? [`    user: ${yamlString(user)}`] : []),
    'databases:',
    ...[...unique.entries()].flatMap(([key, name]) => [
      `  ${key}:`,
      `    name: ${yamlString(name)}`,
    ]),
    '',
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

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Create a Porteau configuration',
  },
  args: {
    output: { type: 'string', alias: 'o', description: 'Configuration file to create' },
    host: { type: 'string', description: 'Database host' },
    port: { type: 'string', description: 'Database port' },
    user: { type: 'string', description: 'Database user' },
    database: { type: 'string', description: 'Comma-separated included databases' },
  },
  async run(context: CommandContext) {
    const { values, cwd, presentation, prompts, signal } = context
    const output = resolve(cwd, String(values.output ?? 'porteau.config.yaml'))
    let host = values.host ? String(values.host) : undefined,
      user = values.user ? String(values.user) : undefined,
      databases = values.database ? normalizeList(values.database, '--database') : []
    if (presentation.interactive) {
      if (!host)
        host = await promptOrAbort(
          (abortSignal) => prompts.text('Database host', abortSignal),
          signal,
          (value) => normalizeRequired(value, 'Database host'),
        )
      if (!user)
        user = await promptOrAbort(
          (abortSignal) => prompts.text('Database user', abortSignal),
          signal,
          (value) => normalizeRequired(value, 'Database user'),
        )
      if (!databases.length)
        databases = normalizeList(
          await promptOrAbort(
            (abortSignal) => prompts.text('Included databases (comma-separated)', abortSignal),
            signal,
          ),
          'Included databases',
        )
    }
    if (!host) host = 'localhost'
    else host = normalizeRequired(host, '--host')
    if (user) user = normalizeRequired(user, '--user')
    if (!databases.length) throw new UsageError('--database requires at least one value')
    const port = values.port ? Number(values.port) : 3306
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new UsageError('--port must be an integer from 1 to 65535')
    const registry = Object.fromEntries(databases.map((name) => [catalogKey(name), { name }]))
    validateConfig({
      ...defaultConfig,
      defaults: { server: 'local', database: catalogKey(databases[0]!) },
      servers: {
        local: {
          ...defaultConfig.servers.local,
          host,
          port,
          ...(user ? { user } : {}),
        },
      },
      databases: registry,
    })
    signal.throwIfAborted()
    try {
      await writeConfigAtomic(output, initialYaml(host, port, user, databases), signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(`Refusing to overwrite ${output}`)
      throw error
    }
    await presentation.success('init', `Created ${output}`, { path: output })
    return 0
  },
})
