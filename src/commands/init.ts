import { randomUUID } from 'node:crypto'
import { link, open, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { defaultConfig, validateConfig } from '../core/config.js'
import { abortError, normalizeList, normalizeRequired, UsageError } from './shared.js'
import { defineCommand, type CommandContext } from './types.js'

function initialYaml(host: string, port: number, user: string | undefined, databases: string[]) {
  const yamlString = (value: string) => JSON.stringify(value)
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
      if (!host) {
        host = await prompts.text('Database host', signal)
        signal.throwIfAborted()
        if (host === undefined) throw abortError()
        host = normalizeRequired(host, 'Database host')
      }
      if (!user) {
        user = await prompts.text('Database user', signal)
        signal.throwIfAborted()
        if (user === undefined) throw abortError()
        user = normalizeRequired(user, 'Database user')
      }
      if (!databases.length) {
        const answer = await prompts.text('Included databases (comma-separated)', signal)
        signal.throwIfAborted()
        if (answer === undefined) throw abortError()
        databases = normalizeList(answer, 'Included databases')
      }
    }
    if (!host) host = 'localhost'
    else host = normalizeRequired(host, '--host')
    if (user) user = normalizeRequired(user, '--user')
    if (!databases.length) throw new UsageError('--database requires at least one value')
    const port = values.port ? Number(values.port) : 3306
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new UsageError('--port must be an integer from 1 to 65535')
    validateConfig({
      ...defaultConfig,
      connection: { ...defaultConfig.connection, host, port, ...(user ? { user } : {}) },
      include: { databases },
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
