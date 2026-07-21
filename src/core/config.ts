import { extname } from 'node:path'
import { loadConfig as loadC12Config } from 'c12'
import * as v from 'valibot'

const tlsModes = ['disabled', 'preferred', 'required', 'verify-ca', 'verify-identity'] as const

const configSchema = v.pipe(
  v.strictObject({
    connection: v.strictObject({
      host: v.string(),
      port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535)),
      user: v.optional(v.string()),
      password: v.optional(v.string()),
      tls: v.picklist(tlsModes),
    }),
    tools: v.strictObject({
      mydumper: v.optional(v.string()),
      myloader: v.optional(v.string()),
    }),
    backup: v.strictObject({
      directory: v.string(),
      profile: v.picklist(['production', 'replica', 'expert']),
      threads: v.pipe(v.number(), v.integer(), v.minValue(2)),
      maxThreadsPerTable: v.pipe(v.number(), v.integer(), v.minValue(1)),
      compression: v.picklist(['none', 'gzip', 'zstd']),
      consistency: v.strictObject({
        mode: v.picklist(['auto', 'safe-no-lock']),
        requireInnoDB: v.boolean(),
        protectDdl: v.boolean(),
        startupLockTimeoutSeconds: v.pipe(v.number(), v.minValue(1)),
        lockRetries: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
      throttle: v.strictObject({
        enabled: v.boolean(),
        variable: v.literal('Threads_running'),
        threshold: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
      }),
    }),
    restore: v.strictObject({
      threads: v.pipe(v.number(), v.integer(), v.minValue(2)),
      destinationPolicy: v.picklist(['require-empty', 'allow-existing']),
      overwritePolicy: v.picklist(['reject', 'drop', 'truncate', 'delete']),
      binlogPolicy: v.picklist(['disable', 'enable']),
      verifyChecksums: v.picklist(['off', 'warn', 'required']),
      deferIndexes: v.picklist(['off', 'per-table', 'all']),
    }),
    include: v.strictObject({ databases: v.array(v.string()) }),
    exclude: v.strictObject({
      schema: v.array(v.string()),
      data: v.array(v.string()),
    }),
    objects: v.strictObject({
      triggers: v.boolean(),
      views: v.boolean(),
      routines: v.boolean(),
      events: v.boolean(),
    }),
  }),
  v.check(
    ({ backup }) =>
      backup.profile === 'expert'
        ? backup.consistency.requireInnoDB &&
          (backup.consistency.mode === 'auto' || !backup.consistency.protectDdl)
        : backup.consistency.mode === 'auto' &&
          backup.consistency.requireInnoDB &&
          backup.consistency.protectDdl,
    'The selected profile has an unsafe or unqualified consistency configuration',
  ),
  v.check(
    ({ connection }) => !['verify-ca', 'verify-identity'].includes(connection.tls),
    'CA-verified TLS requires certificate configuration that is not available yet',
  ),
)

export type PorteauConfig = v.InferOutput<typeof configSchema>
export type ConfigInput = v.InferInput<typeof configSchema>

export const defaultConfig = {
  connection: { host: 'localhost', port: 3306, tls: 'preferred' },
  tools: {},
  backup: {
    directory: './backups/{{date}}',
    profile: 'production',
    threads: 4,
    maxThreadsPerTable: 4,
    compression: 'zstd',
    consistency: {
      mode: 'auto',
      requireInnoDB: true,
      protectDdl: true,
      startupLockTimeoutSeconds: 10,
      lockRetries: 0,
    },
    throttle: { enabled: true, variable: 'Threads_running', threshold: null },
  },
  restore: {
    threads: 4,
    destinationPolicy: 'require-empty',
    overwritePolicy: 'reject',
    binlogPolicy: 'disable',
    verifyChecksums: 'warn',
    deferIndexes: 'per-table',
  },
  include: { databases: [] },
  exclude: { schema: [], data: [] },
  objects: { triggers: true, views: true, routines: false, events: false },
} as const satisfies ConfigInput

export interface LoadConfigOptions {
  readonly cwd?: string
  readonly configFile?: string
  readonly flags?: Record<string, unknown>
  readonly env?: NodeJS.ProcessEnv
}

type ConfigRecord = Record<string, unknown>
const safeValidationMessages = new Set([
  'The selected profile has an unsafe or unqualified consistency configuration',
  'CA-verified TLS requires certificate configuration that is not available yet',
])

function isConfigRecord(value: unknown): value is ConfigRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sanitizedIssueMessage(issue: v.BaseIssue<unknown>): string {
  if (safeValidationMessages.has(issue.message)) return issue.message
  if (issue.type === 'strict_object') return 'Configuration contains an unknown key'
  const path = issue.path?.map((item) => String(item.key)).join('.')
  return path ? `Invalid value at ${path}` : 'Invalid configuration value'
}

function mergeValue(higher: unknown, lower: unknown): unknown {
  if (higher === undefined) return lower
  if (Array.isArray(higher)) return [...higher]
  if (!isConfigRecord(higher) || !isConfigRecord(lower)) return higher

  const merged: ConfigRecord = { ...lower }
  for (const [key, value] of Object.entries(higher)) {
    if (key !== '__proto__' && key !== 'constructor') {
      merged[key] = mergeValue(value, lower[key])
    }
  }
  return merged
}

function mergeConfig(...sources: Array<ConfigRecord | null | undefined>): ConfigRecord {
  return sources.reduceRight<ConfigRecord>(
    (merged, source) => mergeValue(source ?? {}, merged) as ConfigRecord,
    {},
  )
}

function configFromEnvironment(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  const connection: Record<string, unknown> = {}
  const tools: Record<string, unknown> = {}

  if (env.PORTEAU_HOST !== undefined) connection.host = env.PORTEAU_HOST
  if (env.PORTEAU_PORT !== undefined) connection.port = Number(env.PORTEAU_PORT)
  if (env.PORTEAU_USER !== undefined) connection.user = env.PORTEAU_USER
  if (env.PORTEAU_PASSWORD !== undefined) connection.password = env.PORTEAU_PASSWORD
  if (env.PORTEAU_MYDUMPER !== undefined) tools.mydumper = env.PORTEAU_MYDUMPER
  if (env.PORTEAU_MYLOADER !== undefined) tools.myloader = env.PORTEAU_MYLOADER
  if (Object.keys(connection).length > 0) config.connection = connection
  if (Object.keys(tools).length > 0) config.tools = tools

  return config
}

export function validateConfig(input: unknown): PorteauConfig {
  try {
    return v.parse(configSchema, input)
  } catch (error) {
    if (v.isValiError(error)) {
      const messages = [...new Set(error.issues.map(sanitizedIssueMessage))]
      throw new Error(`Invalid Porteau configuration: ${messages.join('; ')}`)
    }
    throw error
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<PorteauConfig> {
  if (options.configFile && !['.yaml', '.yml'].includes(extname(options.configFile))) {
    throw new Error('Porteau configuration files must use the .yaml or .yml extension')
  }

  const environment = configFromEnvironment(options.env ?? process.env)
  const overrides = mergeConfig(options.flags ?? {}, environment)
  let loaded
  try {
    loaded = await loadC12Config<Record<string, unknown>>({
      name: 'porteau',
      configFile: options.configFile ?? 'porteau.config.yaml',
      configFileRequired: options.configFile !== undefined,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      defaultConfig,
      overrides,
      rcFile: false,
      globalRc: false,
      packageJson: false,
      envName: false,
      extend: false,
      giget: false,
      merger: mergeConfig,
    })
  } catch {
    throw new Error('Unable to load Porteau configuration')
  }

  return validateConfig(loaded.config)
}
