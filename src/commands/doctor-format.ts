import { dirname, resolve } from 'node:path'
import { loadConfig } from '../core/config.js'
import {
  runDiagnostics,
  type DiagnosticsOptions,
  type DiagnosticsResult,
  type DiagnosticStatus,
} from '../setup/diagnostics.js'

export interface DiagnosticCommandOptions {
  readonly configFile?: string
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly signal?: AbortSignal
  readonly diagnostics?: DiagnosticsOptions
  readonly diagnose?: typeof runDiagnostics
}

export async function collectDiagnostics(
  options: DiagnosticCommandOptions = {},
): Promise<DiagnosticsResult> {
  const cwd = options.cwd ?? process.cwd()
  const configFile = options.configFile ? resolve(cwd, options.configFile) : undefined
  const config = await loadConfig({
    ...(configFile ? { configFile } : {}),
    cwd,
    ...(options.env ? { env: options.env } : {}),
  })
  const configPaths = {
    ...(config.tools.mydumper ? { mydumper: config.tools.mydumper } : {}),
    ...(config.tools.myloader ? { myloader: config.tools.myloader } : {}),
  }
  return (options.diagnose ?? runDiagnostics)({
    ...options.diagnostics,
    cwd: configFile ? dirname(configFile) : (options.diagnostics?.cwd ?? cwd),
    configPaths,
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

function marker(status: DiagnosticStatus): string {
  return status === 'ok' ? 'ok' : status === 'warning' ? 'warn' : 'error'
}

export function formatDiagnostics(result: DiagnosticsResult): string[] {
  const { system, node, tools, toolPair } = result
  const systemDetails = [system.name, system.codename, system.architecture]
    .filter(Boolean)
    .join(', ')
  const lines = [
    'Porteau diagnostics (read-only)',
    `[${marker(system.status)}] System: ${systemDetails}`,
    `[${marker(node.status)}] Node.js: ${node.version} (minimum ${node.minimumVersion})`,
  ]
  for (const name of ['mydumper', 'myloader'] as const) {
    const tool = tools[name]
    const details = tool.path
      ? `${tool.version ?? 'version unavailable'} at ${tool.path} (${tool.source})`
      : 'not available'
    lines.push(`[${marker(tool.status)}] ${name}: ${details}`)
    if (tool.correction) lines.push(`  Fix: ${tool.correction}`)
  }
  lines.push(
    `[${marker(toolPair.status)}] Tool pair: ${toolPair.status === 'ok' ? 'compatible and matching' : 'not ready'}`,
  )
  if (system.correction) lines.push(`  System note: ${system.correction}`)
  if (node.correction) lines.push(`  Fix: ${node.correction}`)
  if (toolPair.correction) lines.push(`  Fix: ${toolPair.correction}`)
  lines.push(result.ok ? 'Diagnostics passed.' : 'Diagnostics found blocking dependency issues.')
  return lines
}
