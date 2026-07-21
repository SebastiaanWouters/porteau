import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { compatibilityManifest } from '../setup/manifest.js'

const execFileAsync = promisify(execFile)

export type ToolName = 'mydumper' | 'myloader'

export interface ResolveToolOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly configPath?: string
  readonly cwd?: string
}

export interface InspectedTool {
  readonly name: ToolName
  readonly path: string
  readonly version: string
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function resolveTool(
  name: ToolName,
  options: ResolveToolOptions = {},
): Promise<string> {
  const env = options.env ?? process.env
  const explicit = env[`PORTEAU_${name.toUpperCase()}`] ?? options.configPath
  if (explicit !== undefined) {
    const path = resolve(options.cwd ?? process.cwd(), explicit)
    if (!(await executable(path))) throw new Error(`Configured ${name} is not executable: ${path}`)
    return path
  }

  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, name)
    if (await executable(candidate)) return candidate
  }
  throw new Error(`Unable to find ${name} on PATH`)
}

export function parseToolVersion(name: ToolName, output: string): string {
  const match = new RegExp(
    `^${name} v(\\d+\\.\\d+\\.\\d+-\\d+), built against [^\\r\\n]+(?: with SSL support)?\\r?\\n?$`,
  ).exec(output)
  if (!match?.[1]) throw new Error(`Unrecognized ${name} version output`)
  return match[1]
}

export async function inspectTool(
  name: ToolName,
  path: string,
  env?: NodeJS.ProcessEnv,
): Promise<InspectedTool> {
  if (!isAbsolute(path)) throw new Error(`${name} path must be absolute`)
  const { stdout, stderr } = await execFileAsync(path, ['--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    ...(env ? { env } : {}),
  })
  if (stderr !== '') throw new Error(`${name} wrote unexpected version diagnostics`)
  const version = parseToolVersion(name, stdout)
  if (!compatibilityManifest.engine.tools[name].acceptedVersions.includes(version)) {
    throw new Error(`Unsupported ${name} version: ${version}`)
  }
  return { name, path, version }
}

export function assertMatchingToolVersions(mydumper: InspectedTool, myloader: InspectedTool): void {
  if (mydumper.version !== myloader.version) {
    throw new Error(`Tool versions do not match: ${mydumper.version} and ${myloader.version}`)
  }
}
