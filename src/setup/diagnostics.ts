import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  inspectToolCapabilities,
  inspectToolVersion,
  isSupportedToolVersion,
  resolveToolInfo,
  ToolResolutionError,
  type ResolveToolOptions,
  type ToolName,
  type ToolResolutionSource,
} from '../core/tools.js'
import { compatibilityManifest } from './manifest.js'
import { minimumNodeVersion, supportedTargetDescription } from './policy.js'

const execFileAsync = promisify(execFile)
export { minimumNodeVersion } from './policy.js'

export type DiagnosticStatus = 'ok' | 'warning' | 'error'

export interface SystemDiagnostic {
  readonly status: DiagnosticStatus
  readonly platform: NodeJS.Platform
  readonly id?: string
  readonly name: string
  readonly version?: string
  readonly codename?: string
  readonly architecture: string
  readonly supported: boolean
  readonly correction?: string
}

export interface NodeDiagnostic {
  readonly status: 'ok' | 'error'
  readonly version: string
  readonly minimumVersion: string
  readonly correction?: string
}

export interface ToolDiagnostic {
  readonly name: ToolName
  readonly status: 'ok' | 'error'
  readonly path?: string
  readonly source?: ToolResolutionSource
  readonly version?: string
  readonly correction?: string
}

export interface ToolPairDiagnostic {
  readonly status: 'ok' | 'error'
  readonly correction?: string
}

export interface DiagnosticsResult {
  readonly system: SystemDiagnostic
  readonly node: NodeDiagnostic
  readonly tools: Readonly<Record<ToolName, ToolDiagnostic>>
  readonly toolPair: ToolPairDiagnostic
  readonly ok: boolean
}

export interface DiagnosticsOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly platform?: NodeJS.Platform
  readonly architecture?: string
  readonly readDebianArchitecture?: () => Promise<string>
  readonly nodeVersion?: string
  readonly osReleasePath?: string
  readonly configPaths?: Partial<Record<ToolName, string>>
  readonly readTextFile?: (path: string) => Promise<string>
  readonly resolve?: typeof resolveToolInfo
  readonly inspect?: typeof inspectToolVersion
  readonly inspectCapabilities?: typeof inspectToolCapabilities
  readonly signal?: AbortSignal
}

function parseOsRelease(contents: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line)
    if (!match?.[1] || match[2] === undefined) continue
    const raw = match[2]
    values[match[1]] =
      raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replace(/\\(["\\$`])/gu, '$1')
        : raw
  }
  return values
}

function debianArchitecture(architecture: string): string {
  if (architecture === 'x64') return 'amd64'
  return architecture
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(value)
    return match ? match.slice(1).map(Number) : undefined
  }
  const actualParts = parse(actual)
  const minimumParts = parse(minimum)
  if (!actualParts || !minimumParts) return false
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index]! > minimumParts[index]!) return true
    if (actualParts[index]! < minimumParts[index]!) return false
  }
  return true
}

async function diagnoseSystem(options: DiagnosticsOptions): Promise<SystemDiagnostic> {
  options.signal?.throwIfAborted()
  const platform = options.platform ?? process.platform
  let architecture = debianArchitecture(options.architecture ?? process.arch)
  if (platform === 'linux' && options.architecture === undefined) {
    try {
      architecture = (
        options.readDebianArchitecture
          ? await options.readDebianArchitecture()
          : (
              await execFileAsync('dpkg', ['--print-architecture'], {
                encoding: 'utf8',
                ...(options.signal ? { signal: options.signal } : {}),
              })
            ).stdout
      ).trim()
    } catch {
      options.signal?.throwIfAborted()
      architecture = 'unknown'
    }
  }
  let release: Record<string, string> = {}
  if (platform === 'linux') {
    try {
      const path = options.osReleasePath ?? '/etc/os-release'
      const contents = options.readTextFile
        ? await options.readTextFile(path)
        : await readFile(path, 'utf8')
      release = parseOsRelease(contents)
    } catch {
      options.signal?.throwIfAborted()
      // Missing release metadata is reported as unsupported rather than failing diagnostics.
    }
  }
  const id = release.ID
  const version = release.VERSION_ID
  const codename = release.VERSION_CODENAME
  const supported = compatibilityManifest.assets.some(
    (asset) =>
      platform === 'linux' &&
      id === 'ubuntu' &&
      asset.ubuntu === version &&
      asset.codename === codename &&
      asset.architecture === architecture,
  )
  return {
    status: supported ? 'ok' : 'warning',
    platform,
    ...(id ? { id } : {}),
    name: release.PRETTY_NAME ?? platform,
    ...(version ? { version } : {}),
    ...(codename ? { codename } : {}),
    architecture,
    supported,
    ...(!supported
      ? {
          correction: `Automatic setup supports ${supportedTargetDescription}; install mydumper and myloader manually on this system.`,
        }
      : {}),
  }
}

async function diagnoseTool(name: ToolName, options: DiagnosticsOptions): Promise<ToolDiagnostic> {
  options.signal?.throwIfAborted()
  const environment = options.env ?? process.env
  const resolutionOptions: ResolveToolOptions = {
    env: environment,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.configPaths?.[name] ? { configPath: options.configPaths[name] } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }
  let resolved
  try {
    resolved = await (options.resolve ?? resolveToolInfo)(name, resolutionOptions)
  } catch (error) {
    options.signal?.throwIfAborted()
    const resolutionError = error instanceof ToolResolutionError ? error : undefined
    return {
      name,
      status: 'error',
      ...(resolutionError?.path ? { path: resolutionError.path } : {}),
      ...(resolutionError ? { source: resolutionError.source } : {}),
      correction: resolutionError
        ? resolutionError.reason === 'not-executable'
          ? `Make the configured ${name} executable or install supported version ${compatibilityManifest.engine.version}.`
          : `Install supported ${name} version ${compatibilityManifest.engine.version} or configure its path explicitly.`
        : `Unable to resolve ${name}; verify its configured path and permissions.`,
    }
  }

  const inspectionEnvironment = { ...environment }
  delete inspectionEnvironment.PORTEAU_PASSWORD
  try {
    const inspected = await (options.inspect ?? inspectToolVersion)(
      name,
      resolved.path,
      inspectionEnvironment,
      options.signal,
    )
    const supported = isSupportedToolVersion(name, inspected.version)
    if (!supported)
      return {
        name,
        status: 'error',
        path: resolved.path,
        source: resolved.source,
        version: inspected.version,
        correction: `Install ${name} version ${compatibilityManifest.engine.tools[name].minimumVersion} or newer.`,
      }
    try {
      await (options.inspectCapabilities ?? inspectToolCapabilities)(
        name,
        resolved.path,
        inspectionEnvironment,
        options.signal,
      )
    } catch {
      options.signal?.throwIfAborted()
      return {
        name,
        status: 'error',
        path: resolved.path,
        source: resolved.source,
        version: inspected.version,
        correction: `${name} lacks required machine-log support; install a compatible release.`,
      }
    }
    return {
      name,
      status: 'ok',
      path: resolved.path,
      source: resolved.source,
      version: inspected.version,
    }
  } catch {
    options.signal?.throwIfAborted()
    return {
      name,
      status: 'error',
      path: resolved.path,
      source: resolved.source,
      correction: `Unable to inspect ${name} version; reinstall it from the supported package.`,
    }
  }
}

export async function runDiagnostics(options: DiagnosticsOptions = {}): Promise<DiagnosticsResult> {
  options.signal?.throwIfAborted()
  const nodeVersion = (options.nodeVersion ?? process.version).replace(/^v/u, '')
  const nodeSupported = versionAtLeast(nodeVersion, minimumNodeVersion)
  const [system, mydumper, myloader] = await Promise.all([
    diagnoseSystem(options),
    diagnoseTool('mydumper', options),
    diagnoseTool('myloader', options),
  ])
  options.signal?.throwIfAborted()
  const versionsMatch =
    mydumper.status === 'ok' && myloader.status === 'ok' && mydumper.version === myloader.version
  const toolPair: ToolPairDiagnostic = versionsMatch
    ? { status: 'ok' }
    : {
        status: 'error',
        correction:
          mydumper.version && myloader.version && mydumper.version !== myloader.version
            ? `Install matching mydumper and myloader versions; found ${mydumper.version} and ${myloader.version}.`
            : 'Resolve both mydumper and myloader checks before running backups or restores.',
      }
  const node: NodeDiagnostic = nodeSupported
    ? { status: 'ok', version: nodeVersion, minimumVersion: minimumNodeVersion }
    : {
        status: 'error',
        version: nodeVersion,
        minimumVersion: minimumNodeVersion,
        correction: `Install Node.js ${minimumNodeVersion} or newer (Node.js 24 LTS is recommended).`,
      }

  return {
    system,
    node,
    tools: { mydumper, myloader },
    toolPair,
    ok: node.status === 'ok' && toolPair.status === 'ok',
  }
}
