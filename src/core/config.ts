import { extname } from 'node:path'
import { loadConfig as loadC12Config } from 'c12'
import * as v from 'valibot'

const tlsModes = ['disabled', 'preferred', 'required', 'verify-ca', 'verify-identity'] as const

const serverSchema = v.strictObject({
  host: v.string(),
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535)), 3306),
  user: v.optional(v.string()),
  password: v.optional(v.string()),
  tls: v.optional(v.picklist(tlsModes), 'preferred'),
})

const databaseSchema = v.strictObject({
  name: v.string(),
  user: v.optional(v.string()),
})

const configSchema = v.pipe(
  v.strictObject({
    artifacts: v.strictObject({
      directory: v.string(),
    }),
    defaults: v.strictObject({
      server: v.string(),
      database: v.string(),
    }),
    servers: v.record(v.string(), serverSchema),
    databases: v.record(v.string(), databaseSchema),
    tools: v.strictObject({
      mydumper: v.optional(v.string()),
      myloader: v.optional(v.string()),
    }),
    backup: v.strictObject({
      profile: v.picklist(['production', 'replica', 'expert']),
      threads: v.pipe(v.number(), v.integer(), v.minValue(2)),
      compression: v.picklist(['none', 'gzip', 'zstd']),
      consistency: v.strictObject({
        mode: v.picklist(['auto', 'safe-no-lock', 'no-lock']),
        protectDdl: v.boolean(),
      }),
      throttle: v.strictObject({
        enabled: v.boolean(),
        threshold: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
      }),
    }),
    restore: v.strictObject({
      threads: v.pipe(v.number(), v.integer(), v.minValue(2)),
      destinationPolicy: v.picklist(['require-empty', 'allow-existing']),
      overwritePolicy: v.picklist(['reject', 'drop', 'truncate', 'delete']),
      binlogPolicy: v.picklist(['disable', 'enable']),
    }),
    exclude: v.strictObject({
      tables: v.array(v.string()),
      data: v.array(v.string()),
    }),
    objects: v.strictObject({
      triggers: v.boolean(),
      views: v.boolean(),
    }),
  }),
  v.check(({ backup }) => {
    const { mode, protectDdl } = backup.consistency
    if (mode === 'auto') return protectDdl
    if (mode === 'no-lock') return !protectDdl
    return backup.profile === 'expert' && !protectDdl
  }, 'The selected profile has an unsafe or unqualified consistency configuration'),
  v.check(
    ({ defaults, servers }) => Object.hasOwn(servers, defaults.server),
    'defaults.server must name an entry in servers',
  ),
  v.check(
    ({ defaults, databases }) => Object.hasOwn(databases, defaults.database),
    'defaults.database must name an entry in databases',
  ),
  v.check(({ servers }) => {
    for (const server of Object.values(servers)) {
      if (server.tls === 'verify-ca' || server.tls === 'verify-identity') return false
    }
    return true
  }, 'CA-verified TLS requires certificate configuration that is not available yet'),
)

export type PorteauConfig = v.InferOutput<typeof configSchema>
export type ConfigInput = v.InferInput<typeof configSchema>
export type ServerConfig = PorteauConfig['servers'][string]
export type DatabaseConfig = PorteauConfig['databases'][string]

export const defaultConfig = {
  artifacts: { directory: './backups' },
  defaults: { server: 'local', database: 'app' },
  servers: {
    local: { host: 'localhost', port: 3306, tls: 'preferred' },
  },
  databases: {
    app: { name: 'app' },
  },
  tools: {},
  backup: {
    profile: 'production',
    threads: 4,
    compression: 'zstd',
    consistency: {
      mode: 'auto',
      protectDdl: true,
    },
    throttle: { enabled: true, threshold: null },
  },
  restore: {
    threads: 4,
    destinationPolicy: 'require-empty',
    overwritePolicy: 'reject',
    binlogPolicy: 'disable',
  },
  exclude: { tables: [], data: [] },
  objects: { triggers: true, views: true },
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
  'defaults.server must name an entry in servers',
  'defaults.database must name an entry in databases',
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

export function applyConfigOverlay(
  base: PorteauConfig,
  overlay: Record<string, unknown>,
): PorteauConfig {
  return validateConfig(mergeConfig(overlay, base as unknown as ConfigRecord))
}

export function defaultServer(config: PorteauConfig): ServerConfig {
  return config.servers[config.defaults.server]!
}

export function overlayDefaultServer(
  config: PorteauConfig,
  fields: Partial<ServerConfig>,
): PorteauConfig {
  return applyConfigOverlay(config, {
    servers: { [config.defaults.server]: fields },
  })
}

/** Overlay PORTEAU_HOST/PORT/USER/PASSWORD onto a named server (selected at runtime). */
export function overlayServerFromEnvironment(
  config: PorteauConfig,
  serverKey: string,
  env: NodeJS.ProcessEnv,
): PorteauConfig {
  const fields = connectionFieldsFromEnvironment(env)
  if (Object.keys(fields).length === 0) return config
  if (config.servers[serverKey] === undefined) {
    const known = Object.keys(config.servers).sort().join(', ')
    throw new Error(`Unknown server "${serverKey}". Known servers: ${known || '(none)'}`)
  }
  return applyConfigOverlay(config, { servers: { [serverKey]: fields } })
}

function connectionFieldsFromEnvironment(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if (env.PORTEAU_HOST !== undefined) fields.host = env.PORTEAU_HOST
  if (env.PORTEAU_PORT !== undefined) fields.port = Number(env.PORTEAU_PORT)
  if (env.PORTEAU_USER !== undefined) fields.user = env.PORTEAU_USER
  if (env.PORTEAU_PASSWORD !== undefined) fields.password = env.PORTEAU_PASSWORD
  return fields
}

function toolsFromEnvironment(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const tools: Record<string, unknown> = {}
  if (env.PORTEAU_MYDUMPER !== undefined) tools.mydumper = env.PORTEAU_MYDUMPER
  if (env.PORTEAU_MYLOADER !== undefined) tools.myloader = env.PORTEAU_MYLOADER
  return tools
}

function applyDefaultServerFields(
  config: ConfigRecord,
  fields: Record<string, unknown>,
): ConfigRecord {
  if (Object.keys(fields).length === 0) return config
  const defaults = isConfigRecord(config.defaults) ? config.defaults : undefined
  const serverKey = typeof defaults?.server === 'string' ? defaults.server : undefined
  if (!serverKey) return config
  return mergeConfig({ servers: { [serverKey]: fields } }, config)
}

function rejectLegacyKeys(input: ConfigRecord): void {
  if (Object.hasOwn(input, 'connection')) {
    throw new Error(
      'Invalid Porteau configuration: connection is unsupported; use servers with defaults.server',
    )
  }
  if (Object.hasOwn(input, 'include')) {
    throw new Error(
      'Invalid Porteau configuration: include is unsupported; use databases with defaults.database',
    )
  }
  if (isConfigRecord(input.backup) && Object.hasOwn(input.backup, 'directory')) {
    throw new Error(
      'Invalid Porteau configuration: backup.directory is unsupported; use artifacts.directory',
    )
  }
  if (isConfigRecord(input.exclude) && Object.hasOwn(input.exclude, 'schema')) {
    throw new Error(
      'Invalid Porteau configuration: exclude.schema is unsupported because data-only backups cannot be restored safely; use exclude.tables to omit the object or exclude.data to keep its schema only',
    )
  }
}

export function validateConfig(input: unknown): PorteauConfig {
  if (isConfigRecord(input)) rejectLegacyKeys(input)
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

  const env = options.env ?? process.env
  const toolOverlay = toolsFromEnvironment(env)
  let loaded
  try {
    loaded = await loadC12Config<Record<string, unknown>>({
      name: 'porteau',
      configFile: options.configFile ?? 'porteau.config.yaml',
      configFileRequired: options.configFile !== undefined,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      defaultConfig,
      overrides: Object.keys(toolOverlay).length > 0 ? { tools: toolOverlay } : {},
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

  const withEnvConnection = applyDefaultServerFields(
    loaded.config,
    connectionFieldsFromEnvironment(env),
  )
  return validateConfig(mergeConfig(options.flags ?? {}, withEnvConnection))
}
